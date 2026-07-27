import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../_lib/auth.js';

function isEmptyFilters(filters: unknown): boolean {
  if (filters == null) return true;
  if (typeof filters !== 'object') return true;
  return Object.keys(filters as Record<string, unknown>).length === 0;
}

function mergePresence(
  summary: Record<string, unknown>,
  cache: Record<string, unknown> | null | undefined,
) {
  if (!cache) return summary;
  return {
    ...summary,
    avg_nearby_yard_sign_miles: cache.avg_nearby_yard_sign_miles ?? null,
    avg_nearby_volunteer_miles: cache.avg_nearby_volunteer_miles ?? null,
    avg_nearby_sample_size: cache.avg_nearby_sample_size ?? null,
    avg_nearby_scope: cache.avg_nearby_scope ?? null,
    avg_nearby_computed_at: cache.avg_nearby_computed_at ?? null,
    universe_total: cache.universe_total ?? summary.universe_total ?? null,
    analytics_from_cache: summary.analytics_from_cache ?? false,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{ filters?: unknown }>(req);
  const filters = body.filters ?? {};
  const empty = isEmptyFilters(filters);

  const cachePromise = ctx.voter
    .from('campaign_sync_state')
    .select(
      'avg_nearby_yard_sign_miles, avg_nearby_volunteer_miles, avg_nearby_sample_size, avg_nearby_scope, avg_nearby_computed_at, universe_total, analytics_summary_cache, analytics_summary_cached_at',
    )
    .eq('id', 1)
    .maybeSingle();

  // Fast path: unfiltered Analytics from cache (refreshed on campaign sync).
  if (empty) {
    const { data: cache, error: cacheErr } = await cachePromise;
    if (cacheErr) {
      return json(res, 500, { error: cacheErr.message });
    }
    const cached = cache?.analytics_summary_cache;
    if (cached && typeof cached === 'object') {
      return json(
        res,
        200,
        mergePresence(
          {
            ...(cached as Record<string, unknown>),
            analytics_from_cache: true,
            analytics_summary_cached_at: cache?.analytics_summary_cached_at ?? null,
          },
          cache,
        ),
      );
    }
    // Cache miss — compute once and store.
    const { data, error } = await ctx.voter.rpc('voter_analytics_summary', {
      filters: {},
    });
    if (error) return json(res, 500, { error: error.message });
    const summary = (data ?? {}) as Record<string, unknown>;
    await ctx.voter
      .from('campaign_sync_state')
      .update({
        analytics_summary_cache: summary,
        analytics_summary_cached_at: new Date().toISOString(),
        universe_total:
          typeof cache?.universe_total === 'number'
            ? cache.universe_total
            : Number(summary.total) || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1);
    return json(res, 200, mergePresence({ ...summary, analytics_from_cache: false }, cache));
  }

  const [summaryRes, cacheRes] = await Promise.all([
    ctx.voter.rpc('voter_analytics_summary', { filters }),
    cachePromise,
  ]);

  if (summaryRes.error) {
    return json(res, 500, { error: summaryRes.error.message });
  }

  return json(
    res,
    200,
    mergePresence(
      {
        ...((summaryRes.data ?? {}) as Record<string, unknown>),
        analytics_from_cache: false,
      },
      cacheRes.data,
    ),
  );
}
