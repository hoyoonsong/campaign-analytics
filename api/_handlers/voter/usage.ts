import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, requireCampaignUser } from '../../_lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const { data, error } = await ctx.voter.rpc('voter_db_usage');
  if (error) return json(res, 500, { error: error.message });
  return json(res, 200, data);
}
