import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { buildLeanSyncPayload, campaignAdminClient } from '../../_lib/campaign.js';
import { enrichSearchRows } from '../../_lib/enrichSearch.js';
import { logActivityServer } from '../../_lib/log.js';
import { isVoterOriginDown } from '../../_lib/originError.js';

/** Populate lean geo pins from FormHandler when nearby filters need them. */
async function ensureLeanGeo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  voter: { from: (t: string) => any; rpc: (fn: string, args?: object) => any },
) {
  if (isVoterOriginDown()) return;
  const { data, error } = await voter
    .from('campaign_geo_points')
    .select('source_id')
    .limit(1);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn('[export] geo probe failed', error.message);
    return;
  }
  if (data?.length) return;

  try {
    const campaign = campaignAdminClient();
    const payload = await buildLeanSyncPayload(campaign);
    if (!payload.geo.length) return;
    const { error: syncErr } = await voter.rpc('replace_campaign_geo', {
      p_geo: payload.geo,
    });
    if (syncErr) {
      // eslint-disable-next-line no-console
      console.warn('[export] replace_campaign_geo failed', syncErr.message);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[export] ensureLeanGeo failed',
      err instanceof Error ? err.message : err,
    );
  }
}

const MAX_PAGE = 400;
const MAX_ROWS = 20_000;

let exportBusyUntil = 0;

function filtersAreEmpty(filters: Record<string, unknown>): boolean {
  const keys = Object.keys(filters).filter((k) => k !== 'petitions');
  return keys.length === 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  if (Date.now() < exportBusyUntil) {
    return json(res, 429, {
      error: 'Another export is running. Wait a few seconds and try again.',
    });
  }
  exportBusyUntil = Date.now() + 45_000;

  try {
    const body = readBody<{
      filters?: Record<string, unknown>;
      after_id?: number | null;
      limit?: number;
      exported_so_far?: number;
    }>(req);

    const filters = { ...(body.filters ?? {}) };
    const empty = filtersAreEmpty(filters);
    const afterId = body.after_id ?? null;
    const already = Math.max(0, Number(body.exported_so_far) || 0);

    if (empty && ctx.profile.role !== 'admin') {
      return json(res, 403, {
        error:
          'Filter the list before exporting. Full-file downloads take the voter database down.',
      });
    }
    if (already >= MAX_ROWS) {
      return json(res, 200, { rows: [], next_cursor: null, truncated: true });
    }

    const needsNearby =
      Number(filters.nearby_yard_sign_miles) > 0 ||
      Number(filters.nearby_volunteer_miles) > 0 ||
      Number(filters.nearby_yard_sign_min_miles) > 0 ||
      Number(filters.nearby_yard_sign_max_miles) > 0 ||
      Number(filters.nearby_volunteer_min_miles) > 0 ||
      Number(filters.nearby_volunteer_max_miles) > 0;

    if (needsNearby) {
      await ensureLeanGeo(ctx.voter);
    }
    if (filters.possible_duplicates === true) {
      const { error: dupErr } = await ctx.voter.rpc('ensure_possible_duplicates');
      if (dupErr && !/does not exist|schema cache/i.test(dupErr.message)) {
        return json(res, 500, { error: dupErr.message });
      }
    }

    const lim = Math.min(
      MAX_PAGE,
      Math.max(1, Number(body.limit) || MAX_PAGE),
      MAX_ROWS - already,
    );

    if (!afterId) {
      await logActivityServer(ctx, {
        action: 'export',
        entityType: 'voter',
        metadata: {
          label: empty ? 'CSV export start (unfiltered)' : 'CSV export start',
          empty,
          page_size: lim,
        },
        source: 'app',
      });
    }

    const { data, error } = await ctx.voter.rpc('voter_export_page', {
      filters,
      after_id: afterId,
      lim,
    });

    if (error) return json(res, 500, { error: error.message });

    const payload = (data ?? {}) as {
      rows?: Array<Record<string, unknown>>;
      next_cursor?: number | null;
    };
    const rowCount = payload.rows?.length ?? 0;
    const truncated = already + rowCount >= MAX_ROWS;
    const nextCursor = truncated ? null : payload.next_cursor ?? null;

    try {
      const rows = await enrichSearchRows(ctx.voter, payload.rows ?? []);
      return json(res, 200, {
        ...payload,
        rows,
        next_cursor: nextCursor,
        truncated,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[export] enrich failed',
        err instanceof Error ? err.message : err,
      );
      return json(res, 200, { ...payload, next_cursor: nextCursor, truncated });
    }
  } finally {
    exportBusyUntil = Date.now() + 400;
  }
}
