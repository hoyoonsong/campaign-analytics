import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{
    filters?: unknown;
    after_id?: number | null;
    limit?: number;
  }>(req);

  const { data, error } = await ctx.voter.rpc('voter_export_page', {
    filters: body.filters ?? {},
    after_id: body.after_id ?? null,
    lim: body.limit ?? 1000,
  });

  if (error) return json(res, 500, { error: error.message });
  return json(res, 200, data);
}
