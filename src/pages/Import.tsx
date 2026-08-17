import { useEffect, useState } from 'react';
import { Alert, PageHeader } from '../components/ui';
import { ImportMappingModal, slugFromPetitionTarget } from '../components/ImportMappingModal';
import {
  createPetitionApi,
  fetchCampaignSyncState,
  importVoters,
  syncCampaignIndexes,
} from '../lib/api';
import { usePetitions } from '../lib/petitions';
import { finalizeImportBatch } from '../lib/importBatches';
import { parseCsv, rowsToObjects } from '../lib/csv';
import { collapseImportRows } from '../lib/dedupe';
import {
  VOTER_FIELDS,
  type CampaignSyncState,
  type VoterFieldKey,
} from '../lib/types';

/** Set-based upsert handles ~150/row batch well on free tier. */
const BATCH_SIZE = 150;
const MAX_RETRIES = 3;

type Phase = 'idle' | 'mapping' | 'importing' | 'done';

export default function ImportPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [filename, setFilename] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState({
    inserted: 0,
    updated: 0,
    skipped: 0,
    collapsed: 0,
    errors: [] as string[],
    incomplete: false,
    rowsSubmitted: 0,
    rowsTotal: 0,
  });
  const [syncState, setSyncState] = useState<CampaignSyncState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const {
    activePetitions: petitions,
    reload: reloadPetitions,
    addLocal: addPetitionLocal,
  } = usePetitions();

  useEffect(() => {
    void fetchCampaignSyncState()
      .then((r) => setSyncState(r.state))
      .catch(() => setSyncState(null));
  }, []);

  const refreshCampaign = async () => {
    setSyncing(true);
    setSyncMessage(null);
    setError(null);
    try {
      const res = await syncCampaignIndexes({ recompute_tags: true });
      setSyncState(res.state);
      setSyncMessage(
        `Synced ${res.state?.volunteer_count ?? 0} volunteers, ${res.state?.yard_sign_count ?? 0} yard signs → ${res.state?.matched_voter_count ?? 0} matched voters, ${res.state?.geo_point_count ?? 0} geo points.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Campaign sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const onFile = async (file: File) => {
    setError(null);
    const text = await file.text();
    const { headers: h, rows } = parseCsv(text);
    if (h.length === 0) {
      setError('Could not detect CSV headers.');
      return;
    }
    setFilename(file.name);
    setHeaders(h);
    setRawRows(rows);
    setPhase('mapping');
  };

  const runImport = async (mapping: Record<string, string>) => {
    setError(null);
    setPhase('importing');

    const mapped = rowsToObjects(headers, rawRows, mapping).map(normalizeRow);
    const { rows: collapsedRows, collapsed } = collapseImportRows(mapped);

    const totalBatches = Math.ceil(collapsedRows.length / BATCH_SIZE) || 1;
    setProgress({ done: 0, total: totalBatches });

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    let batchId: string | null = null;

    let aborted = false;
    let consecutiveHardFailures = 0;
    let rowsSubmitted = 0;

    for (let i = 0; i < collapsedRows.length; i += BATCH_SIZE) {
      const chunk = collapsedRows.slice(i, i + BATCH_SIZE);

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const res = await importVoters({
            rows: chunk,
            filename,
            batchId,
          });
          batchId = res.batch_id;
          inserted += res.inserted;
          updated += res.updated;
          skipped += res.skipped;
          errors.push(...(res.errors ?? []));
          consecutiveHardFailures = 0;
          rowsSubmitted += chunk.length;
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Batch failed';
          const unreachable =
            /ECONNREFUSED|Failed to fetch|NetworkError|API unreachable/i.test(msg);
          const timeout = /statement timeout|canceling statement/i.test(msg);

          if (unreachable) {
            consecutiveHardFailures += 1;
            errors.push(msg);
            if (consecutiveHardFailures >= 2) {
              errors.push(
                'Stopping import: API is unavailable. Restart `npm run dev` and refresh.',
              );
              aborted = true;
              break;
            }
          } else if (timeout && attempt < MAX_RETRIES) {
            // Free-tier DB timeout — back off and retry the same batch.
            await new Promise((r) => setTimeout(r, 400 * attempt));
            continue;
          } else {
            errors.push(msg);
            // Soft failure: skip this batch and continue so one timeout doesn't kill ~180k rows.
            break;
          }
        }
      }

      if (aborted) break;

      setProgress({ done: Math.floor(i / BATCH_SIZE) + 1, total: totalBatches });
      if (i + BATCH_SIZE < collapsedRows.length) {
        await new Promise((r) => setTimeout(r, 40));
      }
    }

    const incomplete = aborted || rowsSubmitted < collapsedRows.length;

    setResult({
      inserted,
      updated,
      skipped,
      collapsed,
      errors: errors.slice(0, 50),
      incomplete,
      rowsSubmitted,
      rowsTotal: collapsedRows.length,
    });

    if (batchId) {
      try {
        await finalizeImportBatch({
          batchId,
          status:
            inserted + updated === 0 && errors.length
              ? 'failed'
              : incomplete
                ? 'partial'
                : 'completed',
          filename,
          inserted,
          updated,
          skipped,
        });
      } catch {
        // logging / finalize is best-effort
      }
    }

    setPhase('done');
  };

  return (
    <div>
      <PageHeader
        title="Import voters"
        description="Same mapping + dedupe style as the campaign portal: map columns, collapse in-file duplicates, then fill-in upsert by Murmuration ID (preferred 1:1), then state voter ID, then email / phone / name+address — including rows with no IDs."
      />

      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {phase === 'idle' && (
        <div className="mb-4 card space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-800">
                Campaign indexes (FormHandler)
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Read-only pull of volunteer / yard-sign links and map pins into the
                voter DB. Apply campaign migrations through 0038 for full SQL sync
                (phone matching + faster path).
              </p>
              <p className="mt-2 text-[11px] text-slate-500">
                Apply migrations:{' '}
                <code className="rounded bg-slate-100 px-1">
                  SUPABASE_DB_PASSWORD=… npm run db:apply-campaign
                </code>
              </p>
              <p className="mt-2 text-xs text-slate-600">
                {syncState?.last_success_at
                  ? `Last synced ${new Date(syncState.last_success_at).toLocaleString()} · ${syncState.matched_voter_count.toLocaleString()} matched · ${syncState.geo_point_count.toLocaleString()} pins`
                  : 'Not synced yet'}
              </p>
              {syncState?.last_error ? (
                <p className="mt-1 text-xs text-red-600">{syncState.last_error}</p>
              ) : null}
              {syncMessage ? (
                <p className="mt-1 text-xs text-emerald-700">{syncMessage}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="btn-secondary shrink-0"
              disabled={syncing}
              onClick={() => void refreshCampaign()}
            >
              {syncing ? 'Refreshing…' : 'Refresh campaign data'}
            </button>
          </div>
        </div>
      )}

      {phase === 'idle' && (
        <div className="card p-8 text-center">
          <p className="mb-4 text-sm text-slate-600">
            Upload a PDI / Achilles export (.csv). Large files import in batches of{' '}
            {BATCH_SIZE} with fill-in merge (never wipes existing contact fields).
          </p>
          <label className="btn-primary cursor-pointer">
            Choose CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </label>
        </div>
      )}

      {phase === 'mapping' && (
        <ImportMappingModal
          title={`Map columns — ${filename}`}
          headers={headers}
          sampleRows={rawRows}
          petitions={petitions}
          onCreatePetition={async (label) => {
            const { petition } = await createPetitionApi({ label });
            if (!petition?.slug) {
              throw new Error('Could not create petition');
            }
            addPetitionLocal(petition);
            reloadPetitions();
            return petition;
          }}
          onCancel={() => {
            setPhase('idle');
            setHeaders([]);
            setRawRows([]);
          }}
          onConfirm={(mapping) => void runImport(mapping)}
        />
      )}

      {phase === 'importing' && (
        <div className="card space-y-3 p-6">
          <p className="text-sm font-medium text-slate-800">Importing…</p>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-brand-600 transition-all"
              style={{
                width: `${progress.total ? (100 * progress.done) / progress.total : 0}%`,
              }}
            />
          </div>
          <p className="text-xs text-slate-500">
            Batch {progress.done} of {progress.total} · {BATCH_SIZE} rows/batch
          </p>
        </div>
      )}

      {phase === 'done' && (
        <div className="card space-y-4 p-6">
          <Alert variant={result.incomplete ? 'warning' : 'success'}>
            {result.incomplete ? 'Import stopped early: ' : 'Import finished: '}
            {result.inserted.toLocaleString()} inserted,{' '}
            {result.updated.toLocaleString()} updated (fill-in merge),{' '}
            {result.skipped.toLocaleString()} empty rows skipped
            {result.collapsed > 0
              ? ` (${result.collapsed.toLocaleString()} in-file duplicates merged before import — not skipped)`
              : ''}
            {result.incomplete
              ? ` (${result.rowsSubmitted.toLocaleString()} of ${result.rowsTotal.toLocaleString()} unique rows reached the database). Re-import the same file — fill-in merge will skip/update existing rows.`
              : '.'}
          </Alert>
          {result.errors.length > 0 && (
            <Alert variant="warning">
              <p className="font-medium">Some errors:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Alert>
          )}
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setPhase('idle');
              setHeaders([]);
              setRawRows([]);
            }}
          >
            Import another file
          </button>
        </div>
      )}
    </div>
  );
}

const SIG_FIELD_TO_SLUG: Record<string, string> = {
  sig_open_primaries: 'open_primaries',
  sig_reproductive_freedom: 'reproductive_freedom',
  sig_reproductive_freedom_valid_code: 'reproductive_freedom',
  sig_achilles_petition: 'achilles',
  sig_medical_cannabis: 'medical_cannabis',
  sig_medical_marijuana_valid_code: 'medical_marijuana_valid',
};

function normalizeRow(row: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const signatures: Record<string, string> = {};

  for (const field of VOTER_FIELDS) {
    const key = field.key as VoterFieldKey;
    const raw = row[key];
    if (raw == null || raw === '') {
      out[key] = null;
      continue;
    }
    if (key === 'age' || key === 'support_score') {
      const n = Number.parseInt(raw, 10);
      out[key] = Number.isFinite(n) ? n : null;
    } else if (key === 'lat' || key === 'lng') {
      const n = Number.parseFloat(raw);
      out[key] = Number.isFinite(n) ? n : null;
    } else if (key === 'state') {
      out[key] = raw.slice(0, 2).toUpperCase();
    } else {
      out[key] = raw;
    }
    const slug = SIG_FIELD_TO_SLUG[key];
    if (slug && raw) signatures[slug] = raw;
  }

  for (const [key, raw] of Object.entries(row)) {
    const slug = slugFromPetitionTarget(key);
    if (slug && raw) signatures[slug] = raw;
  }

  if (Object.keys(signatures).length) out.signatures = signatures;
  return out;
}
