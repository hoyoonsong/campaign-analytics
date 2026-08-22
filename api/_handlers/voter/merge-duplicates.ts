import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, requireCampaignUser } from '../../_lib/auth.js';
import { invalidateMapSnapshots } from '../../_lib/mapSnapshots.js';

function isAdmin(role: string) {
  return role === 'admin';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (!isAdmin(ctx.profile.role)) return json(res, 403, { error: 'Admin only' });

  const { data, error } = await ctx.voter.rpc('auto_merge_sure_duplicates');
  if (error) {
    const msg = error.message || 'Auto-merge failed';
    if (/could not find the function|schema cache/i.test(msg)) {
      return json(res, 500, {
        error:
          'Database is missing the merge function. Apply migrations from 0048 (APPLY_FROM=0048 npm run db:apply-campaign), then restart npm run dev.',
      });
    }
    return json(res, 500, { error: msg });
  }
  const raw =
    typeof data === 'string'
      ? (JSON.parse(data) as Record<string, unknown>)
      : ((data ?? {}) as Record<string, unknown>);
  const merged = Number(raw.merged) || 0;
  if (merged > 0) {
    await invalidateMapSnapshots(ctx.voter);
  }

  return json(res, 200, {
    merged,
    skipped: Number(raw.skipped) || 0,
    found: Number(raw.found) || 0,
  });
}
