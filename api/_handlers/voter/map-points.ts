import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';

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
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{ filters?: unknown; limit?: number }>(req);

  const [{ data, error }, geoRes] = await Promise.all([
    ctx.voter.rpc('voter_map_points', {
      filters: body.filters ?? {},
      lim: body.limit ?? 5000,
    }),
    fetchAllCampaignGeo(ctx.voter),
  ]);

  if (error) return json(res, 500, { error: error.message });

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
