import type { AuthedContext } from './auth.js';

function capMetadata(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === 'string') {
      out[k] = v.length > 160 ? `${v.slice(0, 157)}…` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.length <= 8 ? v.slice(0, 8) : { count: v.length };
    }
  }
  const text = JSON.stringify(out);
  if (text.length > 1800) return { truncated: true, bytes: text.length };
  return out;
}

function actorLabel(ctx: AuthedContext): string {
  return (
    ctx.profile.full_name?.trim() ||
    ctx.profile.email?.trim() ||
    ctx.user.email?.trim() ||
    ctx.user.id
  );
}

/** Best-effort; never throws. */
export async function logActivityServer(
  ctx: AuthedContext,
  opts: {
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    source?: 'app' | 'trigger' | 'import' | 'sync' | 'system';
  },
): Promise<void> {
  try {
    await ctx.voter.rpc('log_activity', {
      p_action: opts.action,
      p_entity_type: opts.entityType,
      p_entity_id: opts.entityId ?? null,
      p_metadata: capMetadata(opts.metadata),
      p_source: opts.source ?? 'app',
      p_actor_id: ctx.user.id,
      p_actor: actorLabel(ctx),
    });
  } catch {
    // ignore
  }
}
