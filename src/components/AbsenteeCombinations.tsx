import { useEffect, useMemo, useState } from 'react';
import { logActivity } from '../lib/activityLog';
import {
  absenteeComboFilename,
  absenteeExportFilename,
  buildAbsenteeElectionUnits,
  collapseAbsenteeCombos,
  filtersForAbsenteeAny,
  filtersForAbsenteeCombo,
  filtersForAbsenteeSuper,
  resolveAbsenteeGroupUnits,
  unionCountForAbsenteeUnit,
  type AbsenteeComboCount,
  type AbsenteeElection,
  type AbsenteeGroup,
  type AbsenteeUnit,
} from '../lib/absentee';
import {
  downloadVotersCsv,
  EXPORT_FILE_ROWS,
  sleep,
} from '../lib/exportVotersCsv';
import { emptyFilters } from '../lib/filters';
import type { PetitionUnit } from '../lib/petitions';
import type { VoterFilters } from '../lib/types';
import { AbsenteeExportModal } from './AbsenteeExportModal';
import { OverlapPicker } from './OverlapPicker';
import { OverlapVenn, type OverlapSet } from './OverlapVenn';
import { PetitionOverlapBars } from './PetitionOverlapBars';

const UNIT_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2'];
const TAB_KEY = 'absentee_venn_tab_v1';
const ELECTION_SLUGS_KEY = 'absentee_venn_election_slugs_v2';

const OVERFLOW_COPY = {
  onlyOne: 'On file in only one',
  multi: 'In 2 or more',
  multiEmpty: 'No overlapping ballots.',
  modalTitle: 'Overlap combinations',
  modalDescription:
    'Exclusive lists — each person appears in one row. Click a combination to open it in Search.',
  itemNoun: 'elections',
  exactlyPhrase: 'in exactly',
};

export type AbsenteeVennTab = 'groups' | 'elections';

type Props = {
  elections: AbsenteeElection[];
  groups: AbsenteeGroup[];
  selectedSlugs: string[];
  onChangeSlugs: (slugs: string[]) => void;
  onSelectAll: () => void;
  onSelectDefaults?: () => void;
  combos?: AbsenteeComboCount[] | null;
  onSelectCombo?: (mask: number, units: AbsenteeUnit[]) => void;
  onSelectExclusive?: (election: AbsenteeElection, units: AbsenteeUnit[]) => void;
  onSelectSuper?: (units: AbsenteeUnit[]) => void;
  onExportNotice?: (message: string | null) => void;
  onExportError?: (message: string | null) => void;
};

function confirmAbsenteeExport(files: number, estimatedRows: number): boolean {
  const parts = Math.max(1, Math.ceil(estimatedRows / EXPORT_FILE_ROWS));
  if (files > 1) {
    return window.confirm(
      `This will download ${files} combination lists (~${estimatedRows.toLocaleString()} people). Lists over ${EXPORT_FILE_ROWS.toLocaleString()} split into files, with a pause between them so the database stays up.\n\nYou get every person — not a 20,000-row cutoff. Continue?`,
    );
  }
  if (estimatedRows > 3000) {
    return window.confirm(
      `This will download about ${estimatedRows.toLocaleString()} people` +
        (parts > 1
          ? ` in ${parts} files of ${EXPORT_FILE_ROWS.toLocaleString()} rows`
          : '') +
        `.\n\nPaging slowly is what keeps the database up. You still get the full list. Continue?`,
    );
  }
  return true;
}

function toSets(units: AbsenteeUnit[]): OverlapSet[] {
  return units.map((u, i) => ({
    key: u.key,
    label: u.short_label || u.label,
    short_label: u.short_label || u.label,
    color: UNIT_COLORS[i % UNIT_COLORS.length],
  }));
}

function asPetitionUnits(units: AbsenteeUnit[]): PetitionUnit[] {
  return units.map((u, i) => ({
    key: u.key,
    label: u.label,
    short_label: u.short_label,
    colorBit: u.elections[0]?.bit_index ?? i,
    group: u.group
      ? {
          id: u.group.id,
          slug: u.group.slug,
          label: u.group.label,
          short_label: u.group.short_label,
          sort_order: u.group.sort_order,
        }
      : null,
    petitions: u.elections.map((e) => ({
      id: e.id,
      slug: e.slug,
      label: e.label,
      short_label: e.short_label,
      bit_index: e.bit_index,
      sort_order: e.sort_order,
      is_default: e.is_default,
      is_active: e.is_active,
      group_id: e.group_id ?? null,
    })),
  }));
}

function readTab(): AbsenteeVennTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'elections' ? 'elections' : 'groups';
  } catch {
    return 'groups';
  }
}

function readElectionSlugs(fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(ELECTION_SLUGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const kept = parsed.filter((s): s is string => typeof s === 'string');
    return kept.length ? kept : fallback;
  } catch {
    return fallback;
  }
}

export function AbsenteeCombinations({
  elections,
  groups,
  selectedSlugs,
  onChangeSlugs,
  onSelectAll,
  onSelectDefaults,
  combos,
  onSelectCombo,
  onSelectExclusive,
  onSelectSuper,
  onExportNotice,
  onExportError,
}: Props) {
  const [tab, setTab] = useState<AbsenteeVennTab>(readTab);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportingKey, setExportingKey] = useState<string | number | null>(null);
  const [exportingAll, setExportingAll] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [electionSlugs, setElectionSlugs] = useState<string[]>(() =>
    readElectionSlugs(selectedSlugs.length ? selectedSlugs : elections.map((e) => e.slug)),
  );

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

  useEffect(() => {
    if (!elections.length) return;
    const valid = new Set(elections.map((e) => e.slug));
    setElectionSlugs((cur) => {
      const kept = cur.filter((s) => valid.has(s));
      const next = kept.length ? kept : elections.map((e) => e.slug);
      return next.join('\0') === cur.join('\0') ? cur : next;
    });
  }, [elections]);

  useEffect(() => {
    if (!electionSlugs.length) return;
    try {
      localStorage.setItem(ELECTION_SLUGS_KEY, JSON.stringify(electionSlugs));
    } catch {
      /* ignore */
    }
  }, [electionSlugs]);

  const groupSelected = useMemo(
    () => elections.filter((e) => selectedSlugs.includes(e.slug)),
    [elections, selectedSlugs],
  );
  const electionSelected = useMemo(
    () => elections.filter((e) => electionSlugs.includes(e.slug)),
    [elections, electionSlugs],
  );

  const groupUnits = useMemo(
    () =>
      resolveAbsenteeGroupUnits(
        groupSelected.length ? groupSelected : elections,
        groups,
      ),
    [groupSelected, elections, groups],
  );
  const electionUnits = useMemo(
    () => buildAbsenteeElectionUnits(electionSelected),
    [electionSelected],
  );

  const units = tab === 'groups' ? groupUnits : electionUnits;
  const overflow = units.length > 3;
  const collapsed = useMemo(
    () => collapseAbsenteeCombos(combos, units),
    [combos, units],
  );
  const sets = useMemo(() => toSets(units.slice(0, 3)), [units]);
  const petitionUnits = useMemo(() => asPetitionUnits(units), [units]);
  const comboRows = useMemo(
    () =>
      collapsed
        .map((c) => ({ mask: Number(c.mask), count: Number(c.count) || 0 }))
        .filter((c) => c.count > 0 && c.mask !== 0)
        .sort((a, b) => b.count - a.count || a.mask - b.mask),
    [collapsed],
  );
  const superCount = useMemo(
    () =>
      comboRows
        .filter((c) => {
          let bits = c.mask;
          let n = 0;
          while (bits) {
            bits &= bits - 1;
            n += 1;
          }
          return n >= 2;
        })
        .reduce((s, c) => s + c.count, 0),
    [comboRows],
  );

  const runExport = async (
    patch: Partial<VoterFilters>,
    filename: string,
    key: string | number,
    estimatedRows: number,
  ) => {
    if (!confirmAbsenteeExport(1, estimatedRows)) return;
    setExportingKey(key);
    setExportProgress(null);
    onExportError?.(null);
    onExportNotice?.(null);
    try {
      const { count, files } = await downloadVotersCsv({
        filters: { ...emptyFilters(), ...patch },
        filename,
        lean: true,
        onProgress: ({ rows, fileIndex }) => {
          setExportProgress(
            `${rows.toLocaleString()} rows` +
              (fileIndex > 1 ? ` · file ${fileIndex}` : ''),
          );
        },
      });
      void logActivity({
        action: 'export',
        entityType: 'voter',
        metadata: { label: filename, count, files },
      });
      if (files > 1) {
        onExportNotice?.(
          `Downloaded ${count.toLocaleString()} people in ${files} files.`,
        );
      }
    } catch (err) {
      onExportError?.(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExportingKey(null);
      setExportProgress(null);
    }
  };

  const pickerUnits = useMemo(() => {
    if (tab === 'groups') {
      return resolveAbsenteeGroupUnits(elections, groups).map((u) => ({
        key: u.key,
        label: u.short_label || u.label,
        grouped: u.elections.length > 1,
        children: u.elections.map((e) => ({
          slug: e.slug,
          label: e.short_label || e.label,
        })),
      }));
    }
    return elections.map((e) => ({
      key: e.slug,
      label: e.short_label || e.label,
      grouped: false,
      children: [{ slug: e.slug, label: e.short_label || e.label }],
    }));
  }, [tab, elections, groups]);

  if (!elections.length) {
    return (
      <p className="text-sm text-slate-500">
        Add elections above to compare who overlaps.
      </p>
    );
  }

  const activeSlugs = tab === 'groups' ? selectedSlugs : electionSlugs;
  const changeSlugs = tab === 'groups' ? onChangeSlugs : setElectionSlugs;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Who overlaps</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {tab === 'groups'
              ? overflow
                ? 'Each bar is a group. Same overflow as petition combinations when there are more than three.'
                : 'Each circle is a group (2022 / 2024 / 2026 unless you regroup).'
              : overflow
                ? 'Each bar is one election. More than three uses the same overflow as petition combinations.'
                : 'Each circle is one election.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <OverlapPicker
            noun="Elections"
            units={pickerUnits}
            selectedSlugs={activeSlugs}
            totalCount={elections.length}
            onChange={changeSlugs}
            onSelectAll={
              tab === 'groups'
                ? onSelectAll
                : () => setElectionSlugs(elections.map((e) => e.slug))
            }
            onSelectDefaults={
              tab === 'groups'
                ? onSelectDefaults
                : () => {
                    const defaults = elections
                      .filter((e) => e.is_default)
                      .map((e) => e.slug);
                    setElectionSlugs(
                      defaults.length ? defaults : elections.map((e) => e.slug),
                    );
                  }
            }
          />
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs"
            onClick={() => setExportOpen(true)}
          >
            Export
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={tab === 'groups' ? 'chip bg-brand-50 text-brand-800' : 'chip opacity-60'}
          onClick={() => setTab('groups')}
        >
          Groups
        </button>
        <button
          type="button"
          className={
            tab === 'elections' ? 'chip bg-brand-50 text-brand-800' : 'chip opacity-60'
          }
          onClick={() => setTab('elections')}
        >
          Each election
        </button>
      </div>

      {units.length === 0 ? (
        <p className="text-sm text-slate-500">Select at least one election.</p>
      ) : overflow ? (
        <PetitionOverlapBars
          units={petitionUnits}
          combos={combos}
          copy={OVERFLOW_COPY}
          onSelectUnitCombo={
            onSelectCombo ? (mask) => onSelectCombo(mask, units) : undefined
          }
          onSelectPetitionExclusive={
            onSelectExclusive
              ? (p) => {
                  const election = units
                    .flatMap((u) => u.elections)
                    .find((e) => e.slug === p.slug);
                  if (election) onSelectExclusive(election, units);
                }
              : undefined
          }
          onSelectSuperSigners={onSelectSuper ? () => onSelectSuper(units) : undefined}
          onExportCombo={(mask, count) => {
            void runExport(
              filtersForAbsenteeCombo(mask, units),
              absenteeComboFilename(mask, units),
              mask,
              count,
            );
          }}
        />
      ) : (
        <OverlapVenn
          sets={sets}
          combos={collapsed}
          onSelectCombo={onSelectCombo ? (mask) => onSelectCombo(mask, units) : undefined}
          title=""
          description="Exclusive combinations. Click a region to open that list in Search."
        />
      )}

      <AbsenteeExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        groupUnits={groupUnits}
        comboUnits={units}
        combos={collapsed}
        exportingKey={exportingKey}
        exportingAll={exportingAll}
        exportingProgress={exportProgress}
        onExportUnit={(unit) => {
          const idx = groupUnits.findIndex((u) => u.key === unit.key);
          void runExport(
            filtersForAbsenteeAny(unit.elections.map((e) => e.slug)),
            absenteeExportFilename(unit.short_label || unit.label),
            unit.key,
            idx >= 0 ? unionCountForAbsenteeUnit(combos, groupUnits, idx) : 0,
          );
        }}
        onExportElection={(election) => {
          void runExport(
            filtersForAbsenteeAny([election.slug]),
            absenteeExportFilename(election.short_label || election.label),
            `e:${election.slug}`,
            unionCountForAbsenteeUnit(
              combos,
              buildAbsenteeElectionUnits([election]),
              0,
            ),
          );
        }}
        superCount={superCount}
        onExportSuper={() => {
          void runExport(
            filtersForAbsenteeSuper(units),
            absenteeExportFilename('all-combinations'),
            'all-combos',
            superCount,
          );
        }}
        onExportSegment={(mask) => {
          const row = comboRows.find((c) => c.mask === mask);
          void runExport(
            filtersForAbsenteeCombo(mask, units),
            absenteeComboFilename(mask, units),
            mask,
            row?.count ?? 0,
          );
        }}
        onExportAll={() => {
          const rowTotal = comboRows.reduce((s, c) => s + c.count, 0);
          if (!comboRows.length) return;
          if (!confirmAbsenteeExport(comboRows.length, rowTotal)) return;
          setExportingAll(true);
          setExportProgress(null);
          onExportError?.(null);
          onExportNotice?.(null);
          void (async () => {
            try {
              let total = 0;
              let files = 0;
              for (let i = 0; i < comboRows.length; i++) {
                const row = comboRows[i];
                setExportingKey(row.mask);
                const result = await downloadVotersCsv({
                  filters: {
                    ...emptyFilters(),
                    ...filtersForAbsenteeCombo(row.mask, units),
                  },
                  filename: absenteeComboFilename(row.mask, units),
                  lean: true,
                  onProgress: ({ rows, fileIndex }) => {
                    setExportProgress(
                      `List ${i + 1}/${comboRows.length} · ${rows.toLocaleString()} rows` +
                        (fileIndex > 1 ? ` · file ${fileIndex}` : ''),
                    );
                  },
                });
                total += result.count;
                files += result.files;
                await sleep(1_200);
              }
              void logActivity({
                action: 'export',
                entityType: 'voter',
                metadata: {
                  label: `Absentee combo CSV (all ${comboRows.length})`,
                  count: total,
                  files,
                },
              });
              onExportNotice?.(
                `Downloaded ${total.toLocaleString()} people across ${comboRows.length} combinations (${files} files).`,
              );
            } catch (err) {
              onExportError?.(err instanceof Error ? err.message : 'Export failed');
            } finally {
              setExportingKey(null);
              setExportingAll(false);
              setExportProgress(null);
            }
          })();
        }}
      />
    </div>
  );
}
