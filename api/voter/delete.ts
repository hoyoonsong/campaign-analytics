import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../_lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{ ids?: unknown }>(req);
  const raw = Array.isArray(body.ids) ? body.ids : [];
  const ids = raw
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.trunc(n));

  if (ids.length === 0) {
    return json(res, 400, { error: 'ids required' });
  }
  if (ids.length > 500) {
    return json(res, 400, { error: 'Max 500 ids per delete batch' });
  }

  const { data, error } = await ctx.voter.rpc('voter_delete_batch', { ids });
  if (error) {
    return json(res, 500, { error: error.message });
  }

  const result = (data ?? {}) as { deleted?: number; error?: string };
  if (result.error) {
    return json(res, 400, { error: result.error });
  }

  return json(res, 200, { deleted: result.deleted ?? 0 });
}
