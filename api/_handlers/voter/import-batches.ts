import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { logActivityServer } from '../../_lib/log.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const { data, error } = await ctx.voter
      .from('voter_import_batches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return json(res, 500, { error: error.message });
    return json(res, 200, { batches: data ?? [] });
  }

  if (req.method === 'POST') {
    const body = readBody<{
      batchId?: string;
      status?: 'completed' | 'failed' | 'partial';
      filename?: string;
      inserted?: number;
      updated?: number;
      skipped?: number;
    }>(req);

    const batchId = (body.batchId ?? '').trim();
    if (!batchId) return json(res, 400, { error: 'batchId required' });

    const status = body.status ?? 'completed';
    const patch: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (typeof body.inserted === 'number') patch.inserted_rows = body.inserted;
    if (typeof body.updated === 'number') patch.updated_rows = body.updated;
    if (typeof body.skipped === 'number') patch.skipped_rows = body.skipped;

    const { error } = await ctx.voter
      .from('voter_import_batches')
      .update(patch)
      .eq('id', batchId);

    if (error) return json(res, 500, { error: error.message });

    await logActivityServer(ctx, {
      action: status === 'failed' ? 'import_failed' : 'import',
      entityType: 'import_batch',
      entityId: batchId,
      source: 'import',
      metadata: {
        label: body.filename ?? undefined,
        inserted: body.inserted ?? 0,
        updated: body.updated ?? 0,
        skipped: body.skipped ?? 0,
      },
    });

    // Petition imports don't change county/city lists; keep filter-options
    // cache so Analytics doesn't stampede 12 distinct scans after upload.
    if (status !== 'failed') {
      await ctx.voter
        .from('campaign_sync_state')
        .update({
          analytics_summary_cache: null,
          analytics_summary_cached_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1);
      await ctx.voter.rpc('mark_possible_duplicates_stale');
    }

    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
}
