import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import { logActivityServer } from '../../_lib/log.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;

  // Create log entry
  if (req.method === 'POST') {
    const body = readBody<{
      action?: string;
      entity_type?: string;
      entity_id?: string | null;
      metadata?: Record<string, unknown>;
      source?: 'app' | 'trigger' | 'import' | 'sync' | 'system';
    }>(req);

    if (!body.action || !body.entity_type) {
      return json(res, 400, { error: 'action and entity_type required' });
    }

    await logActivityServer(ctx, {
      action: body.action,
      entityType: body.entity_type,
      entityId: body.entity_id,
      metadata: body.metadata,
      source: body.source,
    });
    return json(res, 200, { ok: true });
  }

  // List logs (PUT avoids large GET query strings)
  if (req.method === 'PUT' || req.method === 'GET') {
    const body =
      req.method === 'GET'
        ? {
            limit: Number(req.query.limit ?? 200),
            offset: Number(req.query.offset ?? 0),
            actor_id: (req.query.actor_id as string) || null,
            entity_type: (req.query.entity_type as string) || null,
            q: (req.query.q as string) || null,
          }
        : readBody<{
            limit?: number;
            offset?: number;
            actor_id?: string | null;
            entity_type?: string | null;
            q?: string | null;
          }>(req);

    const { data, error } = await ctx.voter.rpc('list_activity_logs', {
      p_limit: body.limit ?? 200,
      p_offset: body.offset ?? 0,
      p_actor_id: body.actor_id ?? null,
      p_entity_type: body.entity_type ?? null,
      p_q: body.q ?? null,
    });

    if (error) return json(res, 500, { error: error.message });
    return json(res, 200, { rows: data ?? [] });
  }

  // Prune
  if (req.method === 'DELETE') {
    const body = readBody<{ keep_days?: number }>(req);
    const { data, error } = await ctx.voter.rpc('prune_activity_logs', {
      p_keep_days: body.keep_days ?? 20,
    });
    if (error) return json(res, 500, { error: error.message });
    return json(res, 200, { deleted: data ?? 0 });
  }

  return json(res, 405, { error: 'Method not allowed' });
}
