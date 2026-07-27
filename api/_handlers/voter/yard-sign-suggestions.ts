import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { computeYardSignSuggestions } from '../../_lib/yardSignSuggestions.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{
    radius_miles?: number;
    max_suggestions?: number;
    county?: string[];
  }>(req);

  const county = (body.county?.[0] ?? '').trim();
  if (!county) {
    return json(res, 400, {
      error: 'Pick a county first — statewide coverage is too slow on large files.',
    });
  }

  try {
    const result = await computeYardSignSuggestions(ctx.voter, {
      radius_miles: body.radius_miles,
      max_suggestions: body.max_suggestions,
      county: [county],
    });
    return json(res, 200, result);
  } catch (err) {
    return json(res, 500, {
      error:
        err instanceof Error ? err.message : 'Yard sign suggestions failed',
    });
  }
}
