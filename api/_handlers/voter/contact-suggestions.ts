import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{
    party?: string | null;
    signed_min?: number;
    page?: number;
    page_size?: number;
  }>(req);

  const { data, error } = await ctx.voter.rpc('contact_suggestions', {
    p_party: body.party ?? null,
    p_signed_min: body.signed_min ?? 1,
    p_page: body.page ?? 1,
    p_page_size: body.page_size ?? 50,
  });
  if (error) return json(res, 500, { error: error.message });
  return json(res, 200, data ?? { rows: [], total: 0, counts: {} });
}
