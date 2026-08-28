import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { isVoterOriginDown, isVoterOriginTimeout } from '../../_lib/originError.js';
import { recallAnalytics, rememberAnalytics } from '../../_lib/voterMemCache.js';

function isEmptyFilters(filters: unknown): boolean {
  if (filters == null) return true;
  if (typeof filters !== 'object') return true;
  const keys = Object.keys(filters as Record<string, unknown>).filter(
    (k) => k !== 'petitions',
  );
  return keys.length === 0;
}

function asCacheObj(cached: unknown): Record<string, unknown> | null {
  if (!cached || typeof cached !== 'object') return null;
  const obj = cached as Record<string, unknown>;
  if (!Array.isArray(obj.petition_combos)) return null;
  return obj;
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

function serveCached(
  cacheRow: Record<string, unknown> | null | undefined,
  cachedObj: Record<string, unknown>,
) {
  const payload = mergePresence(
    {
      ...cachedObj,
      analytics_from_cache: true,
      analytics_summary_cached_at: cacheRow?.analytics_summary_cached_at ?? null,
    },
    cacheRow,
  );
  rememberAnalytics(payload);
  return payload;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = req.method === 'GET' ? {} : readBody<{ filters?: unknown }>(req);
  const filters = body.filters ?? {};
  const empty = req.method === 'GET' || isEmptyFilters(filters);

  const mem = recallAnalytics();

  // Empty dashboard: one row from campaign_sync_state. Do not count petitions
  // or run voter_analytics_summary — those are what take the origin down.
  if (empty) {
    if (isVoterOriginDown() && mem) {
      return json(res, 200, mem);
    }
    const { data: cache, error: cacheErr } = await ctx.voter
      .from('campaign_sync_state')
      .select(
        'avg_nearby_yard_sign_miles, avg_nearby_volunteer_miles, avg_nearby_sample_size, avg_nearby_scope, avg_nearby_computed_at, universe_total, analytics_summary_cache, analytics_summary_cached_at',
      )
      .eq('id', 1)
      .maybeSingle();

    if (cacheErr) {
      if (mem) return json(res, 200, mem);
      return json(res, 503, { error: cacheErr.message });
    }

    const cachedObj = asCacheObj(cache?.analytics_summary_cache);
    if (cachedObj) {
      return json(res, 200, serveCached(cache as Record<string, unknown>, cachedObj));
    }
    if (mem) return json(res, 200, mem);

    if (isVoterOriginDown()) {
      return json(res, 503, { error: 'Voter database timed out' });
    }

    const { data, error } = await ctx.voter.rpc('voter_analytics_summary', {
      filters: {},
    });
    if (error) {
      return json(res, 503, { error: error.message });
    }
    const summary = (data ?? {}) as Record<string, unknown>;
    rememberAnalytics(summary);
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
    return json(
      res,
      200,
      mergePresence({ ...summary, analytics_from_cache: false }, cache),
    );
  }

  if (isVoterOriginDown()) {
    return json(res, 503, { error: 'Voter database timed out' });
  }

  const [summaryRes, cacheRes] = await Promise.all([
    ctx.voter.rpc('voter_analytics_summary', { filters }),
    ctx.voter
      .from('campaign_sync_state')
      .select(
        'avg_nearby_yard_sign_miles, avg_nearby_volunteer_miles, avg_nearby_sample_size, avg_nearby_scope, avg_nearby_computed_at, universe_total',
      )
      .eq('id', 1)
      .maybeSingle(),
  ]);

  if (summaryRes.error) {
    const msg = summaryRes.error.message;
    return json(res, isVoterOriginTimeout(msg) ? 503 : 500, { error: msg });
  }

  return json(
    res,
    200,
    mergePresence(
      {
        ...((summaryRes.data ?? {}) as Record<string, unknown>),
        analytics_from_cache: false,
      },
      cacheRes.data as Record<string, unknown> | null,
    ),
  );
}
