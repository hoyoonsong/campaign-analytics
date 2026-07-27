import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { buildLeanSyncPayload, campaignAdminClient } from '../../_lib/campaign.js';
import { enrichSearchRows } from '../../_lib/enrichSearch.js';

/** Populate lean geo pins from FormHandler when nearby filters need them. */
async function ensureLeanGeo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  voter: { from: (t: string) => any; rpc: (fn: string, args?: object) => any },
) {
  const { count, error } = await voter
    .from('campaign_geo_points')
    .select('*', { count: 'exact', head: true });
  if (error) {
    // eslint-disable-next-line no-console
    console.warn('[search] geo count failed', error.message);
    return;
  }
  if ((count ?? 0) > 0) return;

  try {
    const campaign = campaignAdminClient();
    const payload = await buildLeanSyncPayload(campaign);
    if (!payload.geo.length) return;
    const { error: syncErr } = await voter.rpc('replace_campaign_geo', {
      p_geo: payload.geo,
    });
    if (syncErr) {
      // eslint-disable-next-line no-console
      console.warn('[search] replace_campaign_geo failed', syncErr.message);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[search] ensureLeanGeo failed',
      err instanceof Error ? err.message : err,
    );
  }
}

/** Materialize supporter/maybe/opposed onto voters.supporter_tag when empty. */
async function ensureSupporterTags(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  voter: { from: (t: string) => any; rpc: (fn: string, args?: object) => any },
) {
  const { count, error } = await voter
    .from('voters')
    .select('*', { count: 'exact', head: true })
    .not('supporter_tag', 'is', null);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn('[search] tag count failed', error.message);
    return;
  }
  if ((count ?? 0) > 0) return;

  const { error: tagErr } = await voter.rpc('recompute_supporter_tags');
  if (tagErr) {
    // eslint-disable-next-line no-console
    console.warn('[search] recompute_supporter_tags failed', tagErr.message);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{
    filters?: Record<string, unknown>;
    q?: string;
    page?: number;
    page_size?: number;
  }>(req);

  const filters = { ...(body.filters ?? {}) };
  const needsNearby =
    Number(filters.nearby_yard_sign_miles) > 0 ||
    Number(filters.nearby_volunteer_miles) > 0 ||
    Number(filters.nearby_yard_sign_min_miles) > 0 ||
    Number(filters.nearby_yard_sign_max_miles) > 0 ||
    Number(filters.nearby_volunteer_min_miles) > 0 ||
    Number(filters.nearby_volunteer_max_miles) > 0;
  const needsTags = Array.isArray(filters.supporter_tag)
    ? filters.supporter_tag.length > 0
    : false;

  if (needsNearby) {
    await ensureLeanGeo(ctx.voter);
  }
  if (needsTags) {
    await ensureSupporterTags(ctx.voter);
  }

  const { data, error } = await ctx.voter.rpc('voter_search', {
    filters,
    q: body.q ?? '',
    page: body.page ?? 1,
    page_size: body.page_size ?? 50,
  });

  if (error) return json(res, 500, { error: error.message });

  const payload = (data ?? {}) as {
    rows?: Array<Record<string, unknown>>;
    total?: number;
    page?: number;
    page_size?: number;
  };

  try {
    const rows = await enrichSearchRows(ctx.voter, payload.rows ?? []);
    return json(res, 200, { ...payload, rows });
  } catch (err) {
    // Enrichment is best-effort; never fail the search itself.
    // eslint-disable-next-line no-console
    console.warn(
      '[search] enrich failed',
      err instanceof Error ? err.message : err,
    );
    return json(res, 200, data);
  }
}
