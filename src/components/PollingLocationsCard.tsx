import { useEffect, useState } from 'react';
import { Alert } from './ui';
import {
  assignNearestPollingLocations,
  fetchPollingLocations,
  geocodeMissingPollingLocations,
  importPollingLocations,
} from '../lib/api';
import {
  countyKey,
  pollingKindLabel,
  readPollingFile,
  type PollingFilePreview,
  type PollingKind,
} from '../lib/pollingLocations';

type Phase = 'idle' | 'preview' | 'running' | 'done';

type ImportResult = {
  files: Array<{
    kind: PollingKind;
    saved: number;
    geocoded: number;
    ungeocoded: number;
  }>;
  matched: number;
  total: number | null;
  ungeocoded: number;
};

export function PollingLocationsCard() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [files, setFiles] = useState<PollingFilePreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [loaded, setLoaded] = useState<{
    election_day: number;
    early_voting: number;
    plotted: number;
    ungeocoded: number;
  } | null>(null);

  const refreshLoaded = () => {
    void fetchPollingLocations()
      .then((res) => setLoaded(res.summary))
      .catch((err: Error) => {
        setLoaded(null);
        if (/migration 0068/i.test(err.message)) setError(err.message);
      });
  };

  useEffect(() => {
    refreshLoaded();
  }, []);

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setError(null);
    setResult(null);
    const next: PollingFilePreview[] = [];
    try {
      for (const file of Array.from(list)) {
        next.push(await readPollingFile(file));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.');
      return;
    }
    const byKind = new Map<PollingKind, PollingFilePreview>();
    for (const file of next) byKind.set(file.kind, file);
    setFiles([...byKind.values()]);
    setPhase('preview');
  };

  const run = async (assignOnly: boolean) => {
    setError(null);
    setPhase('running');
    setProgress(8);
    const imported: ImportResult['files'] = [];
    try {
      if (!assignOnly) {
        for (const file of files) {
          setStatus(`Geocoding ${pollingKindLabel(file.kind).toLowerCase()} addresses…`);
          const res = await importPollingLocations({
            kind: file.kind,
            locations: file.locations,
          });
          imported.push(res);
        }
        setProgress(35);
        let remaining = imported.reduce((sum, file) => sum + file.ungeocoded, 0);
        let stalled = 0;
        let passes = 0;
        while (remaining > 0 && stalled < 2 && passes < 3) {
          passes += 1;
          setStatus(`Locating ${remaining.toLocaleString()} addresses that the first pass missed…`);
          const pass = await geocodeMissingPollingLocations();
          remaining = pass.remaining;
          stalled = pass.geocoded === 0 ? stalled + 1 : 0;
        }
      }

      setStatus('Matching each person to the closest site in their county…');
      let afterId = 0;
      let matched = 0;
      let total: number | null = null;
      for (;;) {
        const page = await assignNearestPollingLocations(afterId);
        if (page.total != null) total = page.total;
        matched += page.assigned;
        afterId = page.after_id;
        if (total) setProgress(35 + Math.min(60, (60 * matched) / total));
        if (page.done) break;
      }

      const summary = await fetchPollingLocations();
      setLoaded(summary.summary);
      setResult({
        files: imported,
        matched,
        total,
        ungeocoded: summary.summary.ungeocoded,
      });
      setProgress(100);
      setPhase('done');
      setStatus('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setPhase(files.length ? 'preview' : 'idle');
      setStatus('');
    }
  };

  return (
    <div className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Polling locations</h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-500">
            Drop the statewide election-day list and the early-voting list (.xlsx).
            Addresses are geocoded, plotted on the Analytics map, and each person
            with coordinates is matched to the closest active site in their county.
          </p>
          {loaded ? (
            <p className="mt-2 text-xs text-slate-600">
              On the map now: {loaded.election_day.toLocaleString()} election-day sites,{' '}
              {loaded.early_voting.toLocaleString()} early-voting sites
              {loaded.ungeocoded > 0
                ? ` · ${loaded.ungeocoded.toLocaleString()} still need a map point`
                : ''}
              .
            </p>
          ) : null}
        </div>
        {loaded && loaded.election_day + loaded.early_voting > 0 && phase !== 'running' ? (
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={() => void run(true)}
          >
            Match people again
          </button>
        ) : null}
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {phase !== 'running' && phase !== 'done' ? (
        <label className="btn-secondary inline-flex cursor-pointer">
          Choose polling files
          <input
            type="file"
            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            multiple
            className="hidden"
            onChange={(event) => {
              void onFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </label>
      ) : null}

      {phase === 'preview' && (
        <div className="space-y-3">
          {files.map((file) => {
            const missingCounty = file.locations.filter((row) => !countyKey(row.county)).length;
            return (
              <div key={file.kind} className="rounded-md border border-slate-200 px-3 py-2">
                <p className="text-sm font-medium text-slate-800">
                  {pollingKindLabel(file.kind)} · {file.filename}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {file.locations.length.toLocaleString()} unique sites from{' '}
                  {file.sourceRows.toLocaleString()} rows
                  {file.countyCount > 0
                    ? ` across ${file.countyCount.toLocaleString()} counties`
                    : ''}
                  . Replaces the current {pollingKindLabel(file.kind).toLowerCase()} list.
                </p>
                {missingCounty > 0 ? (
                  <p className="mt-1 text-xs text-slate-500">
                    {missingCounty.toLocaleString()} rows have no county. Those are filled in
                    from the geocoded pin.
                  </p>
                ) : null}
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                  {file.locations.slice(0, 3).map((row) => (
                    <li key={row.external_key}>
                      {row.name}
                      {row.city ? ` · ${row.city}` : ''}
                      {row.county ? ` · ${row.county}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => void run(false)}>
              Import and match people
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setFiles([]);
                setPhase('idle');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-800">{status || 'Working…'}</p>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-brand-600 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {phase === 'done' && result ? (
        <div className="space-y-3">
          <Alert variant="success">
            {result.files.length > 0
              ? result.files
                  .map(
                    (file) =>
                      `${pollingKindLabel(file.kind)}: ${file.geocoded.toLocaleString()} of ${file.saved.toLocaleString()} sites plotted`,
                  )
                  .join(' · ') + '. '
              : ''}
            {result.matched.toLocaleString()} people with map coordinates were matched to the
            closest site in their county.
            {result.ungeocoded > 0
              ? ` ${result.ungeocoded.toLocaleString()} addresses still need a map point, so those sites are saved and left off the map.`
              : ''}
          </Alert>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setPhase('idle');
              setFiles([]);
              setResult(null);
            }}
          >
            Import another list
          </button>
        </div>
      ) : null}
    </div>
  );
}
