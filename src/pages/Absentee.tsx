import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AbsenteeCombinations } from '../components/AbsenteeCombinations';
import { AbsenteeTarget } from '../components/AbsenteeTarget';
import { ImportMappingModal } from '../components/ImportMappingModal';
import { Alert, Modal, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { parseCsv, rowsToObjects } from '../lib/csv';
import { collapseImportRows } from '../lib/dedupe';
import { emptyFilters } from '../lib/filters';
import { normalizeImportRow } from '../lib/normalizeImportRow';
import { navigateToSearch } from '../lib/navigateToSearch';
import type { VoterFilters } from '../lib/types';
import { usePetitions } from '../lib/petitions';
import {
  createAbsenteeElectionApi,
  createAbsenteeGroupApi,
  createPetitionApi,
  deleteAbsenteeElectionApi,
  deleteAbsenteeGroupApi,
  importVoters,
  updateAbsenteeElectionApi,
  updateAbsenteeGroupApi,
} from '../lib/api';
import {
  ABSENTEE_STATUS_COLORS,
  absenteeStatusLabel,
  buildAbsenteeUnits,
  dashboardHeadline,
  dashboardStacked,
  filtersForAbsenteeCombo,
  filtersForAbsenteeExclusive,
  filtersForAbsenteeSuper,
  useAbsenteeDashboard,
  useAbsenteeElections,
  useSelectedElections,
  type AbsenteeElection,
  type AbsenteeGroup,
} from '../lib/absentee';

const VOTER_BATCH = 80;
const MAX_RETRIES = 4;
const CHART_SLATE = '#475569';
const VENN_KEY = 'absentee_venn_slugs_v1';

function readVennSlugs(): string[] | null {
  try {
    const raw = localStorage.getItem(VENN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((s) => typeof s === 'string');
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function AbsenteePage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const { elections, activeElections, groups, addLocal, reload } = useAbsenteeElections();
  const { slugs, toggle, hydrated } = useSelectedElections(activeElections);
  const { summary, loading, error } = useAbsenteeDashboard(slugs, hydrated);
  const { activePetitions, addLocal: addPetitionLocal, reload: reloadPetitions } =
    usePetitions();

  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [importPhase, setImportPhase] = useState<'idle' | 'mapping' | 'importing' | 'done'>(
    'idle',
  );
  const [importFile, setImportFile] = useState<{
    filename: string;
    headers: string[];
    rows: string[][];
  } | null>(null);
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0, label: '' });
  const [importResult, setImportResult] = useState<{
    inserted: number;
    updated: number;
    errors: string[];
  } | null>(null);
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupLabel, setGroupLabel] = useState('');
  const [groupShort, setGroupShort] = useState('');
  const [addToId, setAddToId] = useState('');
  const [vennSlugs, setVennSlugs] = useState<string[]>([]);

  useEffect(() => {
    if (!activeElections.length) return;
    const stored = readVennSlugs();
    const valid = new Set(activeElections.map((e) => e.slug));
    const kept = (stored ?? []).filter((s) => valid.has(s));
    setVennSlugs(kept.length ? kept : activeElections.map((e) => e.slug));
  }, [activeElections]);

  useEffect(() => {
    if (!vennSlugs.length) return;
    try {
      localStorage.setItem(VENN_KEY, JSON.stringify(vennSlugs));
    } catch {
      /* ignore */
    }
  }, [vennSlugs]);

  const units = useMemo(
    () => buildAbsenteeUnits(elections, groups),
    [elections, groups],
  );
  const checkedList = elections.filter((e) => checked.has(e.id));

  const headline = useMemo(() => dashboardHeadline(summary), [summary]);
  const stacked = useMemo(
    () => dashboardStacked(summary, slugs),
    [summary, slugs],
  );
  const countyRows = summary?.by_county ?? [];
  const partyRows = summary?.by_party ?? [];

  const goSearch = (patch: Partial<VoterFilters>) => {
    navigateToSearch(navigate, {
      ...emptyFilters(),
      absentee: slugs,
      ...patch,
    });
  };

  const create = async () => {
    if (!newLabel.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { election } = await createAbsenteeElectionApi({
        label: newLabel.trim(),
      });
      if (election) addLocal(election);
      setNewLabel('');
      setMsg('Election created.');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (e: AbsenteeElection, next: Partial<AbsenteeElection>) => {
    setBusy(true);
    setErr(null);
    try {
      await updateAbsenteeElectionApi({ id: e.id, ...next });
      reload();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleCheck = (id: number) => {
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCheckIds = (ids: number[]) => {
    const allOn = ids.every((id) => checked.has(id));
    setChecked((cur) => {
      const next = new Set(cur);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const openGroupModal = () => {
    const sample = checkedList[0];
    setGroupLabel(sample?.label.replace(/\s*\(.*\)\s*$/, '').trim() || 'Group');
    setGroupShort(sample?.short_label || 'Group');
    setGroupOpen(true);
  };

  const createGroup = async () => {
    if (!groupLabel.trim() || checkedList.length < 2) return;
    setBusy(true);
    setErr(null);
    try {
      await createAbsenteeGroupApi({
        label: groupLabel.trim(),
        short_label: groupShort.trim() || groupLabel.trim(),
        election_ids: checkedList.map((e) => e.id),
      });
      setChecked(new Set());
      setGroupOpen(false);
      setMsg('Group created. The Venn will show these as one circle.');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Group failed');
    } finally {
      setBusy(false);
    }
  };

  const addCheckedToGroup = async (groupId: number) => {
    if (!checkedList.length) return;
    setBusy(true);
    setErr(null);
    try {
      for (const e of checkedList) {
        if (e.group_id !== groupId) {
          await updateAbsenteeElectionApi({ id: e.id, group_id: groupId });
        }
      }
      setChecked(new Set());
      setAddToId('');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add to group');
    } finally {
      setBusy(false);
    }
  };

  const patchGroup = async (g: AbsenteeGroup, next: Partial<AbsenteeGroup>) => {
    setBusy(true);
    setErr(null);
    try {
      await updateAbsenteeGroupApi({ id: g.id, ...next });
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not rename group');
    } finally {
      setBusy(false);
    }
  };

  const ungroup = async (g: AbsenteeGroup) => {
    setBusy(true);
    setErr(null);
    try {
      await deleteAbsenteeGroupApi(g.id);
      setMsg(`Ungrouped ${g.label}.`);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ungroup failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: AbsenteeElection) => {
    if (
      !window.confirm(
        `Delete “${e.label}”? Ballot rows for this election are removed. Deactivate it instead if you might re-import.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await deleteAbsenteeElectionApi(e.id);
      setMsg(`Deleted ${e.label}.`);
      reload();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseCsv(text);
    if (!parsed.headers.length) {
      setErr(`Could not detect CSV headers in ${file.name}.`);
      return;
    }
    setImportFile({ filename: file.name, headers: parsed.headers, rows: parsed.rows });
    setImportPhase('mapping');
    setErr(null);
  };

  const runImport = async (mapping: Record<string, string>) => {
    if (!importFile) return;
    setImportPhase('importing');
    setImportResult(null);
    const mapped = rowsToObjects(importFile.headers, importFile.rows, mapping).map(
      normalizeImportRow,
    );
    const { rows } = collapseImportRows(mapped);
    const errors: string[] = [];
    let inserted = 0;
    let updated = 0;
    let batchId: string | undefined;
    setImportProgress({ done: 0, total: rows.length, label: 'Importing voters…' });
    for (let i = 0; i < rows.length; i += VOTER_BATCH) {
      const chunk = rows.slice(i, i + VOTER_BATCH);
      let attempt = 0;
      while (attempt <= MAX_RETRIES) {
        try {
          const res = await importVoters({
            rows: chunk,
            filename: importFile.filename,
            batchId,
          });
          batchId = res.batch_id ?? batchId;
          inserted += res.inserted ?? 0;
          updated += res.updated ?? 0;
          break;
        } catch (e) {
          attempt += 1;
          if (attempt > MAX_RETRIES) {
            errors.push(e instanceof Error ? e.message : 'Import batch failed');
            break;
          }
          await sleep(400 * attempt);
        }
      }
      setImportProgress({
        done: Math.min(i + chunk.length, rows.length),
        total: rows.length,
        label: 'Importing voters + absentee…',
      });
    }
    setImportResult({ inserted, updated, errors });
    setImportPhase('done');
    reload();
  };

  return (
    <div>
      <PageHeader
        title="Absentee ballots"
        description="Track requested, mailed, and returned ballots by election. Import a county or SOS file the same way as petitions and tracking polls."
        actions={
          isAdmin ? (
            <label className="btn-secondary cursor-pointer">
              Import CSV
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickFile(f);
                  e.target.value = '';
                }}
              />
            </label>
          ) : null
        }
      />

      {error || err ? <Alert variant="error">{err || error}</Alert> : null}
      {msg ? <p className="mb-3 text-sm text-slate-600">{msg}</p> : null}

      {isAdmin ? (
        <div className="card mb-4 space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[16rem] flex-1">
              <span className="label">New election</span>
              <input
                className="input"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. 2026 Primary absentee"
              />
            </label>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !newLabel.trim()}
              onClick={() => void create()}
            >
              Add
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || checkedList.length < 2}
              onClick={openGroupModal}
            >
              Group selected{checkedList.length ? ` (${checkedList.length})` : ''}
            </button>
            {groups.length > 0 ? (
              <select
                className="input w-44 py-2 text-sm"
                value={addToId}
                disabled={busy || checkedList.length === 0}
                onChange={(e) => {
                  const v = e.target.value;
                  setAddToId(v);
                  if (v) void addCheckedToGroup(Number(v));
                }}
              >
                <option value="">Add to group…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.short_label || g.label}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {elections.length ? (
            <ul className="space-y-1">
              {units.map((unit) => {
                const ids = unit.elections.map((e) => e.id);
                const selectedCount = ids.filter((id) => checked.has(id)).length;
                const allOn = selectedCount === ids.length && ids.length > 0;
                const someOn = selectedCount > 0 && !allOn;
                const grouped = !!unit.group && unit.elections.length > 1;
                return (
                  <li key={unit.key}>
                    {grouped && unit.group ? (
                      <div className="rounded-md bg-slate-50 px-2 py-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="checkbox"
                            checked={allOn}
                            ref={(el) => {
                              if (el) el.indeterminate = someOn;
                            }}
                            onChange={() => toggleCheckIds(ids)}
                          />
                          <input
                            className="input w-20 py-1 text-sm font-medium"
                            defaultValue={unit.group.short_label}
                            key={`gs-${unit.group.id}-${unit.group.short_label}`}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && unit.group && v !== unit.group.short_label) {
                                void patchGroup(unit.group, { short_label: v });
                              }
                            }}
                          />
                          <input
                            className="input min-w-[12rem] flex-1 py-1 text-sm"
                            defaultValue={unit.group.label}
                            key={`gl-${unit.group.id}-${unit.group.label}`}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && unit.group && v !== unit.group.label) {
                                void patchGroup(unit.group, { label: v });
                              }
                            }}
                          />
                          <span className="text-[11px] text-slate-500">
                            {unit.elections.length} elections
                          </span>
                          <button
                            type="button"
                            className="ml-auto text-xs font-medium text-brand-700 hover:underline"
                            disabled={busy}
                            onClick={() =>
                              unit.group ? void ungroup(unit.group) : undefined
                            }
                          >
                            Ungroup
                          </button>
                        </div>
                        <ul className="ml-6 mt-1 space-y-0.5 border-l border-slate-200 pl-3">
                          {unit.elections.map((e) => (
                            <ElectionRow
                              key={e.id}
                              e={e}
                              nested
                              busy={busy}
                              checked={checked.has(e.id)}
                              onToggle={() => toggleCheck(e.id)}
                              onPatch={patch}
                              onDelete={remove}
                            />
                          ))}
                        </ul>
                      </div>
                    ) : (
                      unit.elections.map((e) => (
                        <ElectionRow
                          key={e.id}
                          e={e}
                          nested={false}
                          busy={busy}
                          checked={checked.has(e.id)}
                          onToggle={() => toggleCheck(e.id)}
                          onPatch={patch}
                          onDelete={remove}
                        />
                      ))
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">
              Add an election, then import a CSV with voter ID and ballot status.
            </p>
          )}
        </div>
      ) : null}

      {importPhase === 'importing' ? (
        <div className="card mb-4 space-y-2 p-4">
          <p className="text-sm font-medium text-slate-800">{importProgress.label}</p>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-brand-600"
              style={{
                width: importProgress.total
                  ? `${Math.round((importProgress.done / importProgress.total) * 100)}%`
                  : '0%',
              }}
            />
          </div>
        </div>
      ) : null}

      {importPhase === 'done' && importResult ? (
        <Alert variant={importResult.errors.length ? 'error' : 'success'}>
          Imported {importResult.inserted.toLocaleString()} new /{' '}
          {importResult.updated.toLocaleString()} updated voters.
          {importResult.errors.length
            ? ` ${importResult.errors.length} batch error(s).`
            : ''}
        </Alert>
      ) : null}

      {loading ? (
        <Spinner label="Loading absentee ballots…" />
      ) : (
        <div className="space-y-4">
          {activeElections.length ? (
            <div className="flex flex-wrap gap-1.5">
              {activeElections.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={
                    slugs.includes(e.slug)
                      ? 'chip bg-brand-50 text-brand-800'
                      : 'chip opacity-60'
                  }
                  onClick={() => toggle(e.slug)}
                >
                  {e.short_label || e.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Ballots on file"
              value={headline.total}
              onClick={() => goSearch({})}
            />
            <Stat
              label="Requested, not returned"
              value={headline.requestedNotReturned}
              onClick={() =>
                goSearch({ absentee_status: ['REQUESTED', 'ISSUED', 'MAILED'] })
              }
            />
            <Stat
              label="Returned / accepted"
              value={headline.returned}
              onClick={() => goSearch({ absentee_status: ['RETURNED', 'ACCEPTED'] })}
            />
            <Stat
              label="Rejected"
              value={headline.rejected}
              onClick={() => goSearch({ absentee_status: ['REJECTED'] })}
            />
          </div>

          <div className="card overflow-hidden p-0">
            <AbsenteeTarget
              elections={activeElections}
              groups={groups}
              combos={summary?.combos ?? []}
              maskParty={summary?.mask_party ?? []}
              onSearch={(patch) => goSearch(patch)}
              onNotice={(message) => setMsg(message)}
              onError={(message) => setErr(message)}
              statusChart={
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Status by election
                  </h3>
                  {stacked.length === 0 ? (
                    <p className="mt-6 text-sm text-slate-500">No ballot rows yet.</p>
                  ) : (
                    <div className="mt-2 h-52">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={stacked} margin={{ left: 0, right: 4, top: 4, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 10 }}
                            interval={0}
                            angle={-28}
                            textAnchor="end"
                            height={46}
                          />
                          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={40} />
                          <Tooltip />
                          {(['REQUESTED', 'ISSUED', 'MAILED', 'RETURNED', 'ACCEPTED', 'REJECTED'] as const).map(
                            (key) => (
                              <Bar
                                key={key}
                                dataKey={key}
                                stackId="s"
                                fill={ABSENTEE_STATUS_COLORS[key]}
                                name={absenteeStatusLabel(key)}
                              />
                            ),
                          )}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              }
            />
          </div>

          <div className="card p-3">
            <AbsenteeCombinations
              elections={activeElections}
              groups={groups}
              selectedSlugs={vennSlugs}
              onChangeSlugs={setVennSlugs}
              onSelectAll={() => setVennSlugs(activeElections.map((e) => e.slug))}
              onSelectDefaults={() =>
                setVennSlugs(
                  activeElections.filter((e) => e.is_default).map((e) => e.slug)
                    .length
                    ? activeElections.filter((e) => e.is_default).map((e) => e.slug)
                    : activeElections.map((e) => e.slug),
                )
              }
              combos={summary?.combos ?? []}
              onSelectCombo={(mask, comboUnits) => {
                goSearch(filtersForAbsenteeCombo(mask, comboUnits));
              }}
              onSelectExclusive={(election, comboUnits) => {
                goSearch(filtersForAbsenteeExclusive(election, comboUnits));
              }}
              onSelectSuper={(comboUnits) => {
                goSearch(filtersForAbsenteeSuper(comboUnits));
              }}
              onExportNotice={(message) => setMsg(message)}
              onExportError={(message) => setErr(message)}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <BarCard
              title="By county"
              data={countyRows}
              onClick={(name) => goSearch({ county: [name] })}
            />
            <BarCard
              title="By party"
              data={partyRows}
              onClick={(name) => {
                const party =
                  name === 'Republican'
                    ? ['Republican']
                    : name === 'Democrat'
                      ? ['Democratic']
                      : [];
                goSearch(party.length ? { party } : {});
              }}
            />
          </div>

        </div>
      )}

      <Modal
        open={groupOpen}
        onClose={() => setGroupOpen(false)}
        title="Group elections"
        description="The Venn will treat these as one circle. Export and Search still use the individual elections."
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {checkedList.map((e) => e.short_label || e.label).join(', ')}
          </p>
          <label className="block">
            <span className="label">Group name</span>
            <input
              className="input"
              value={groupLabel}
              onChange={(e) => setGroupLabel(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">Short label</span>
            <input
              className="input"
              value={groupShort}
              onChange={(e) => setGroupShort(e.target.value)}
              maxLength={16}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setGroupOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !groupLabel.trim()}
              onClick={() => void createGroup()}
            >
              Create group
            </button>
          </div>
        </div>
      </Modal>

      {importPhase === 'mapping' && importFile ? (
        <ImportMappingModal
          title={`Map columns — ${importFile.filename}`}
          description="Map identity, then each election’s status, requested, issued/mailed, and returned columns."
          headers={importFile.headers}
          sampleRows={importFile.rows}
          petitions={activePetitions}
          elections={activeElections}
          onCreatePetition={async (label) => {
            const { petition } = await createPetitionApi({ label });
            if (!petition?.slug) throw new Error('Could not create petition');
            addPetitionLocal(petition);
            reloadPetitions();
            return petition;
          }}
          onCreateElection={async (label) => {
            const { election } = await createAbsenteeElectionApi({ label });
            if (!election?.slug) throw new Error('Could not create election');
            addLocal(election);
            reload();
            return election;
          }}
          onCancel={() => {
            setImportPhase('idle');
            setImportFile(null);
          }}
          onConfirm={(mapping) => void runImport(mapping)}
        />
      ) : null}
    </div>
  );
}

function ElectionRow({
  e,
  nested,
  busy,
  checked,
  onToggle,
  onPatch,
  onDelete,
}: {
  e: AbsenteeElection;
  nested: boolean;
  busy: boolean;
  checked: boolean;
  onToggle: () => void;
  onPatch: (e: AbsenteeElection, next: Partial<AbsenteeElection>) => void;
  onDelete: (e: AbsenteeElection) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <input
        className="input w-[5.5rem] py-1 text-sm"
        defaultValue={e.short_label}
        key={`s-${e.id}-${e.short_label}`}
        onBlur={(ev) => {
          const v = ev.target.value.trim();
          if (v && v !== e.short_label) void onPatch(e, { short_label: v });
        }}
      />
      <div className="min-w-[12rem] flex-1">
        <input
          className="input py-1 text-sm"
          defaultValue={e.label}
          key={`l-${e.id}-${e.label}`}
          onBlur={(ev) => {
            const v = ev.target.value.trim();
            if (v && v !== e.label) void onPatch(e, { label: v });
          }}
        />
        {!nested ? (
          <div className="text-[11px] text-slate-400">{e.slug}</div>
        ) : null}
      </div>
      <label className="flex items-center gap-1 text-[11px] text-slate-500">
        <input
          type="checkbox"
          disabled={busy}
          checked={e.is_default}
          onChange={() => void onPatch(e, { is_default: !e.is_default })}
        />
        Default
      </label>
      <label className="flex items-center gap-1 text-[11px] text-slate-500">
        <input
          type="checkbox"
          disabled={busy}
          checked={e.is_active}
          onChange={() => void onPatch(e, { is_active: !e.is_active })}
        />
        Active
      </label>
      <button
        type="button"
        className="text-xs font-medium text-rose-700 hover:underline"
        disabled={busy}
        onClick={() => void onDelete(e)}
      >
        Delete
      </button>
    </div>
  );
}

function Stat({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card px-3 py-3 text-left hover:bg-slate-50"
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
        {value.toLocaleString()}
      </p>
    </button>
  );
}

function BarCard({
  title,
  data,
  onClick,
}: {
  title: string;
  data: Array<{ name: string; count: number }>;
  onClick: (name: string) => void;
}) {
  return (
    <div className="card p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-800">{title}</h3>
      {data.length === 0 ? (
        <p className="text-sm text-slate-500">No data yet.</p>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ left: 8, right: 12, top: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={88}
                tick={{ fontSize: 11 }}
              />
              <Tooltip />
              <Bar
                dataKey="count"
                fill={CHART_SLATE}
                onClick={(d) => {
                  const name = (d as { name?: string })?.name;
                  if (name) onClick(name);
                }}
              >
                {data.map((row) => (
                  <Cell key={row.name} cursor="pointer" />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
