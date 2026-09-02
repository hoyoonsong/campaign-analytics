import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import {
  isVoterOriginDown,
  VOTER_ORIGIN_TIMEOUT_MESSAGE,
} from '../../_lib/originError.js';

type SnapshotBody = {
  county?: string;
  have_version?: number | null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<SnapshotBody>(req);
  const county = (body.county ?? '').trim();
  if (!county) return json(res, 400, { error: 'county required' });

  const have =
    typeof body.have_version === 'number' && Number.isFinite(body.have_version)
      ? Math.trunc(body.have_version)
      : null;

  if (isVoterOriginDown()) {
    return json(res, 503, { error: VOTER_ORIGIN_TIMEOUT_MESSAGE });
  }

  const { data, error } = await ctx.voter.rpc('voter_map_county_snapshot', {
    p_county: county,
    p_have_version: have,
  });

  if (error) {
    const msg = error.message || 'Map snapshot failed';
    if (/could not find the function|schema cache/i.test(msg)) {
      return json(res, 501, {
        error:
          'Map snapshots are not installed yet. Apply migration 0053 (APPLY_FROM=0053 npm run db:apply-campaign), then restart npm run dev.',
      });
    }
    return json(res, 500, { error: msg });
  }

  const raw =
    typeof data === 'string'
      ? (JSON.parse(data) as Record<string, unknown>)
      : ((data ?? {}) as Record<string, unknown>);

  if (typeof raw.error === 'string') {
    return json(res, 400, { error: raw.error });
  }

  return json(res, 200, raw);
}
