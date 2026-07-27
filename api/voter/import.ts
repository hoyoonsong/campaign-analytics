import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../_lib/auth.js';

type ImportRow = Record<string, unknown>;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const body = readBody<{
    rows?: ImportRow[];
    filename?: string;
    batchId?: string | null;
  }>(req);

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return json(res, 400, { error: 'rows required' });
  }
  if (rows.length > 250) {
    return json(res, 400, { error: 'Max 250 rows per batch (free-tier safe)' });
  }

  let batchId = body.batchId ?? null;
  if (!batchId) {
    const { data: batch, error: batchErr } = await ctx.voter
      .from('voter_import_batches')
      .insert({
        filename: body.filename ?? null,
        status: 'running',
        created_by: ctx.user.id,
        total_rows: 0,
      })
      .select('id')
      .single();
    if (batchErr || !batch) {
      return json(res, 500, { error: batchErr?.message ?? 'Failed to create batch' });
    }
    batchId = batch.id as string;
  }

  const { data, error } = await ctx.voter.rpc('voter_upsert_batch', {
    rows,
    batch_id: batchId,
  });

  if (error) {
    return json(res, 500, { error: error.message, batch_id: batchId });
  }

  const result = (data ?? {}) as {
    inserted?: number;
    updated?: number;
    skipped?: number;
    errors?: string[];
    error?: string;
  };

  if (result.error) {
    return json(res, 400, { error: result.error, batch_id: batchId });
  }

  return json(res, 200, {
    inserted: result.inserted ?? 0,
    updated: result.updated ?? 0,
    skipped: result.skipped ?? 0,
    errors: result.errors ?? [],
    batch_id: batchId,
  });
}
