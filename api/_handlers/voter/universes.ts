import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { withTagMeta } from '../../_lib/enrichSearch.js';

async function recomputeTags(voter: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (fn: string) => PromiseLike<{ error: any }>;
}) {
  const { error } = await voter.rpc('recompute_supporter_tags');
  if (error) {
    // Columns/RPC may not exist until migrations are applied — enrichment covers Search.
    // eslint-disable-next-line no-console
    console.warn('[universes] recompute_supporter_tags:', error.message);
  }
}

/** Do not block Save on a full-file tag rewrite. */
function kickRecompute(voter: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (fn: string) => PromiseLike<{ error: any }>;
}) {
  void recomputeTags(voter);
}

function readTagFields(body: {
  supporter_tag?: string | null;
  tag_priority?: number | null;
  filters?: Record<string, unknown>;
}) {
  const tag =
    body.supporter_tag != null
      ? String(body.supporter_tag).trim()
      : typeof body.filters?._supporter_tag === 'string'
        ? String(body.filters._supporter_tag).trim()
        : '';
  const priority = Number.isFinite(Number(body.tag_priority))
    ? Number(body.tag_priority)
    : typeof body.filters?._tag_priority === 'number'
      ? Number(body.filters._tag_priority)
      : 0;
  return { tag, priority };
}

/** Normalize API universe row so UI always sees supporter_tag even if column missing. */
function normalizeUniverse(row: Record<string, unknown>) {
  const filters = (row.filters ?? {}) as Record<string, unknown>;
  const tagFromFilters =
    typeof filters._supporter_tag === 'string'
      ? String(filters._supporter_tag)
      : null;
  const sourceFromFilters =
    typeof filters._source === 'string' ? String(filters._source) : null;
  return {
    ...row,
    supporter_tag:
      (typeof row.supporter_tag === 'string' && row.supporter_tag) ||
      tagFromFilters,
    tag_priority:
      (typeof row.tag_priority === 'number' ? row.tag_priority : null) ??
      (typeof filters._tag_priority === 'number'
        ? Number(filters._tag_priority)
        : 0),
    source:
      (typeof row.source === 'string' && row.source) || sourceFromFilters,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const { data, error } = await ctx.voter
      .from('saved_voter_universes')
      .select('*')
      .eq('created_by', ctx.user.id)
      .order('updated_at', { ascending: false });
    if (error) return json(res, 500, { error: error.message });
    return json(res, 200, {
      universes: (data ?? []).map((r) =>
        normalizeUniverse(r as Record<string, unknown>),
      ),
    });
  }

  if (req.method === 'POST') {
    const body = readBody<{
      action?: string;
      name?: string;
      filters?: Record<string, unknown>;
      supporter_tag?: string | null;
      tag_priority?: number | null;
      source?: string | null;
      skip_recompute?: boolean;
    }>(req);
    if (body.action === 'recompute_tags') {
      await recomputeTags(ctx.voter);
      return json(res, 200, { ok: true });
    }
    const name = (body.name ?? '').trim();
    if (!name) return json(res, 400, { error: 'name is required' });

    const { tag, priority } = readTagFields(body);
    const source = (body.source ?? '').trim() || null;
    const filters = withTagMeta(body.filters ?? {}, tag || null, priority, source);

    // Prefer columns when migration applied; always embed tag meta in filters jsonb.
    const fullInsert = {
      name,
      filters,
      created_by: ctx.user.id,
      supporter_tag: tag || null,
      tag_priority: priority,
      source,
    };

    let { data, error } = await ctx.voter
      .from('saved_voter_universes')
      .insert(fullInsert)
      .select('*')
      .single();

    if (error && /supporter_tag|tag_priority|\bsource\b/i.test(error.message)) {
      const fallback = await ctx.voter
        .from('saved_voter_universes')
        .insert({
          name,
          filters,
          created_by: ctx.user.id,
        })
        .select('*')
        .single();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) return json(res, 500, { error: error.message });
    if (tag && !body.skip_recompute) kickRecompute(ctx.voter);
    return json(res, 200, {
      universe: normalizeUniverse(data as Record<string, unknown>),
    });
  }

  if (req.method === 'PATCH') {
    const body = readBody<{
      id?: string;
      name?: string;
      filters?: Record<string, unknown>;
      supporter_tag?: string | null;
      tag_priority?: number | null;
      source?: string | null;
      skip_recompute?: boolean;
    }>(req);
    const id = (body.id ?? '').trim();
    if (!id) return json(res, 400, { error: 'id is required' });

    const { data: existing } = await ctx.voter
      .from('saved_voter_universes')
      .select('*')
      .eq('id', id)
      .eq('created_by', ctx.user.id)
      .maybeSingle();
    if (!existing) return json(res, 404, { error: 'Not found' });

    const existingFilters = (existing.filters ?? {}) as Record<string, unknown>;
    const { tag, priority } = readTagFields({
      supporter_tag:
        body.supporter_tag !== undefined
          ? body.supporter_tag
          : (existing.supporter_tag as string | null) ??
            (existingFilters._supporter_tag as string | null),
      tag_priority:
        body.tag_priority !== undefined
          ? body.tag_priority
          : (existing.tag_priority as number | null) ??
            (existingFilters._tag_priority as number | null),
      filters: body.filters ?? existingFilters,
    });

    const baseFilters = body.filters ?? existingFilters;
    const source =
      body.source !== undefined
        ? String(body.source ?? '').trim() || null
        : (typeof existing.source === 'string' && existing.source) ||
          (typeof existingFilters._source === 'string'
            ? String(existingFilters._source)
            : null);
    const filters = withTagMeta(baseFilters, tag || null, priority, source);

    const patchFull: Record<string, unknown> = { filters };
    if (body.name != null) patchFull.name = String(body.name).trim();
    patchFull.supporter_tag = tag || null;
    patchFull.tag_priority = priority;
    patchFull.source = source;

    let { data, error } = await ctx.voter
      .from('saved_voter_universes')
      .update(patchFull)
      .eq('id', id)
      .eq('created_by', ctx.user.id)
      .select('*')
      .maybeSingle();

    if (error && /supporter_tag|tag_priority|\bsource\b/i.test(error.message)) {
      const patchLean: Record<string, unknown> = { filters };
      if (body.name != null) patchLean.name = String(body.name).trim();
      const fallback = await ctx.voter
        .from('saved_voter_universes')
        .update(patchLean)
        .eq('id', id)
        .eq('created_by', ctx.user.id)
        .select('*')
        .maybeSingle();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) return json(res, 500, { error: error.message });
    if (!data) return json(res, 404, { error: 'Not found' });
    if (!body.skip_recompute) kickRecompute(ctx.voter);
    return json(res, 200, {
      universe: normalizeUniverse(data as Record<string, unknown>),
    });
  }

  if (req.method === 'DELETE') {
    const body = readBody<{ id?: string }>(req);
    const id = (body.id ?? '').trim();
    if (!id) return json(res, 400, { error: 'id is required' });

    const { error } = await ctx.voter
      .from('saved_voter_universes')
      .delete()
      .eq('id', id)
      .eq('created_by', ctx.user.id);

    if (error) return json(res, 500, { error: error.message });
    kickRecompute(ctx.voter);
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
}
