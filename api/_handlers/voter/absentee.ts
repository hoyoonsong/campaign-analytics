import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { logActivityServer } from '../../_lib/log.js';
import { isVoterOriginDown } from '../../_lib/originError.js';
import { recallAbsentee, rememberAbsentee } from '../../_lib/voterMemCache.js';

function isAdmin(role: string) {
  return role === 'admin';
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}

function unwrapRecord(data: unknown): Record<string, unknown> | null {
  if (data == null) return null;
  if (typeof data === 'string') {
    try {
      return unwrapRecord(JSON.parse(data));
    } catch {
      return null;
    }
  }
  if (typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return null;
}

const ELECTION_COLS =
  'id, slug, label, short_label, bit_index, sort_order, is_default, is_active, group_id, created_at, created_by';
const GROUP_COLS = 'id, slug, label, short_label, sort_order, created_at';

async function insertElection(
  voter: SupabaseClient,
  args: {
    label: string;
    slug?: string | null;
    short_label?: string | null;
    is_default?: boolean;
    actor?: string;
  },
) {
  const slug = slugify(args.slug?.trim() || args.label);
  if (!slug) return { error: 'label is required', election: null };

  const { data: existing, error: existingErr } = await voter
    .from('absentee_elections')
    .select(ELECTION_COLS)
    .eq('slug', slug)
    .maybeSingle();
  if (existingErr) return { error: existingErr.message, election: null };
  if (existing) return { error: null, election: existing };

  const { data: rows, error: listErr } = await voter
    .from('absentee_elections')
    .select('bit_index, sort_order');
  if (listErr) return { error: listErr.message, election: null };
  const list = (rows as Array<{ bit_index: number; sort_order: number }> | null) ?? [];
  const used = new Set(list.map((r) => r.bit_index));
  let bit = 0;
  while (used.has(bit) && bit <= 62) bit += 1;
  if (bit > 62) return { error: 'No free absentee bit_index (max 63)', election: null };
  const maxSort = Math.max(0, ...list.map((r) => r.sort_order ?? 0));
  const short = (args.short_label?.trim() || args.label).slice(0, 16) || slug;

  const { data, error } = await voter
    .from('absentee_elections')
    .insert({
      slug,
      label: args.label,
      short_label: short,
      bit_index: bit,
      sort_order: maxSort + 10,
      is_default: Boolean(args.is_default),
      is_active: true,
      created_by: args.actor ?? null,
    })
    .select(ELECTION_COLS)
    .single();
  if (error) return { error: error.message, election: null };
  return { error: null, election: data };
}

function parseSlugs(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function emptyHeadline() {
  return {
    unique_voters: 0,
    rows: 0,
    requested_not_returned: 0,
    returned: 0,
    accepted: 0,
    rejected: 0,
  };
}

async function loadDashboard(voter: SupabaseClient, slugs: string[]) {
  const [dashRes, comboRes, partyRes] = await Promise.all([
    voter.rpc('absentee_dashboard', {
      p_slugs: slugs.length ? slugs : null,
    }),
    voter.rpc('absentee_combos', {
      p_slugs: slugs.length ? slugs : null,
    }),
    voter.rpc('absentee_mask_party', {
      p_slugs: slugs.length ? slugs : null,
    }),
  ]);
  const { data, error } = dashRes;
  if (!error && data) {
    const payload = unwrapRecord(data) ?? {};
    if (payload.headline && Array.isArray(payload.by_election)) {
      const combos = Array.isArray(comboRes.data) ? comboRes.data : [];
      const mask_party = Array.isArray(partyRes.data) ? partyRes.data : [];
      return attachGroups(voter, {
        elections: payload.elections ?? [],
        headline: payload.headline,
        by_election: payload.by_election,
        by_county: payload.by_county ?? [],
        by_party: payload.by_party ?? [],
        petition_overlap: payload.petition_overlap ?? [],
        combos,
        mask_party,
      });
    }
  }

  const { data: elections, error: elErr } = await voter
    .from('absentee_elections')
    .select(ELECTION_COLS)
    .order('sort_order', { ascending: true })
    .order('slug', { ascending: true });
  if (elErr) throw new Error(elErr.message);

  // Never fall back to an unbounded ballot select — PostgREST caps at 1,000
  // rows and the page then looks like ~200 unique people.
  let rows = 0;
  const countQ = voter
    .from('voter_absentee_ballots')
    .select('voter_id', { count: 'exact', head: true });
  const { count, error: cErr } = slugs.length
    ? await countQ.in(
        'election_id',
        ((elections as Array<{ id: number; slug: string }> | null) ?? [])
          .filter((e) => slugs.includes(e.slug))
          .map((e) => e.id),
      )
    : await countQ;
  if (!cErr) rows = count ?? 0;

  return attachGroups(voter, {
    elections: elections ?? [],
    headline: { ...emptyHeadline(), rows },
    by_election: [],
    by_county: [],
    by_party: [],
    petition_overlap: [],
    combos: [],
    mask_party: [],
  });
}

async function attachGroups(
  voter: SupabaseClient,
  payload: Record<string, unknown>,
) {
  const { data: groups, error: gErr } = await voter
    .from('absentee_election_groups')
    .select(GROUP_COLS)
    .order('sort_order', { ascending: true })
    .order('slug', { ascending: true });
  const { data: rows, error: eErr } = await voter
    .from('absentee_elections')
    .select(ELECTION_COLS)
    .order('sort_order', { ascending: true })
    .order('slug', { ascending: true });
  const byId = new Map(
    ((rows as Array<{ id: number; group_id?: number | null }> | null) ?? []).map((r) => [
      r.id,
      r,
    ]),
  );
  const elections = ((payload.elections as Array<Record<string, unknown>>) ?? []).map((e) => {
    const extra = byId.get(Number(e.id));
    return extra ? { ...e, ...extra } : e;
  });
  return {
    ...payload,
    elections: eErr ? payload.elections : elections,
    groups: gErr ? [] : (groups ?? []),
  };
}

function slugifyGroup(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}

async function createGroup(
  voter: SupabaseClient,
  res: VercelResponse,
  args: { label: string; short_label: string | null; election_ids: number[] },
) {
  const ids = [...new Set(args.election_ids.map((n) => Number(n)).filter((n) => n > 0))];
  if (ids.length < 2) {
    return json(res, 400, { error: 'Select at least two elections to group' });
  }
  let slug = slugifyGroup(args.label);
  if (!slug) return json(res, 400, { error: 'label is required' });
  const { data: existing } = await voter
    .from('absentee_election_groups')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (existing) slug = `${slug}_${Date.now().toString(36)}`.slice(0, 64);
  const { data: sortRows } = await voter.from('absentee_election_groups').select('sort_order');
  const maxSort = Math.max(
    0,
    ...((sortRows as Array<{ sort_order: number }> | null) ?? []).map((r) => r.sort_order ?? 0),
  );
  const short = (args.short_label || args.label).slice(0, 16);
  const { data: group, error } = await voter
    .from('absentee_election_groups')
    .insert({
      slug,
      label: args.label,
      short_label: short,
      sort_order: maxSort + 10,
    })
    .select(GROUP_COLS)
    .single();
  if (error || !group) {
    return json(res, 500, { error: error?.message ?? 'Failed to create group' });
  }
  const { error: assignErr } = await voter
    .from('absentee_elections')
    .update({ group_id: (group as { id: number }).id })
    .in('id', ids);
  if (assignErr) return json(res, 500, { error: assignErr.message });
  await deleteEmptyGroups(voter);
  return json(res, 200, { group });
}

async function deleteEmptyGroups(voter: SupabaseClient) {
  const { data: groups } = await voter.from('absentee_election_groups').select('id');
  const { data: used } = await voter
    .from('absentee_elections')
    .select('group_id')
    .not('group_id', 'is', null);
  const live = new Set(
    ((used as Array<{ group_id: number }> | null) ?? []).map((r) => r.group_id),
  );
  const empty = ((groups as Array<{ id: number }> | null) ?? [])
    .map((g) => g.id)
    .filter((id) => !live.has(id));
  if (empty.length) {
    await voter.from('absentee_election_groups').delete().in('id', empty);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const cached = recallAbsentee();
    if (isVoterOriginDown() && cached) {
      return json(res, 200, cached);
    }
    try {
      const payload = await loadDashboard(ctx.voter, parseSlugs(req.query.slugs));
      rememberAbsentee(payload);
      return json(res, 200, payload);
    } catch (err) {
      if (cached) return json(res, 200, cached);
      return json(res, 503, {
        error: err instanceof Error ? err.message : 'Failed to load absentee data',
      });
    }
  }

  if (req.method === 'POST') {
    const body = readBody<{
      label?: string;
      slug?: string;
      short_label?: string;
      is_default?: boolean;
      kind?: string;
      election_ids?: number[];
      filters?: Record<string, unknown>;
    }>(req);

    if (body.kind === 'count') {
      const { data, error } = await ctx.voter.rpc('absentee_target_count', {
        p_filters: body.filters ?? {},
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[absentee] target count failed', error.message);
        return json(res, 500, { error: error.message });
      }
      return json(res, 200, { count: Number(data) || 0 });
    }

    if (!isAdmin(ctx.profile.role)) {
      return json(res, 403, { error: 'Admin only' });
    }
    const label = String(body.label ?? '').trim();
    if (!label) return json(res, 400, { error: 'label is required' });

    if (body.kind === 'group') {
      return createGroup(ctx.voter, res, {
        label,
        short_label: body.short_label?.trim() || null,
        election_ids: body.election_ids ?? [],
      });
    }

    const { data, error } = await ctx.voter.rpc('create_absentee_election', {
      p_label: label,
      p_slug: body.slug?.trim() || null,
      p_short_label: body.short_label?.trim() || null,
      p_is_default: Boolean(body.is_default),
      p_actor: ctx.user.id,
    });

    const rpcMissing =
      !!error &&
      /does not exist|schema cache|could not find the function/i.test(error.message);

    if (error && !rpcMissing) {
      return json(res, 500, { error: error.message });
    }

    if (!error) {
      const rec = unwrapRecord(data);
      if (rec && typeof rec.error === 'string') {
        return json(res, 400, { error: rec.error });
      }
      if (rec && rec.slug) {
        await logActivityServer(ctx, {
          action: 'create',
          entityType: 'absentee_election',
          entityId: String(rec.id ?? rec.slug),
          metadata: { label, slug: rec.slug },
        });
        return json(res, 200, { election: rec });
      }
    }

    const fallback = await insertElection(ctx.voter, {
      label,
      slug: body.slug?.trim() || null,
      short_label: body.short_label?.trim() || null,
      is_default: Boolean(body.is_default),
      actor: ctx.user.id,
    });
    if (fallback.error || !fallback.election) {
      return json(res, 500, { error: fallback.error ?? 'Failed to create election' });
    }
    await logActivityServer(ctx, {
      action: 'create',
      entityType: 'absentee_election',
      entityId: String((fallback.election as { id?: number }).id ?? label),
      metadata: { label },
    });
    return json(res, 200, { election: fallback.election });
  }

  if (req.method === 'PATCH') {
    if (!isAdmin(ctx.profile.role)) {
      return json(res, 403, { error: 'Admin only' });
    }
    const body = readBody<{
      id?: number;
      kind?: string;
      label?: string;
      short_label?: string;
      sort_order?: number;
      is_default?: boolean;
      is_active?: boolean;
      group_id?: number | null;
    }>(req);
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) {
      return json(res, 400, { error: 'id is required' });
    }

    if (body.kind === 'group') {
      const patch: Record<string, unknown> = {};
      if (typeof body.label === 'string' && body.label.trim()) {
        patch.label = body.label.trim();
      }
      if (typeof body.short_label === 'string' && body.short_label.trim()) {
        patch.short_label = body.short_label.trim();
      }
      if (typeof body.sort_order === 'number') patch.sort_order = body.sort_order;
      if (Object.keys(patch).length === 0) {
        return json(res, 400, { error: 'No fields to update' });
      }
      const { data, error } = await ctx.voter
        .from('absentee_election_groups')
        .update(patch)
        .eq('id', id)
        .select(GROUP_COLS)
        .single();
      if (error) return json(res, 500, { error: error.message });
      return json(res, 200, { group: data });
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.label === 'string' && body.label.trim()) {
      patch.label = body.label.trim();
    }
    if (typeof body.short_label === 'string' && body.short_label.trim()) {
      patch.short_label = body.short_label.trim();
    }
    if (typeof body.sort_order === 'number') patch.sort_order = body.sort_order;
    if (typeof body.is_default === 'boolean') patch.is_default = body.is_default;
    if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
    if (body.group_id === null) patch.group_id = null;
    else if (typeof body.group_id === 'number' && body.group_id > 0) {
      patch.group_id = body.group_id;
    }
    if (Object.keys(patch).length === 0) {
      return json(res, 400, { error: 'No fields to update' });
    }
    const { data, error } = await ctx.voter
      .from('absentee_elections')
      .update(patch)
      .eq('id', id)
      .select(ELECTION_COLS)
      .single();
    if (error) return json(res, 500, { error: error.message });
    if (Object.prototype.hasOwnProperty.call(patch, 'group_id')) {
      await deleteEmptyGroups(ctx.voter);
    }
    return json(res, 200, { election: data });
  }

  if (req.method === 'DELETE') {
    if (!isAdmin(ctx.profile.role)) {
      return json(res, 403, { error: 'Admin only' });
    }
    const body = readBody<{ id?: number; kind?: string }>(req);
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) {
      return json(res, 400, { error: 'id is required' });
    }

    if (body.kind === 'group') {
      await ctx.voter.from('absentee_elections').update({ group_id: null }).eq('group_id', id);
      const { error } = await ctx.voter.from('absentee_election_groups').delete().eq('id', id);
      if (error) return json(res, 500, { error: error.message });
      return json(res, 200, { ok: true });
    }
    const { data, error } = await ctx.voter.rpc('delete_absentee_election', { p_id: id });
    if (error) {
      const rpcMissing = /does not exist|schema cache|could not find the function/i.test(
        error.message,
      );
      if (!rpcMissing) return json(res, 500, { error: error.message });
      await ctx.voter.from('voter_absentee_ballots').delete().eq('election_id', id);
      const { error: delErr } = await ctx.voter.from('absentee_elections').delete().eq('id', id);
      if (delErr) return json(res, 500, { error: delErr.message });
      return json(res, 200, { ok: true });
    }
    const rec = unwrapRecord(data);
    if (rec && typeof rec.error === 'string') {
      return json(res, 400, { error: rec.error });
    }
    await logActivityServer(ctx, {
      action: 'delete',
      entityType: 'absentee_election',
      entityId: String(id),
    });
    return json(res, 200, { ok: true, election: rec });
  }

  return json(res, 405, { error: 'Method not allowed' });
}
