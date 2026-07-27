import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../_lib/auth';

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
    ctx.voter
      .from('campaign_geo_points')
      .select('source_id, kind, lat, lng, name, email, phone, address')
      .in('kind', ['volunteer', 'yard_sign'])
      .not('lat', 'is', null)
      .not('lng', 'is', null)
      .limit(5000),
  ]);

  if (error) return json(res, 500, { error: error.message });

  if (geoRes.error) {
    console.warn('[map-points] campaign_geo failed', geoRes.error.message);
  }

  const campaign_geo: CampaignGeoPoint[] = (geoRes.data ?? [])
    .filter(
      (g): g is CampaignGeoPoint =>
        (g.kind === 'volunteer' || g.kind === 'yard_sign') &&
        typeof g.source_id === 'string' &&
        typeof g.lat === 'number' &&
        typeof g.lng === 'number',
    )
    .map((g) => ({
      source_id: g.source_id,
      kind: g.kind as GeoKind,
      lat: g.lat,
      lng: g.lng,
      name: g.name ?? null,
      email: g.email ?? null,
      phone: g.phone ?? null,
      address: g.address ?? null,
    }));

  return json(res, 200, {
    ...(data as Record<string, unknown>),
    campaign_geo,
  });
}
