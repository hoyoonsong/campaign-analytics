import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../_lib/auth.js';
import {
  findNearestCampaignPin,
  loadVoterCoords,
  type NearbyKind,
} from '../_lib/nearestCampaign.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{
    voter_id?: number | string;
    kind?: string;
  }>(req);

  const voterId = Number(body.voter_id);
  const kind = (body.kind ?? '').trim() as NearbyKind;
  if (!Number.isFinite(voterId) || voterId <= 0) {
    return json(res, 400, { error: 'voter_id is required' });
  }
  if (kind !== 'yard_sign' && kind !== 'volunteer') {
    return json(res, 400, { error: 'kind must be yard_sign or volunteer' });
  }

  try {
    const voter = await loadVoterCoords(ctx.voter, voterId, {
      geocodeIfMissing: true,
      persistGeocode: true,
    });
    if (!voter) {
      return json(res, 404, {
        error:
          'No map location for this voter. Need coordinates (or a geocodable street + city/ZIP).',
      });
    }

    const nearest = await findNearestCampaignPin(voter.lat, voter.lng, kind);
    if (!nearest) {
      return json(res, 404, {
        error:
          kind === 'yard_sign'
            ? 'No yard signs with map pins found in FormHandler.'
            : 'No volunteers with map pins found in FormHandler.',
      });
    }

    return json(res, 200, { voter, nearest });
  } catch (err) {
    return json(res, 500, {
      error: err instanceof Error ? err.message : 'Nearby lookup failed',
    });
  }
}
