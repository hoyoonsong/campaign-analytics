import { supabase } from './supabase';

export type ActivityLogSource = 'app' | 'trigger' | 'import' | 'sync' | 'system';

export type ActivityLogRecord = {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  source: ActivityLogSource;
};

/** Keep metadata small for free-tier Supabase storage. */
export function capActivityMetadata(
  meta?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!meta || Object.keys(meta).length === 0) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (typeof v === 'string') {
      out[k] = v.length > 160 ? `${v.slice(0, 157)}…` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.length <= 8 ? v.slice(0, 8) : { count: v.length };
    } else if (typeof v === 'object') {
      const nested = capActivityMetadata(v as Record<string, unknown>);
      const text = JSON.stringify(nested);
      if (text.length <= 400) out[k] = nested;
      else out[k] = { truncated: true };
    }
  }
  const text = JSON.stringify(out);
  if (text.length > 1800) return { truncated: true, bytes: text.length };
  return out;
}

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/** Best-effort write; never throws — logging must not break primary flows. */
export async function logActivity(opts: {
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  source?: ActivityLogSource;
}): Promise<void> {
  try {
    const headers = await authHeaders();
    await fetch('/api/voter/activity', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: opts.action,
        entity_type: opts.entityType,
        entity_id: opts.entityId ?? null,
        metadata: capActivityMetadata(opts.metadata),
        source: opts.source ?? 'app',
      }),
    });
  } catch {
    // ignore
  }
}

export const ACTIVITY_LOG_KEEP_MIN = 14;
export const ACTIVITY_LOG_KEEP_MAX = 60;
export const ACTIVITY_LOG_KEEP_DEFAULT = 20;
const KEEP_DAYS_STORAGE_KEY = 'voter_activity_log_keep_days';

export function clampActivityLogKeepDays(days: number): number {
  if (!Number.isFinite(days)) return ACTIVITY_LOG_KEEP_DEFAULT;
  return Math.min(
    ACTIVITY_LOG_KEEP_MAX,
    Math.max(ACTIVITY_LOG_KEEP_MIN, Math.round(days)),
  );
}

export function readActivityLogKeepDays(): number {
  try {
    const raw = localStorage.getItem(KEEP_DAYS_STORAGE_KEY);
    if (raw == null) return ACTIVITY_LOG_KEEP_DEFAULT;
    return clampActivityLogKeepDays(Number(raw));
  } catch {
    return ACTIVITY_LOG_KEEP_DEFAULT;
  }
}

export function writeActivityLogKeepDays(days: number): number {
  const next = clampActivityLogKeepDays(days);
  try {
    localStorage.setItem(KEEP_DAYS_STORAGE_KEY, String(next));
  } catch {
    // ignore
  }
  return next;
}

export async function pruneActivityLogs(
  keepDays = ACTIVITY_LOG_KEEP_DEFAULT,
): Promise<number> {
  try {
    const headers = await authHeaders();
    const res = await fetch('/api/voter/activity', {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ keep_days: clampActivityLogKeepDays(keepDays) }),
    });
    const body = await res.json().catch(() => ({}));
    return typeof body?.deleted === 'number' ? body.deleted : 0;
  } catch {
    return 0;
  }
}

export async function listActivityLogs(opts?: {
  limit?: number;
  offset?: number;
  actorId?: string | null;
  entityType?: string | null;
  q?: string | null;
}): Promise<{ rows: ActivityLogRecord[]; error?: string }> {
  try {
    const headers = await authHeaders();
    const res = await fetch('/api/voter/activity', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        limit: opts?.limit ?? 200,
        offset: opts?.offset ?? 0,
        actor_id: opts?.actorId ?? null,
        entity_type: opts?.entityType ?? null,
        q: opts?.q ?? null,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        rows: [],
        error: typeof body?.error === 'string' ? body.error : 'Failed to load logs',
      };
    }
    return { rows: (body.rows as ActivityLogRecord[]) ?? [] };
  } catch (err) {
    return {
      rows: [],
      error: err instanceof Error ? err.message : 'Failed to load logs',
    };
  }
}

export function activityActorLabel(row: ActivityLogRecord): string {
  return row.actor?.trim() || (row.actor_id ? 'Unknown user' : 'System');
}

export function entityTypeLabel(entityType: string): string {
  switch (entityType) {
    case 'voter':
      return 'Voter';
    case 'import_batch':
      return 'Import';
    case 'universe':
      return 'Universe';
    default:
      return entityType.replace(/_/g, ' ');
  }
}

export function actionLabel(action: string): string {
  const map: Record<string, string> = {
    create: 'Created',
    delete: 'Deleted',
    merge: 'Merged',
    import: 'Imported',
    import_failed: 'Import failed',
    undo_import: 'Undid import',
    export: 'Exported',
    update: 'Updated',
  };
  return map[action] ?? action.replace(/_/g, ' ');
}

export function activitySummary(row: ActivityLogRecord): string {
  const meta = row.metadata ?? {};
  const label =
    (typeof meta.label === 'string' && meta.label) ||
    (typeof meta.entityLabel === 'string' && meta.entityLabel) ||
    null;
  const count = typeof meta.count === 'number' ? meta.count : null;
  const type = entityTypeLabel(row.entity_type);
  const verb = actionLabel(row.action);

  if (row.action === 'import' || row.action === 'import_failed') {
    const inserted = typeof meta.inserted === 'number' ? meta.inserted : null;
    const updated = typeof meta.updated === 'number' ? meta.updated : null;
    const parts = [
      label ? `${verb}: ${label}` : verb,
      inserted != null || updated != null
        ? `(${inserted ?? 0} new, ${updated ?? 0} updated)`
        : null,
    ].filter(Boolean);
    return parts.join(' ');
  }
  if (count != null && count > 1) {
    return label
      ? `${verb} ${count} ${type.toLowerCase()}s (${label})`
      : `${verb} ${count} ${type.toLowerCase()}s`;
  }
  if (label) return `${verb} ${type.toLowerCase()}: ${label}`;
  return `${verb} ${type.toLowerCase()}`;
}

export function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
