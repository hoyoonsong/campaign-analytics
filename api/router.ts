import type { VercelRequest, VercelResponse } from '@vercel/node';

type Handler = (req: VercelRequest, res: VercelResponse) => unknown | Promise<unknown>;

const ROUTES: Record<string, () => Promise<{ default: Handler }>> = {
  activity: () => import('./_handlers/voter/activity.js'),
  analytics: () => import('./_handlers/voter/analytics.js'),
  delete: () => import('./_handlers/voter/delete.js'),
  export: () => import('./_handlers/voter/export.js'),
  'filter-options': () => import('./_handlers/voter/filter-options.js'),
  import: () => import('./_handlers/voter/import.js'),
  'import-batches': () => import('./_handlers/voter/import-batches.js'),
  'map-points': () => import('./_handlers/voter/map-points.js'),
  'map-snapshot': () => import('./_handlers/voter/map-snapshot.js'),
  nearby: () => import('./_handlers/voter/nearby.js'),
  profile: () => import('./_handlers/voter/profile.js'),
  search: () => import('./_handlers/voter/search.js'),
  'sync-campaign': () => import('./_handlers/voter/sync-campaign.js'),
  'undo-import': () => import('./_handlers/voter/undo-import.js'),
  universes: () => import('./_handlers/voter/universes.js'),
  petitions: () => import('./_handlers/voter/petitions.js'),
  'tracking-polls': () => import('./_handlers/voter/tracking-polls.js'),
  absentee: () => import('./_handlers/voter/absentee.js'),
  'merge-duplicates': () => import('./_handlers/voter/merge-duplicates.js'),
  'contact-suggestions': () => import('./_handlers/voter/contact-suggestions.js'),
  usage: () => import('./_handlers/voter/usage.js'),
  'yard-sign-suggestions': () => import('./_handlers/voter/yard-sign-suggestions.js'),
  'polling-locations': () => import('./_handlers/voter/polling-locations.js'),
};

function routeKey(req: VercelRequest): string | null {
  const raw = req.query.slug;
  if (typeof raw === 'string' && raw) return raw;
  if (Array.isArray(raw) && raw.length >= 1 && typeof raw[0] === 'string') {
    return raw[0];
  }
  const url = req.url ?? '';
  const match = url.match(/\/api\/voter\/([^/?#]+)/);
  return match?.[1] ?? null;
}

/** One Hobby-plan serverless function for all /api/voter/* routes. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const key = routeKey(req);
  if (!key || !ROUTES[key]) {
    res.status(404).json({ error: `Unknown route: /api/voter/${key ?? ''}` });
    return;
  }
  const mod = await ROUTES[key]();
  return mod.default(req, res);
}
