import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import {
  assignNearestPollingChunk,
  geocodeMissingPollingLocations,
  importPollingLocations,
  listPollingLocations,
  pollingCountyRanks,
  pollingDbError,
  pollingLinks,
  pollingYardSignGaps,
  type PollingImportRow,
  type PollingKind,
} from '../../_lib/pollingLocations.js';

function kindOf(value: unknown): PollingKind | null {
  return value === 'election_day' || value === 'early_voting' ? value : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = readBody<{
    action?: string;
    kind?: string;
    county?: string;
    locations?: PollingImportRow[];
    after_id?: number;
  }>(req);

  try {
    if (body.action === 'list') {
      return json(res, 200, await listPollingLocations(ctx.voter));
    }
    if (body.action === 'counties') {
      return json(res, 200, await pollingCountyRanks(ctx.voter));
    }
    if (body.action === 'yard_gaps') {
      const county = (body.county ?? '').trim();
      if (!county) return json(res, 400, { error: 'county is required' });
      return json(res, 200, await pollingYardSignGaps(ctx.voter, county));
    }
    if (body.action === 'links') {
      const kind = kindOf(body.kind);
      const county = (body.county ?? '').trim();
      if (!kind) return json(res, 400, { error: 'kind must be election_day or early_voting' });
      if (!county) return json(res, 400, { error: 'county is required' });
      return json(res, 200, await pollingLinks(ctx.voter, county, kind));
    }
    if (body.action === 'import') {
      const kind = kindOf(body.kind);
      if (!kind) return json(res, 400, { error: 'kind must be election_day or early_voting' });
      if (!Array.isArray(body.locations) || body.locations.length === 0) {
        return json(res, 400, { error: 'locations are required' });
      }
      return json(res, 200, await importPollingLocations(ctx.voter, kind, body.locations));
    }
    if (body.action === 'geocode_missing') {
      return json(res, 200, await geocodeMissingPollingLocations(ctx.voter));
    }
    if (body.action === 'assign') {
      const afterId = Number(body.after_id ?? 0);
      return json(
        res,
        200,
        await assignNearestPollingChunk(ctx.voter, Number.isFinite(afterId) ? afterId : 0),
      );
    }
    return json(res, 400, { error: 'Unknown action' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Polling locations failed';
    return json(res, 500, { error: pollingDbError(message).message });
  }
}
