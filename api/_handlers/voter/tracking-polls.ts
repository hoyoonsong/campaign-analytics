import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { logActivityServer } from '../../_lib/log.js';
import {
  decideMatch,
  indexVoters,
  normalizeEmail,
  normalizePhone10,
  normalizePollAnswer,
  normalizeProfileId,
  personKeyFor,
  type VoterHit,
} from '../../_lib/trackingPoll.js';

function isAdmin(role: string) {
  return role === 'admin';
}

type ParsedRow = {
  uid: string;
  source_name: string | null;
  source_phone: string | null;
  source_email: string | null;
  source_profile_id: string | null;
  source_party?: string | null;
  source_gender?: string | null;
  raw_answer: string | null;
  answered_at: string | null;
};

type ExistingResponse = {
  id: number;
  voter_id: number | null;
  person_key: string;
  normalized_answer: string;
  raw_answer: string | null;
};

const DASH_COLS = 'id, poll_id, person_key, normalized_answer, voter_id';

function voterDisplayName(v: {
  first_name?: string | null;
  last_name?: string | null;
}): string | null {
  const n = [v.first_name, v.last_name].filter(Boolean).join(' ').trim();
  return n || null;
}

async function fetchAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: string | null }> {
  const page = 1000;
  const out: T[] = [];
  const first = await query(0, page - 1);
  if (first.error) return { data: [], error: first.error.message };
  out.push(...(first.data ?? []));
  if (out.length < page) return { data: out, error: null };

  let from = page;
  while (true) {
    const wave = await Promise.all(
      [0, 1, 2, 3].map((i) => query(from + i * page, from + (i + 1) * page - 1)),
    );
    for (const { data, error } of wave) {
      if (error) return { data: out, error: error.message };
      const rows = data ?? [];
      out.push(...rows);
      if (rows.length < page) return { data: out, error: null };
    }
    from += page * 4;
  }
}

async function lookupVoters(
  voter: SupabaseClient,
  rows: ParsedRow[],
): Promise<{ voters: VoterHit[]; error: string | null }> {
  const profileIds = [
    ...new Set(rows.map((r) => normalizeProfileId(r.source_profile_id)).filter((v): v is string => Boolean(v))),
  ];
  const phones = [
    ...new Set(rows.map((r) => normalizePhone10(r.source_phone)).filter((v): v is string => Boolean(v))),
  ];
  const emails = [
    ...new Set(rows.map((r) => normalizeEmail(r.source_email)).filter((v): v is string => Boolean(v))),
  ];
  if (!profileIds.length && !phones.length && !emails.length) {
    return { voters: [], error: null };
  }

  const chunk = <T,>(arr: T[], size: number) => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  const found: VoterHit[] = [];
  const seen = new Set<number>();
  const add = (rowsIn: VoterHit[]) => {
    for (const v of rowsIn) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      found.push(v);
    }
  };

  const max = Math.max(profileIds.length, phones.length, emails.length, 1);
  for (let i = 0; i < max; i += 80) {
    const { data, error } = await voter.rpc('lookup_voters_for_poll', {
      p_profile_ids: profileIds.slice(i, i + 80),
      p_phones: phones.slice(i, i + 80),
      p_emails: emails.slice(i, i + 80),
    });
    if (error) {
      if (!/does not exist|schema cache|lookup_voters_for_poll/i.test(error.message)) {
        return { voters: found, error: error.message };
      }
      break;
    }
    add((data as VoterHit[]) ?? []);
    if (i + 80 >= max) return { voters: found, error: null };
  }

  for (const ids of chunk(profileIds, 80)) {
    const { data, error } = await voter
      .from('voters')
      .select('id, murmuration_id, first_name, last_name, email, phone')
      .in('murmuration_id', ids);
    if (error) return { voters: found, error: error.message };
    add(
      ((data as Array<Omit<VoterHit, 'phone10'>>) ?? []).map((v) => ({
        ...v,
        phone10: normalizePhone10(v.phone),
      })),
    );
  }
  for (const ems of chunk(emails, 80)) {
    const { data, error } = await voter
      .from('voters')
      .select('id, murmuration_id, first_name, last_name, email, phone')
      .in('email', ems);
    if (error) return { voters: found, error: error.message };
    add(
      ((data as Array<Omit<VoterHit, 'phone10'>>) ?? []).map((v) => ({
        ...v,
        phone10: normalizePhone10(v.phone),
      })),
    );
  }
  return { voters: found, error: null };
}

async function getOrCreatePoll(
  voter: SupabaseClient,
  pollDate: string,
  actor: string | null,
) {
  const existing = await voter
    .from('tracking_polls')
    .select('id, poll_date, label, created_at')
    .eq('poll_date', pollDate)
    .maybeSingle();
  if (existing.error) return { poll: null, error: existing.error.message };
  if (existing.data) return { poll: existing.data, error: null };

  const inserted = await voter
    .from('tracking_polls')
    .insert({ poll_date: pollDate, created_by: actor })
    .select('id, poll_date, label, created_at')
    .single();
  if (inserted.error) {
    const again = await voter
      .from('tracking_polls')
      .select('id, poll_date, label, created_at')
      .eq('poll_date', pollDate)
      .maybeSingle();
    if (again.data) return { poll: again.data, error: null };
    return { poll: null, error: inserted.error.message };
  }
  return { poll: inserted.data, error: null };
}

function existingForDecision(
  decision: ReturnType<typeof decideMatch>,
  existing: ExistingResponse[],
): ExistingResponse | null {
  if (decision.voter) {
    const byVoter = existing.find((e) => e.voter_id === decision.voter!.id);
    if (byVoter) return byVoter;
  }
  return existing.find((e) => e.person_key === decision.person_key) ?? null;
}

async function buildPreview(
  voter: SupabaseClient,
  body: {
    poll_date: string;
    filename?: string;
    file_hash?: string | null;
    rows: ParsedRow[];
  },
) {
  const pollDate = body.poll_date;
  const rows = body.rows ?? [];
  const looked = await lookupVoters(voter, rows);
  const voters = looked.voters;
  if (looked.error && !/timeout|canceling/i.test(looked.error)) {
    return { error: looked.error, preview: null };
  }

  const { byProfile, byPhone, byEmail } = indexVoters(voters);
  const pollRes = await voter
    .from('tracking_polls')
    .select('id')
    .eq('poll_date', pollDate)
    .maybeSingle();
  if (pollRes.error) return { error: pollRes.error.message, preview: null };

  let existing: ExistingResponse[] = [];
  if (pollRes.data) {
    const ex = await fetchAll<ExistingResponse>((from, to) =>
      voter
        .from('tracking_poll_responses')
        .select('id, voter_id, person_key, normalized_answer, raw_answer')
        .eq('poll_id', pollRes.data!.id)
        .range(from, to),
    );
    if (ex.error && !/timeout|canceling/i.test(ex.error)) {
      return { error: ex.error, preview: null };
    }
    existing = ex.error ? [] : ex.data;
  }

  let hashWarning = false;
  if (body.file_hash) {
    const { data: hashed } = await voter
      .from('tracking_poll_imports')
      .select('id')
      .eq('file_hash', body.file_hash)
      .limit(1);
    hashWarning = Boolean(hashed && hashed.length > 0);
  }

  const seenKeys = new Map<string, { uid: string; answer: string }>();
  const previewRows = rows.map((row) => {
    const normalized = normalizePollAnswer(row.raw_answer);
    const decision = decideMatch(row, byProfile, byPhone, byEmail);
    const prior = existingForDecision(decision, existing);
    const batchDup = seenKeys.get(decision.person_key);
    let issue:
      | 'ready'
      | 'unmatched'
      | 'existing'
      | 'conflict_response'
      | 'conflict_identity'
      | 'invalid' = 'ready';
    let detail: string | null = null;

    if (!row.raw_answer) {
      issue = 'invalid';
      detail = 'Missing poll answer';
    } else if (decision.status === 'invalid') {
      issue = 'invalid';
      detail = decision.reason;
    } else if (decision.status === 'conflict') {
      issue = 'conflict_identity';
      detail = decision.reason;
    } else if (prior || batchDup) {
      const prevAnswer = prior?.normalized_answer ?? batchDup?.answer;
      if (prevAnswer === normalized) {
        issue = 'existing';
        detail = prior ? 'Existing Response' : 'Duplicate row in this file';
      } else {
        issue = 'conflict_response';
        detail = `Response Conflict (existing ${prevAnswer} vs ${normalized})`;
      }
    } else if (decision.status === 'unmatched') {
      issue = 'unmatched';
    }

    if (
      (issue === 'ready' || issue === 'unmatched') &&
      !decision.person_key.startsWith('u:')
    ) {
      seenKeys.set(decision.person_key, { uid: row.uid, answer: normalized });
    }

    return {
      ...row,
      normalized_answer: normalized,
      person_key: decision.person_key,
      match_method: decision.method,
      match_status: decision.match_status,
      voter_id: decision.voter?.id ?? null,
      voter_name: decision.voter ? voterDisplayName(decision.voter) : null,
      issue,
      issue_detail: detail,
      existing_response_id: prior?.id ?? null,
      existing_answer: prior?.normalized_answer ?? null,
    };
  });

  const count = (issue: string) => previewRows.filter((r) => r.issue === issue).length;
  return {
    error: null,
    preview: {
      poll_date: pollDate,
      filename: body.filename ?? '',
      file_hash: body.file_hash ?? null,
      hash_warning: hashWarning,
      csv_rows: rows.length,
      ready: previewRows.filter((r) => r.issue === 'ready' || r.issue === 'unmatched').length,
      matched: previewRows.filter((r) => r.match_status === 'matched' && r.issue !== 'invalid').length,
      unmatched: count('unmatched'),
      existing: count('existing'),
      conflicts: count('conflict_response'),
      identity_conflicts: count('conflict_identity'),
      invalid: count('invalid'),
      rows: previewRows,
    },
  };
}

type DashRow = {
  id?: number;
  poll_id: number;
  poll_date?: string;
  person_key: string;
  normalized_answer: string;
  voter_id?: number | null;
  party?: string | null;
  gender?: string | null;
  voters?: { party?: string | null; contact_tags?: string | null } | null;
};

function mapDashResponses(
  raw: DashRow[],
  dateById: Map<number, string>,
) {
  return raw.map((r) => ({
    id: r.id ?? 0,
    poll_id: r.poll_id,
    poll_date: r.poll_date || dateById.get(r.poll_id) || '',
    import_id: null,
    voter_id: r.voter_id ?? null,
    person_key: r.person_key,
    match_method: 'unmatched',
    match_status: r.voter_id ? 'matched' : 'unmatched',
    source_profile_id: null,
    source_phone: null,
    source_email: null,
    source_name: null,
    raw_answer: null,
    normalized_answer: r.normalized_answer,
    answered_at: null,
    display_name: null,
    display_phone: null,
    display_email: null,
    profile_id: null,
    party: r.party ?? r.voters?.party ?? null,
    gender: r.gender ?? r.voters?.contact_tags ?? null,
  }));
}

async function loadDashboardRest(voter: SupabaseClient) {
  const pollsRes = await voter
    .from('tracking_polls')
    .select('id, poll_date, label, created_at')
    .order('poll_date', { ascending: true });
  if (pollsRes.error) return { error: pollsRes.error.message, data: null };

  const dateById = new Map(
    ((pollsRes.data ?? []) as Array<{ id: number; poll_date: string }>).map((p) => [
      p.id,
      p.poll_date,
    ]),
  );

  const nested = await fetchAll<DashRow>((from, to) =>
    voter
      .from('tracking_poll_responses')
      .select(`${DASH_COLS}, voters(party, contact_tags)`)
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (!nested.error) {
    return {
      error: null,
      data: {
        polls: pollsRes.data ?? [],
        imports: [],
        responses: mapDashResponses(nested.data, dateById),
      },
    };
  }

  const rawRes = await fetchAll<DashRow>((from, to) =>
    voter
      .from('tracking_poll_responses')
      .select(DASH_COLS)
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rawRes.error) return { error: rawRes.error, data: null };

  const voterIds = [
    ...new Set(
      rawRes.data
        .map((r) => r.voter_id)
        .filter((id): id is number => typeof id === 'number'),
    ),
  ];
  const byVoter = new Map<number, { party: string | null; contact_tags: string | null }>();
  const chunks: number[][] = [];
  for (let i = 0; i < voterIds.length; i += 400) chunks.push(voterIds.slice(i, i + 400));
  const looked = await Promise.all(
    chunks.map((ids) =>
      voter.from('voters').select('id, party, contact_tags').in('id', ids),
    ),
  );
  for (const { data } of looked) {
    for (const v of (data ?? []) as Array<{
      id: number;
      party: string | null;
      contact_tags: string | null;
    }>) {
      byVoter.set(v.id, v);
    }
  }

  return {
    error: null,
    data: {
      polls: pollsRes.data ?? [],
      imports: [],
      responses: mapDashResponses(
        rawRes.data.map((r) => ({
          ...r,
          party: r.voter_id != null ? byVoter.get(r.voter_id)?.party ?? null : null,
          gender:
            r.voter_id != null ? byVoter.get(r.voter_id)?.contact_tags ?? null : null,
        })),
        dateById,
      ),
    },
  };
}

async function loadDashboard(voter: SupabaseClient) {
  const rpc = await voter.rpc('tracking_poll_dashboard');
  if (!rpc.error && rpc.data && typeof rpc.data === 'object') {
    const payload = rpc.data as {
      polls?: unknown[];
      responses?: DashRow[];
    };
    return {
      error: null,
      data: {
        polls: payload.polls ?? [],
        imports: [],
        responses: mapDashResponses(payload.responses ?? [], new Map()),
      },
    };
  }
  if (
    rpc.error &&
    !/does not exist|schema cache|tracking_poll_dashboard/i.test(rpc.error.message)
  ) {
    return { error: rpc.error.message, data: null };
  }
  return loadDashboardRest(voter);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const loaded = await loadDashboard(ctx.voter);
    if (loaded.error) return json(res, 500, { error: loaded.error });
    return json(res, 200, loaded.data);
  }

  if (req.method === 'POST') {
    const body = readBody<{
      action?: string;
      poll_date?: string;
      filename?: string;
      file_hash?: string | null;
      rows?: ParsedRow[];
      resolutions?: Record<string, 'keep' | 'replace'>;
      q?: string;
    }>(req);
    const action = body.action ?? 'preview';

    if (action === 'lookup') {
      const q = String(body.q ?? '').trim();
      if (!q) return json(res, 200, { voters: [] });
      const phone = normalizePhone10(q);
      const email = normalizeEmail(q);
      const profileId = normalizeProfileId(q);
      const { data, error } = await ctx.voter.rpc('lookup_voters_for_poll', {
        p_profile_ids: profileId ? [profileId] : [],
        p_phones: phone ? [phone] : [],
        p_emails: email ? [email] : [],
      });
      if (!error) {
        let voters = (data as VoterHit[]) ?? [];
        if (voters.length === 0 && !phone && !email) {
          const safe = q.replace(/[%*,()]/g, '').slice(0, 80);
          const nameRes = await ctx.voter
            .from('voters')
            .select('id, murmuration_id, first_name, last_name, email, phone')
            .or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,murmuration_id.eq.${safe}`)
            .limit(20);
          if (nameRes.error) return json(res, 500, { error: nameRes.error.message });
          voters = ((nameRes.data ?? []) as Array<Omit<VoterHit, 'phone10'>>).map((v) => ({
            ...v,
            phone10: normalizePhone10(v.phone),
          }));
        }
        return json(res, 200, { voters });
      }
      return json(res, 500, { error: error.message });
    }

    if (action === 'preview') {
      const pollDate = String(body.poll_date ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pollDate)) {
        return json(res, 400, { error: 'poll_date is required (YYYY-MM-DD)' });
      }
      const built = await buildPreview(ctx.voter, {
        poll_date: pollDate,
        filename: body.filename,
        file_hash: body.file_hash,
        rows: body.rows ?? [],
      });
      if (built.error) return json(res, 500, { error: built.error });
      return json(res, 200, { preview: built.preview });
    }

    if (action === 'confirm') {
      if (!isAdmin(ctx.profile.role)) return json(res, 403, { error: 'Admin only' });
      const pollDate = String(body.poll_date ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pollDate)) {
        return json(res, 400, { error: 'poll_date is required (YYYY-MM-DD)' });
      }
      const built = await buildPreview(ctx.voter, {
        poll_date: pollDate,
        filename: body.filename,
        file_hash: body.file_hash,
        rows: body.rows ?? [],
      });
      if (built.error || !built.preview) return json(res, 500, { error: built.error ?? 'Preview failed' });
      const preview = built.preview;
      const resolutions = body.resolutions ?? {};

      const { poll, error: pollErr } = await getOrCreatePoll(
        ctx.voter,
        pollDate,
        ctx.profile.email ?? ctx.user.email ?? null,
      );
      if (pollErr || !poll) return json(res, 500, { error: pollErr ?? 'Could not create poll' });

      const importRow = await ctx.voter
        .from('tracking_poll_imports')
        .insert({
          poll_id: poll.id,
          filename: body.filename ?? null,
          file_hash: body.file_hash ?? null,
          imported_by: ctx.profile.email ?? ctx.user.email ?? null,
          row_count: preview.csv_rows,
          ready_count: preview.ready,
          matched_count: preview.matched,
          unmatched_count: preview.unmatched,
          duplicate_count: preview.existing,
          conflict_count: preview.conflicts + preview.identity_conflicts,
          invalid_count: preview.invalid,
          imported_count: 0,
        })
        .select('id')
        .single();
      if (importRow.error) return json(res, 500, { error: importRow.error.message });
      const importId = importRow.data.id as string;

      const toInsert: Record<string, unknown>[] = [];
      const toReplace: Array<{ id: number; patch: Record<string, unknown> }> = [];

      for (const row of preview.rows) {
        if (row.issue === 'conflict_response') {
          const choice = resolutions[row.uid] ?? resolutions[String(row.existing_response_id)];
          if (choice === 'replace' && row.existing_response_id) {
            toReplace.push({
              id: row.existing_response_id,
              patch: {
                import_id: importId,
                raw_answer: row.raw_answer,
                normalized_answer: row.normalized_answer,
                answered_at: row.answered_at,
                source_name: row.source_name,
                source_phone: row.source_phone,
                source_email: row.source_email,
                source_profile_id: row.source_profile_id,
              },
            });
          }
          continue;
        }
        if (row.issue !== 'ready' && row.issue !== 'unmatched') continue;
        toInsert.push({
          poll_id: poll.id,
          import_id: importId,
          voter_id: row.voter_id,
          person_key: row.person_key,
          match_method: row.match_method,
          match_status: row.match_status,
          source_profile_id: row.source_profile_id,
          source_phone: row.source_phone,
          source_email: row.source_email,
          source_name: row.source_name,
          raw_answer: row.raw_answer,
          normalized_answer: row.normalized_answer,
          answered_at: row.answered_at,
        });
      }

      let imported = 0;
      for (let i = 0; i < toInsert.length; i += 80) {
        const chunk = toInsert.slice(i, i + 80);
        let lastErr: string | null = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
          const { error } = await ctx.voter.from('tracking_poll_responses').insert(chunk);
          if (!error) {
            imported += chunk.length;
            lastErr = null;
            break;
          }
          lastErr = error.message;
          if (!/timeout|canceling|deadlock/i.test(error.message) || attempt === 4) break;
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
        if (lastErr) {
          await ctx.voter.from('tracking_poll_imports').update({ imported_count: imported }).eq('id', importId);
          return json(res, 500, { error: lastErr, import_id: importId, imported });
        }
      }

      for (const item of toReplace) {
        const { error } = await ctx.voter
          .from('tracking_poll_responses')
          .update(item.patch)
          .eq('id', item.id);
        if (!error) imported += 1;
      }

      await ctx.voter
        .from('tracking_poll_imports')
        .update({ imported_count: imported })
        .eq('id', importId);

      await logActivityServer(ctx, {
        action: 'import',
        entityType: 'tracking_poll',
        entityId: String(poll.id),
        source: 'import',
        metadata: {
          label: body.filename ?? pollDate,
          imported,
          poll_date: pollDate,
        },
      });

      return json(res, 200, {
        ok: true,
        import_id: importId,
        imported,
        existing: preview.existing,
        unmatched: preview.unmatched,
        conflicts: preview.conflicts + preview.identity_conflicts,
        poll,
      });
    }

    return json(res, 400, { error: 'Unknown action' });
  }

  if (req.method === 'PATCH') {
    if (!isAdmin(ctx.profile.role)) return json(res, 403, { error: 'Admin only' });
    const body = readBody<{
      response_id?: number;
      voter_id?: number;
    }>(req);
    const responseId = Number(body.response_id);
    const voterId = Number(body.voter_id);
    if (!responseId || !voterId) {
      return json(res, 400, { error: 'response_id and voter_id are required' });
    }

    const current = await ctx.voter
      .from('tracking_poll_responses')
      .select('id, person_key, poll_id')
      .eq('id', responseId)
      .maybeSingle();
    if (current.error) return json(res, 500, { error: current.error.message });
    if (!current.data) return json(res, 404, { error: 'Response not found' });

    const oldKey = current.data.person_key as string;
    const newKey = personKeyFor({ voterId });
    const { error } = await ctx.voter
      .from('tracking_poll_responses')
      .update({
        voter_id: voterId,
        person_key: newKey,
        match_method: 'manual',
        match_status: 'matched',
      })
      .eq('person_key', oldKey);

    if (error) return json(res, 500, { error: error.message });
    await logActivityServer(ctx, {
      action: 'update',
      entityType: 'tracking_poll_response',
      entityId: String(responseId),
      metadata: { voter_id: voterId, person_key: newKey },
    });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'DELETE') {
    if (!isAdmin(ctx.profile.role)) return json(res, 403, { error: 'Admin only' });
    const body = readBody<{ import_id?: string }>(req);
    const importId = String(body.import_id ?? '').trim();
    if (!importId) return json(res, 400, { error: 'import_id is required' });

    const batch = await ctx.voter
      .from('tracking_poll_imports')
      .select('id, poll_id')
      .eq('id', importId)
      .maybeSingle();
    if (batch.error) return json(res, 500, { error: batch.error.message });
    if (!batch.data) return json(res, 404, { error: 'Import not found' });

    const del = await ctx.voter
      .from('tracking_poll_responses')
      .delete()
      .eq('import_id', importId);
    if (del.error) return json(res, 500, { error: del.error.message });

    const rem = await ctx.voter.from('tracking_poll_imports').delete().eq('id', importId);
    if (rem.error) return json(res, 500, { error: rem.error.message });

    const leftover = await ctx.voter
      .from('tracking_poll_responses')
      .select('id', { count: 'exact', head: true })
      .eq('poll_id', batch.data.poll_id);
    if ((leftover.count ?? 0) === 0) {
      await ctx.voter.from('tracking_polls').delete().eq('id', batch.data.poll_id);
    }

    await logActivityServer(ctx, {
      action: 'delete',
      entityType: 'tracking_poll_import',
      entityId: importId,
      source: 'import',
      metadata: { poll_id: batch.data.poll_id },
    });
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
}
