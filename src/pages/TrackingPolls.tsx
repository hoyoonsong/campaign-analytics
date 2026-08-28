import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ImportMappingModal } from '../components/ImportMappingModal';
import { NewTrackingPollModal } from '../components/NewTrackingPollModal';
import {
  TrackingPollAssignModal,
  type FilePollAssignment,
} from '../components/TrackingPollAssignModal';
import { TrackingPollTransitions } from '../components/TrackingPollTransitions';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { parseCsv, rowsToObjects } from '../lib/csv';
import { collapseImportRows } from '../lib/dedupe';
import { normalizeImportRow } from '../lib/normalizeImportRow';
import { usePetitions } from '../lib/petitions';
import {
  confirmTrackingPollImport,
  createPetitionApi,
  fetchTrackingPolls,
  importVoters,
} from '../lib/api';
import {
  expandMappedPollResponses,
  formatPollDate,
  inferPollDateFromFilename,
  pollDateTargets,
  pollDisplayName,
  sha256Hex,
  stackedPreference,
  trackingOverview,
  type StackedPoint,
  type TrackingPoll,
  type TrackingPollResponse,
} from '../lib/trackingPoll';

type ImportJob = {
  filename: string;
  hash: string | null;
  headers: string[];
  rows: string[][];
  inferredDate: string | null;
  assignment?: FilePollAssignment;
  assignedDate?: string | null;
  mapping?: Record<string, string>;
};

function sameHeaders(a: string[], b: string[]) {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}

function mergePolls(current: TrackingPoll[], added: TrackingPoll[]) {
  const byId = new Map(current.map((p) => [p.id, p]));
  for (const poll of added) byId.set(poll.id, poll);
  return [...byId.values()].sort((a, b) => a.poll_date.localeCompare(b.poll_date));
}

type Panel = 'all' | 'repeats' | 'flipped';

type ChartView =
  | 'all'
  | 'republican'
  | 'democrat'
  | 'independent'
  | 'femaleGop'
  | 'maleGop';

const CHART_VIEWS: { id: ChartView; label: string }[] = [
  { id: 'all', label: 'All respondents' },
  { id: 'republican', label: 'Republicans' },
  { id: 'democrat', label: 'Democrats' },
  { id: 'independent', label: 'Independents' },
  { id: 'femaleGop', label: 'Female Republicans' },
  { id: 'maleGop', label: 'Male Republicans' },
];

const VOTER_BATCH = 80;
const MAX_RETRIES = 4;
const TODD = '#6d28d9';
const RISCH = '#dc2626';
const UNSURE = '#ca8a04';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTimeout(msg: string) {
  return /timeout|canceling statement/i.test(msg);
}

export default function TrackingPolls() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const [polls, setPolls] = useState<TrackingPoll[]>([]);
  const [responses, setResponses] = useState<TrackingPollResponse[]>([]);
  const [panel, setPanel] = useState<Panel>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importPhase, setImportPhase] = useState<
    'idle' | 'assign' | 'mapping' | 'importing' | 'done'
  >('idle');
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [mappingIndex, setMappingIndex] = useState(0);
  const [newPollOpen, setNewPollOpen] = useState(false);
  const [newPollDate, setNewPollDate] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState({
    done: 0,
    total: 0,
    label: '',
  });
  const [importResult, setImportResult] = useState<{
    votersInserted: number;
    votersUpdated: number;
    polls: number;
    imported: number;
    existing: number;
    errors: string[];
  } | null>(null);
  const [reload, setReload] = useState(0);
  const [chartView, setChartView] = useState<ChartView>('all');
  const {
    activePetitions: petitions,
    reload: reloadPetitions,
    addLocal: addPetitionLocal,
  } = usePetitions();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchTrackingPolls()
      .then((data) => {
        if (cancelled) return;
        setPolls(data.polls);
        setResponses(data.responses);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load tracking polls');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const overview = useMemo(
    () => trackingOverview(polls, responses),
    [polls, responses],
  );
  const headline = overview.headline;
  const transitions = overview;
  const chartData = useMemo(() => {
    if (chartView === 'republican') {
      return stackedPreference(polls, responses, { party: 'republican' });
    }
    if (chartView === 'democrat') {
      return stackedPreference(polls, responses, { party: 'democrat' });
    }
    if (chartView === 'independent') {
      return stackedPreference(polls, responses, { party: 'independent' });
    }
    if (chartView === 'femaleGop') {
      return stackedPreference(polls, responses, {
        party: 'republican',
        gender: 'female',
      });
    }
    if (chartView === 'maleGop') {
      return stackedPreference(polls, responses, {
        party: 'republican',
        gender: 'male',
      });
    }
    return stackedPreference(polls, responses);
  }, [polls, responses, chartView]);
  const sameRisch =
    transitions.repeats.flows.find((f) => f.from === 'risch' && f.to === 'risch')
      ?.count ?? 0;
  const sameTodd =
    transitions.repeats.flows.find((f) => f.from === 'todd' && f.to === 'todd')
      ?.count ?? 0;
  const importedVoters = importResult
    ? importResult.votersInserted + importResult.votersUpdated
    : 0;
  const missingAnswers =
    importedVoters > headline.unique ? importedVoters - headline.unique : 0;
  const answersByPoll = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of responses) {
      counts.set(r.poll_id, (counts.get(r.poll_id) ?? 0) + 1);
    }
    return counts;
  }, [responses]);
  const mappingJob = importPhase === 'mapping' ? importJobs[mappingIndex] : null;
  const mappingPoll =
    typeof mappingJob?.assignment === 'number'
      ? polls.find((p) => p.id === mappingJob.assignment) ?? null
      : null;
  const mappingReuseCount = mappingJob
    ? importJobs.filter(
        (job, i) =>
          i > mappingIndex &&
          !job.mapping &&
          sameHeaders(mappingJob.headers, job.headers),
      ).length
    : 0;

  const resetImport = () => {
    setImportPhase('idle');
    setImportJobs([]);
    setMappingIndex(0);
    setImportResult(null);
  };

  const pickImportFiles = async (fileList: File[]) => {
    setError(null);
    const jobs: ImportJob[] = [];
    for (const file of fileList) {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.headers.length === 0) {
        setError(`Could not detect CSV headers in ${file.name}.`);
        return;
      }
      jobs.push({
        filename: file.name,
        hash: await sha256Hex(text),
        headers: parsed.headers,
        rows: parsed.rows,
        inferredDate: inferPollDateFromFilename(file.name),
      });
    }
    if (jobs.length === 0) return;
    setImportJobs(jobs);
    setMappingIndex(0);
    setImportPhase('assign');
  };

  const startMapping = (jobs: ImportJob[]) => {
    const nextIndex = jobs.findIndex((job) => !job.mapping);
    if (nextIndex === -1) {
      void runPollImport(jobs);
      return;
    }
    setImportJobs(jobs);
    setMappingIndex(nextIndex);
    setImportPhase('mapping');
  };

  const applyMapping = (mapping: Record<string, string>) => {
    const current = importJobs[mappingIndex];
    if (!current) return;
    const next = importJobs.map((job, i) => {
      if (i === mappingIndex) return { ...job, mapping };
      if (
        i > mappingIndex &&
        !job.mapping &&
        sameHeaders(current.headers, job.headers)
      ) {
        return { ...job, mapping };
      }
      return job;
    });
    startMapping(next);
  };

  const runPollImport = async (jobs: ImportJob[]) => {
    setError(null);
    const prepared = jobs.map((job) => {
      const assignedDate =
        job.assignedDate ??
        (typeof job.assignment === 'number'
          ? polls.find((p) => p.id === job.assignment)?.poll_date ?? null
          : null);
      const assignedPoll =
        typeof job.assignment === 'number'
          ? polls.find((p) => p.id === job.assignment) ??
            (assignedDate
              ? {
                  id: job.assignment,
                  poll_date: assignedDate,
                  label: null,
                  created_at: '',
                }
              : null)
          : null;
      const mapping = job.mapping ?? {};
      const mapped = rowsToObjects(job.headers, job.rows, mapping).map(
        normalizeImportRow,
      );
      const { rows: voterRows } = collapseImportRows(mapped);
      const expanded = expandMappedPollResponses(
        job.headers,
        job.rows,
        mapping,
        job.inferredDate,
        assignedDate,
      );
      const dates = [...new Set(expanded.map((r) => r.poll_date))].sort();
      return { job, assignedPoll, voterRows, expanded, dates };
    });
    const empty = prepared.find((p) => p.expanded.length === 0);
    if (empty) {
      setError(
        `No poll answers in ${empty.job.filename}. Map a Poll answer or Poll YYYY-MM-DD column.`,
      );
      setImportPhase('mapping');
      setMappingIndex(jobs.findIndex((j) => j.filename === empty.job.filename));
      return;
    }

    const totalSteps = prepared.reduce(
      (n, p) => n + (Math.ceil(p.voterRows.length / VOTER_BATCH) || 0) + p.dates.length,
      0,
    );
    if (totalSteps === 0) {
      setError('Nothing to import.');
      setImportPhase('idle');
      return;
    }

    setImportPhase('importing');
    let votersInserted = 0;
    let votersUpdated = 0;
    let imported = 0;
    let existing = 0;
    let pollCount = 0;
    const errors: string[] = [];
    let step = 0;

    for (const item of prepared) {
      let batchId: string | null = null;
      const voterBatches = Math.ceil(item.voterRows.length / VOTER_BATCH) || 0;
      for (let i = 0; i < item.voterRows.length; i += VOTER_BATCH) {
        const chunk = item.voterRows.slice(i, i + VOTER_BATCH);
        setImportProgress({
          done: step,
          total: totalSteps,
          label: `${item.job.filename} · voters ${Math.floor(i / VOTER_BATCH) + 1} of ${voterBatches}`,
        });
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const res = await importVoters({
              rows: chunk,
              filename: item.job.filename,
              batchId,
            });
            batchId = res.batch_id;
            votersInserted += res.inserted;
            votersUpdated += res.updated;
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Voter batch failed';
            if (isTimeout(msg) && attempt < MAX_RETRIES) {
              await sleep(600 * attempt);
              continue;
            }
            errors.push(`${item.job.filename}: ${msg}`);
            break;
          }
        }
        step += 1;
        await sleep(80);
      }

      pollCount += item.dates.length;
      for (const date of item.dates) {
        const pollLabel = item.assignedPoll
          ? pollDisplayName(item.assignedPoll)
          : formatPollDate(date);
        setImportProgress({
          done: step,
          total: totalSteps,
          label: `${item.job.filename} · ${pollLabel}`,
        });
        let ok = false;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const res = await confirmTrackingPollImport({
              poll_id:
                typeof item.job.assignment === 'number'
                  ? item.job.assignment
                  : undefined,
              poll_date: date,
              filename: item.job.filename,
              file_hash: item.job.hash,
              rows: item.expanded.filter((r) => r.poll_date === date),
            });
            imported += res.imported;
            existing += res.existing ?? 0;
            ok = true;
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Poll import failed';
            if (isTimeout(msg) && attempt < MAX_RETRIES) {
              await sleep(900 * attempt);
              continue;
            }
            errors.push(`${item.job.filename} · ${pollLabel}: ${msg}`);
          }
        }
        if (ok) await sleep(250);
        step += 1;
      }
    }

    setImportProgress({ done: totalSteps, total: totalSteps, label: 'Done' });
    setImportResult({
      votersInserted,
      votersUpdated,
      polls: pollCount,
      imported,
      existing,
      errors: errors.slice(0, 20),
    });
    setImportPhase('done');
    setReload((n) => n + 1);
  };

  return (
    <div>
      <PageHeader
        title="Tracking polls"
        description="Create a poll, then import a CSV into it. Repeat contacts, flips, and preference over time. Re-import the same file to fill any dates that timed out — existing answers are skipped."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-slate-200 p-0.5">
              <button
                type="button"
                className={
                  panel === 'all'
                    ? 'rounded px-2.5 py-1 text-xs font-medium bg-brand-50 text-brand-700'
                    : 'rounded px-2.5 py-1 text-xs font-medium text-slate-600'
                }
                onClick={() => setPanel('all')}
              >
                All
              </button>
              <button
                type="button"
                className={
                  panel !== 'all'
                    ? 'rounded px-2.5 py-1 text-xs font-medium bg-brand-50 text-brand-700'
                    : 'rounded px-2.5 py-1 text-xs font-medium text-slate-600'
                }
                onClick={() => setPanel('repeats')}
              >
                Repeats only
              </button>
            </div>
            {isAdmin ? (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setNewPollDate(null);
                    setNewPollOpen(true);
                  }}
                >
                  New poll
                </button>
                <label className="btn-primary cursor-pointer">
                  Import
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const list = [...(e.target.files ?? [])];
                      e.target.value = '';
                      if (list.length) void pickImportFiles(list);
                    }}
                  />
                </label>
              </>
            ) : null}
          </div>
        }
      />

      {error ? (
        <div className="mb-3">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      {importPhase === 'importing' ? (
        <div className="card mb-4 space-y-3 p-6">
          <p className="text-sm font-medium text-slate-800">
            Importing {importProgress.label}…
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-brand-600 transition-all"
              style={{
                width: `${
                  importProgress.total
                    ? (100 * importProgress.done) / importProgress.total
                    : 0
                }%`,
              }}
            />
          </div>
          <p className="text-xs text-slate-500">
            {importProgress.done} of {importProgress.total} · timed-out dates retry
            automatically
          </p>
        </div>
      ) : null}

      {importPhase === 'done' && importResult ? (
        <div className="mb-4 space-y-3">
          <Alert variant={importResult.errors.length ? 'warning' : 'success'}>
            Voters {importResult.votersInserted.toLocaleString()} inserted /{' '}
            {importResult.votersUpdated.toLocaleString()} updated
            {importResult.polls
              ? ` · ${importResult.imported.toLocaleString()} new poll answers across ${importResult.polls} dates`
              : ''}
            {importResult.existing
              ? ` · ${importResult.existing.toLocaleString()} already stored`
              : ''}
            . Re-import to finish any failed dates.
            {missingAnswers > 0
              ? ` ${importedVoters.toLocaleString()} is the voter file — Unique respondents is ${headline.unique.toLocaleString()} because ${missingAnswers.toLocaleString()} rows had no stored poll answer (blank Poll YYYY-MM-DD cells, or an identity that could not be kept).`
              : ''}
          </Alert>
          {importResult.errors.length > 0 ? (
            <Alert variant="warning">
              <ul className="list-disc pl-5">
                {importResult.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <button
            type="button"
            className="btn-secondary"
            onClick={resetImport}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {loading && polls.length === 0 ? (
        <Spinner label="Loading tracking polls…" />
      ) : polls.length === 0 && importPhase === 'idle' ? (
        <div className="card p-8 text-center">
          <p className="mb-4 text-sm text-slate-600">
            Create a tracking poll, then import a CSV into it. You can create several
            polls and assign each file. Wide exports with Poll YYYY-MM-DD columns still
            work.
          </p>
          {isAdmin ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setNewPollDate(null);
                  setNewPollOpen(true);
                }}
              >
                New poll
              </button>
              <label className="btn-primary cursor-pointer">
                Choose CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const list = [...(e.target.files ?? [])];
                    e.target.value = '';
                    if (list.length) void pickImportFiles(list);
                  }}
                />
              </label>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Ask an admin to import.</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {polls.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {polls.map((poll) => {
                const n = answersByPoll.get(poll.id) ?? 0;
                return (
                  <span
                    key={poll.id}
                    className="chip"
                    title={n ? `${n.toLocaleString()} answers` : 'No answers yet'}
                  >
                    {pollDisplayName(poll)}
                    {n ? ` · ${n.toLocaleString()}` : ' · empty'}
                  </span>
                );
              })}
            </div>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat
              label="Unique respondents"
              value={headline.unique}
              hint={
                headline.unmatched
                  ? `${headline.answers.toLocaleString()} answers · ${headline.unmatched.toLocaleString()} unmatched (no phone / email / ID)`
                  : 'People with at least one poll answer. Voter-file updates can be higher when some rows have blank poll dates.'
              }
              active={panel === 'all'}
              onClick={() => setPanel('all')}
            />
            <Stat
              label="Contacted more than once"
              value={headline.multi}
              hint="First vs second answer — same twice (e.g. Risch → Risch) is usually a skip"
              active={panel === 'repeats'}
              onClick={() => setPanel('repeats')}
            />
            <Stat
              label="Flipped"
              value={headline.flipped}
              hint="Repeat respondents whose Achilles / Risch / Not sure answer changed"
              active={panel === 'flipped'}
              onClick={() => setPanel('flipped')}
            />
          </div>
          <p className="text-[11px] text-slate-500">
            {headline.answers.toLocaleString()} stored answers from{' '}
            {headline.unique.toLocaleString()} people
            {headline.unmatched
              ? ` · ${headline.unmatched.toLocaleString()} unmatched (no phone / email / ID)`
              : ''}
            . Voter-file inserts/updates count every CSV row; Unique respondents
            only counts people with a Poll YYYY-MM-DD answer.
          </p>

          {panel === 'all' ? (
            <StackedCard
              title={
                CHART_VIEWS.find((v) => v.id === chartView)?.label ??
                'All respondents'
              }
              subtitle="Registered preference"
              data={chartData}
              action={
                <select
                  id="tracking-chart-view"
                  className="input w-52 py-1.5 text-sm"
                  value={chartView}
                  onChange={(e) => setChartView(e.target.value as ChartView)}
                  aria-label="Respondent group"
                >
                  {CHART_VIEWS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              }
            />
          ) : panel === 'flipped' ? (
            <div className="card p-3">
              <h3 className="text-sm font-semibold text-slate-800">
                Flipped · {headline.flipped.toLocaleString()}
              </h3>
              <p className="mb-2 text-[11px] text-slate-500">
                First time their Achilles / Risch / Not sure answer changed.
              </p>
              <TrackingPollTransitions
                data={transitions.flipped}
                leftLabel="Before"
                rightLabel="After"
                empty="No preference flips yet."
              />
            </div>
          ) : (
            <div className="card p-3">
              <h3 className="text-sm font-semibold text-slate-800">
                Contacted more than once
              </h3>
              <p className="mb-2 text-[11px] text-slate-500">
                First contact → second contact.{' '}
                {sameRisch.toLocaleString()} Risch both times (usually a skip) ·{' '}
                {sameTodd.toLocaleString()} Achilles both times.
              </p>
              <TrackingPollTransitions
                data={transitions.repeats}
                leftLabel="First contact"
                rightLabel="Second contact"
                empty="No one has answered two tracking polls yet."
              />
            </div>
          )}
        </div>
      )}

      {importPhase === 'mapping' && mappingJob ? (
        <ImportMappingModal
          key={`${mappingIndex}:${mappingJob.filename}`}
          title={`Map columns — ${mappingJob.filename}`}
          description={
            mappingPoll
              ? `Answers go into ${pollDisplayName(mappingPoll)}. Map contact fields and the poll answer column.${
                  mappingReuseCount
                    ? ` This mapping also applies to ${mappingReuseCount} other file${mappingReuseCount === 1 ? '' : 's'} with the same columns.`
                    : ''
                }`
              : `Same mapping as voter import. Contact, petitions, and tags update the voter file. Poll YYYY-MM-DD columns become these charts.${
                  mappingReuseCount
                    ? ` This mapping also applies to ${mappingReuseCount} other file${mappingReuseCount === 1 ? '' : 's'} with the same columns.`
                    : ''
                }`
          }
          headers={mappingJob.headers}
          sampleRows={mappingJob.rows}
          petitions={petitions}
          extraTargets={pollDateTargets(mappingJob.headers)}
          onCreatePetition={async (label) => {
            const { petition } = await createPetitionApi({ label });
            if (!petition?.slug) throw new Error('Could not create petition');
            addPetitionLocal(petition);
            reloadPetitions();
            return petition;
          }}
          onCancel={resetImport}
          onConfirm={(mapping) => applyMapping(mapping)}
        />
      ) : null}

      <TrackingPollAssignModal
        open={importPhase === 'assign'}
        files={importJobs}
        polls={polls}
        onClose={() => {
          if (newPollOpen) return;
          resetImport();
        }}
        onNewPoll={(date) => {
          setNewPollDate(date ?? null);
          setNewPollOpen(true);
        }}
        onConfirm={(assignments) => {
          startMapping(
            importJobs.map((job, i) => ({
              ...job,
              assignment: assignments[i],
              assignedDate:
                typeof assignments[i] === 'number'
                  ? polls.find((p) => p.id === assignments[i])?.poll_date ??
                    job.inferredDate
                  : null,
            })),
          );
        }}
      />

      <NewTrackingPollModal
        open={newPollOpen}
        initialDate={newPollDate}
        onClose={() => setNewPollOpen(false)}
        onCreated={(created) => {
          setPolls((prev) => mergePolls(prev, created));
        }}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  active,
  onClick,
}: {
  label: string;
  value: number;
  hint?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const className = `card p-3 text-left ${
    onClick ? 'cursor-pointer transition hover:border-brand-300 hover:bg-brand-50/40' : ''
  } ${active ? 'border-brand-300 bg-brand-50/40' : ''}`;
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-0.5 text-2xl font-bold text-slate-900">
        {value.toLocaleString()}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={className} title={hint} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <div className={className} title={hint}>
      {body}
    </div>
  );
}

function StackedCard({
  title,
  subtitle,
  data,
  action,
}: {
  title: string;
  subtitle?: string;
  data: StackedPoint[];
  action?: ReactNode;
}) {
  return (
    <div className="card p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {subtitle ? (
            <p className="text-[11px] text-slate-500">{subtitle}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10 }}
              interval={0}
              height={40}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              formatter={(value, name) => [
                `${Number(value).toFixed(1)}%`,
                name === 'todd'
                  ? 'Achilles'
                  : name === 'risch'
                    ? 'Risch'
                    : 'Not sure',
              ]}
            />
            <Legend
              formatter={(v) =>
                v === 'todd' ? 'Achilles' : v === 'risch' ? 'Risch' : 'Not sure'
              }
            />
            <Bar dataKey="risch" stackId="a" fill={RISCH} />
            <Bar dataKey="todd" stackId="a" fill={TODD} />
            <Bar dataKey="unsure" stackId="a" fill={UNSURE} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
