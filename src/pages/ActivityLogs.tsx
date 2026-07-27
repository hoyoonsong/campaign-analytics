import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, EmptyState, PageHeader, Spinner } from '../components/ui';
import {
  ACTIVITY_LOG_KEEP_MAX,
  ACTIVITY_LOG_KEEP_MIN,
  actionLabel,
  activityActorLabel,
  activitySummary,
  clampActivityLogKeepDays,
  entityTypeLabel,
  formatDateTime,
  listActivityLogs,
  pruneActivityLogs,
  readActivityLogKeepDays,
  writeActivityLogKeepDays,
  type ActivityLogRecord,
} from '../lib/activityLog';
import { listImportBatches, undoImportBatch, type ImportBatch } from '../lib/importBatches';

type Tab = 'activity' | 'imports';

function actionBadgeClass(action: string): string {
  if (action === 'delete' || action === 'undo_import' || action === 'import_failed') {
    return 'text-red-700 bg-red-50';
  }
  if (action === 'create' || action === 'import') {
    return 'text-emerald-700 bg-emerald-50';
  }
  if (action === 'export') {
    return 'text-sky-700 bg-sky-50';
  }
  return 'text-slate-600 bg-slate-100';
}

export default function ActivityLogs() {
  const [tab, setTab] = useState<Tab>('activity');
  const [rows, setRows] = useState<ActivityLogRecord[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [actorId, setActorId] = useState('');
  const [entityType, setEntityType] = useState('');
  const [keepDays, setKeepDays] = useState(() => readActivityLogKeepDays());
  const [keepDaysDraft, setKeepDaysDraft] = useState(() =>
    String(readActivityLogKeepDays()),
  );
  const [pruning, setPruning] = useState(false);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  const load = useCallback(
    async (search = q) => {
      setLoading(true);
      const res = await listActivityLogs({
        limit: 300,
        actorId: actorId || null,
        entityType: entityType || null,
        q: search || null,
      });
      if (res.error) setError(res.error);
      else {
        setError(null);
        setRows(res.rows);
      }
      setLoading(false);
    },
    [actorId, entityType, q],
  );

  useEffect(() => {
    if (tab !== 'activity') return;
    void (async () => {
      await pruneActivityLogs(keepDays);
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, actorId, entityType]);

  useEffect(() => {
    if (tab !== 'imports') return;
    setLoading(true);
    void listImportBatches()
      .then(setBatches)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tab]);

  const commitKeepDays = async () => {
    const next = writeActivityLogKeepDays(
      clampActivityLogKeepDays(Number(keepDaysDraft)),
    );
    setKeepDays(next);
    setKeepDaysDraft(String(next));
    if (next === keepDays) return;
    setPruning(true);
    await pruneActivityLogs(next);
    await load();
    setPruning(false);
  };

  const handleUndo = async (batch: ImportBatch) => {
    const label = batch.filename || 'this import';
    const ok = window.confirm(
      `Undo import “${label}”? This permanently deletes ${batch.inserted_rows.toLocaleString()} voter row(s) created by that import.\n\nFill-in updates to existing voters are not reversed.`,
    );
    if (!ok) return;
    setUndoingId(batch.id);
    setError(null);
    try {
      const res = await undoImportBatch(batch.id);
      setBatches((prev) =>
        prev.map((b) =>
          b.id === batch.id
            ? {
                ...b,
                status: 'undone',
                undone_at: new Date().toISOString(),
              }
            : b,
        ),
      );
      if (res.deleted === 0) {
        setError(
          'Marked undone, but no stamped rows remained (older imports before undo support).',
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Undo failed');
    } finally {
      setUndoingId(null);
    }
  };

  const actors = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.actor_id) {
        map.set(r.actor_id, r.actor?.trim() || r.actor_id);
      }
    }
    return Array.from(map.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const entityTypes = useMemo(() => {
    const set = new Set(rows.map((r) => r.entity_type));
    return Array.from(set).sort();
  }, [rows]);

  return (
    <div>
      <PageHeader
        title="Activity logs"
        description="Intentional actions — imports, exports, universes. Older entries are pruned automatically (same lean model as the campaign portal)."
      />

      <div className="mb-5 flex flex-wrap gap-2 border-b border-slate-200 pb-px">
        <button
          type="button"
          onClick={() => setTab('activity')}
          className={
            tab === 'activity'
              ? 'border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700'
              : 'px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-700'
          }
        >
          All activity
        </button>
        <button
          type="button"
          onClick={() => setTab('imports')}
          className={
            tab === 'imports'
              ? 'border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700'
              : 'px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-700'
          }
        >
          Import log
        </button>
      </div>

      {tab === 'imports' ? (
        loading ? (
          <Spinner label="Loading imports…" />
        ) : batches.length === 0 ? (
          <EmptyState
            title="No import batches yet"
            description="Finished CSV imports appear here."
          />
        ) : (
          <div className="card overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">File</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Inserted</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 font-medium">Empty skipped</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-b border-slate-100">
                    <td className="px-3 py-2 text-slate-600">
                      {formatDateTime(b.created_at)}
                    </td>
                    <td className="px-3 py-2 text-slate-800">{b.filename || '—'}</td>
                    <td className="px-3 py-2 capitalize text-slate-600">
                      {b.status}
                      {b.undone_at ? (
                        <span className="mt-0.5 block text-[10px] normal-case text-slate-400">
                          undone {formatDateTime(b.undone_at)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{b.inserted_rows}</td>
                    <td className="px-3 py-2">{b.updated_rows}</td>
                    <td className="px-3 py-2">{b.skipped_rows}</td>
                    <td className="px-3 py-2">
                      {b.status !== 'undone' && b.inserted_rows > 0 ? (
                        <button
                          type="button"
                          className="btn-danger px-2 py-1 text-xs"
                          disabled={undoingId === b.id}
                          onClick={() => void handleUndo(b)}
                        >
                          {undoingId === b.id ? 'Undoing…' : 'Undo'}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <>
          <div className="card mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="min-w-[12rem] flex-1">
              <label className="label">Search</label>
              <input
                className="input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void load();
                }}
                placeholder="Actor, action, type…"
              />
            </div>
            <div className="w-full sm:w-48">
              <label className="label">Person</label>
              <select
                className="input"
                value={actorId}
                onChange={(e) => setActorId(e.target.value)}
              >
                <option value="">Anyone</option>
                {actors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-full sm:w-44">
              <label className="label">Type</label>
              <select
                className="input"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
              >
                <option value="">Any</option>
                {entityTypes.map((t) => (
                  <option key={t} value={t}>
                    {entityTypeLabel(t)}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-full sm:w-36">
              <label className="label">
                Keep (days) {ACTIVITY_LOG_KEEP_MIN}–{ACTIVITY_LOG_KEEP_MAX}
              </label>
              <div className="flex gap-2">
                <input
                  className="input"
                  type="number"
                  min={ACTIVITY_LOG_KEEP_MIN}
                  max={ACTIVITY_LOG_KEEP_MAX}
                  value={keepDaysDraft}
                  onChange={(e) => setKeepDaysDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={pruning}
                  onClick={() => void commitKeepDays()}
                >
                  Apply
                </button>
              </div>
            </div>
            <button type="button" className="btn-secondary" onClick={() => void load()}>
              Refresh
            </button>
          </div>

          {error && (
            <div className="mb-4">
              <Alert variant="error">{error}</Alert>
            </div>
          )}

          {loading ? (
            <Spinner label="Loading activity…" />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No activity yet"
              description="Imports, exports, and universe changes will show up here."
            />
          ) : (
            <ul className="card divide-y divide-slate-100">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <span
                    className={`badge shrink-0 ${actionBadgeClass(row.action)}`}
                  >
                    {actionLabel(row.action)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-800">{activitySummary(row)}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {activityActorLabel(row)} · {formatDateTime(row.created_at)}
                      {row.source !== 'app' ? ` · ${row.source}` : ''}
                    </p>
                  </div>
                  <span className="chip shrink-0">{entityTypeLabel(row.entity_type)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
