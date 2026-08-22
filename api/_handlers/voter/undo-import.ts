import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { logActivityServer } from '../../_lib/log.js';
import { invalidateMapSnapshots } from '../../_lib/mapSnapshots.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{ batchId?: string }>(req);
  const batchId = body.batchId?.trim();
  if (!batchId) {
    return json(res, 400, { error: 'batchId required' });
  }

  const { data: batch, error: batchErr } = await ctx.voter
    .from('voter_import_batches')
    .select('id, filename, status, inserted_rows')
    .eq('id', batchId)
    .maybeSingle();

  if (batchErr || !batch) {
    return json(res, 404, { error: batchErr?.message ?? 'Batch not found' });
  }
  if (batch.status === 'undone') {
    return json(res, 400, { error: 'Import already undone' });
  }

  const { data, error } = await ctx.voter.rpc('undo_voter_import_batch', {
    p_batch_id: batchId,
    p_actor: ctx.user.id,
  });

  if (error) {
    return json(res, 500, { error: error.message });
  }

  const result = (data ?? {}) as { deleted?: number; error?: string };
  if (result.error) {
    return json(res, 400, { error: result.error });
  }

  await logActivityServer(ctx, {
    action: 'undo_import',
    entityType: 'import_batch',
    entityId: batchId,
    metadata: {
      label: batch.filename ?? 'import',
      deleted: result.deleted ?? 0,
    },
    source: 'import',
  });

  await ctx.voter
    .from('campaign_sync_state')
    .update({
      analytics_summary_cache: null,
      analytics_summary_cached_at: null,
      filter_options_cache: null,
      filter_options_cached_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  await invalidateMapSnapshots(ctx.voter);

  return json(res, 200, {
    deleted: result.deleted ?? 0,
    batch_id: batchId,
  });
}
