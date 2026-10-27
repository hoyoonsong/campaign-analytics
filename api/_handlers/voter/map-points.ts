import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { campaignAdminClient } from '../../_lib/campaign.js';
import {
  isVoterOriginDown,
  VOTER_ORIGIN_TIMEOUT_MESSAGE,
} from '../../_lib/originError.js';
import { recallCampaignGeo, rememberCampaignGeo } from '../../_lib/voterMemCache.js';

type GeoKind = 'volunteer' | 'yard_sign';

type CampaignGeoPoint = {
  source_id: string;
  kind: GeoKind;
  lat: number;
  lng: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  is_big?: boolean;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{ filters?: unknown; limit?: number; geo_only?: boolean }>(
    req,
  );

  if (body.geo_only) {
    const cached = recallCampaignGeo({ allowStale: isVoterOriginDown() });
    if (cached?.length) {
      return json(res, 200, { points: [], campaign_geo: cached, truncated: false });
    }
    if (isVoterOriginDown()) {
      return json(res, 200, { points: [], campaign_geo: [], truncated: false });
    }
    const campaign_geo = await attachYardSignSize(await fetchAllCampaignGeo(ctx.voter));
    rememberCampaignGeo(campaign_geo);
    return json(res, 200, { points: [], campaign_geo, truncated: false });
  }

  if (isVoterOriginDown()) {
    const cached = recallCampaignGeo({ allowStale: true });
    if (cached?.length) {
      return json(res, 200, {
        points: [],
        campaign_geo: cached,
        truncated: false,
      });
    }
    return json(res, 503, { error: VOTER_ORIGIN_TIMEOUT_MESSAGE });
  }

  const cachedGeo = recallCampaignGeo();
  const [{ data, error }, geoRes] = await Promise.all([
    ctx.voter.rpc('voter_map_points', {
      filters: body.filters ?? {},
      lim: body.limit ?? 2500,
    }),
    cachedGeo?.length
      ? Promise.resolve(cachedGeo as CampaignGeoPoint[])
      : attachYardSignSize(await fetchAllCampaignGeo(ctx.voter)),
  ]);

  if (error) return json(res, 500, { error: error.message });

  if (!cachedGeo?.length && geoRes.length) rememberCampaignGeo(geoRes);

  return json(res, 200, {
    ...(data as Record<string, unknown>),
    campaign_geo: geoRes,
  });
}

/** Page through every volunteer/yard-sign pin — never apply the voter pin cap. */
async function fetchAllCampaignGeo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  voter: { from: (t: string) => any },
): Promise<CampaignGeoPoint[]> {
  const pageSize = 1000;
  const out: CampaignGeoPoint[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await voter
      .from('campaign_geo_points')
      .select('source_id, kind, lat, lng, name, email, phone, address')
      .in('kind', ['volunteer', 'yard_sign'])
      .not('lat', 'is', null)
      .not('lng', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[map-points] campaign_geo failed', error.message);
      break;
    }
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    for (const g of batch) {
      if (
        (g.kind === 'volunteer' || g.kind === 'yard_sign') &&
        typeof g.source_id === 'string' &&
        typeof g.lat === 'number' &&
        typeof g.lng === 'number'
      ) {
        out.push({
          source_id: g.source_id,
          kind: g.kind,
          lat: g.lat,
          lng: g.lng,
          name: (g.name as string | null) ?? null,
          email: (g.email as string | null) ?? null,
          phone: (g.phone as string | null) ?? null,
          address: (g.address as string | null) ?? null,
        });
      }
    }
    if (batch.length < pageSize) break;
  }
  return out;
}

/** Mark yard-sign pins that FormHandler stored as big. */
async function attachYardSignSize(points: CampaignGeoPoint[]): Promise<CampaignGeoPoint[]> {
  const yardIds = points.filter((point) => point.kind === 'yard_sign').map((point) => point.source_id);
  if (yardIds.length === 0) return points;
  try {
    const campaign = campaignAdminClient();
    const big = new Set<string>();
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await campaign
        .from('yard_signs')
        .select('id, is_big')
        .eq('is_big', true)
        .range(from, from + pageSize - 1);
      if (error) break;
      const rows = data ?? [];
      for (const row of rows) {
        if (typeof row.id === 'string') big.add(row.id);
      }
      if (rows.length < pageSize) break;
    }
    if (big.size === 0) return points;
    return points.map((point) =>
      point.kind === 'yard_sign' && big.has(point.source_id)
        ? { ...point, is_big: true }
        : point,
    );
  } catch {
    return points;
  }
}
