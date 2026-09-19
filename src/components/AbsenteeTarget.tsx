import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { logActivity } from '../lib/activityLog';
import {
  absenteeExportFilename,
  countAbsenteeTarget,
  countAbsenteeTargetByParty,
  electionYearKey,
  filtersForAbsenteeTarget,
  resolveAbsenteeGroupUnits,
  type AbsenteeComboCount,
  type AbsenteeElection,
  type AbsenteeGroup,
  type AbsenteeMaskParty,
  type AbsenteeUnit,
} from '../lib/absentee';
import { fetchFilterOptions } from '../lib/api';
import { downloadVotersCsv } from '../lib/exportVotersCsv';
import { emptyFilters } from '../lib/filters';
import { usePetitions } from '../lib/petitions';
import { SUPPORT_SCORE_LABELS } from '../lib/supporterPresets';
import type { ExcludeRules, FilterAnyOfRule, VoterFilters } from '../lib/types';
import { Modal } from './ui';
import {
  FALLBACK_FILTER_OPTIONS,
  mergeOptions,
  type FilterOptions,
} from './VoterFiltersPanel';

type ExtraField =
  | 'party'
  | 'county'
  | 'signed'
  | 'alignment_label'
  | 'status'
  | 'supporter_tag'
  | 'support_score';

type ExtraOp = 'any_of' | 'is' | 'is_not' | 'is_set' | 'is_not_set';

type Join = 'and' | 'or';

type ExtraRule = {
  id: string;
  field: ExtraField;
  op: ExtraOp;
  values: string[];
  join: Join;
};

type ExtraGroup = { id: string; join: Join; rules: ExtraRule[] };

const EXTRA_FIELDS: { field: ExtraField; label: string }[] = [
  { field: 'party', label: 'Registered party' },
  { field: 'county', label: 'County' },
  { field: 'signed', label: 'Petition' },
  { field: 'alignment_label', label: 'Alignment' },
  { field: 'support_score', label: 'Support score' },
  { field: 'status', label: 'Voter status' },
  { field: 'supporter_tag', label: 'Supporter tag' },
];

const EXTRA_OPS: { value: ExtraOp; label: string }[] = [
  { value: 'any_of', label: 'is any of' },
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'is_set', label: 'is set' },
  { value: 'is_not_set', label: 'is not set' },
];

function mergeArr(prev: string[] | undefined, values: string[]) {
  return [...new Set([...(prev ?? []), ...values])];
}

function ruleActive(rule: ExtraRule) {
  return rule.op === 'is_set' || rule.op === 'is_not_set' || rule.values.length > 0;
}

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function newRule(partial?: Partial<ExtraRule>): ExtraRule {
  return {
    id: uid('r'),
    field: 'party',
    op: 'any_of',
    values: [],
    join: 'or',
    ...partial,
  };
}

function newGroup(partial?: Partial<ExtraGroup>): ExtraGroup {
  return { id: uid('g'), join: 'and', rules: [newRule()], ...partial };
}

type Props = {
  elections: AbsenteeElection[];
  groups: AbsenteeGroup[];
  combos?: AbsenteeComboCount[] | null;
  maskParty?: AbsenteeMaskParty[] | null;
  statusChart?: ReactNode;
  onSearch: (patch: Partial<VoterFilters>) => void;
  onNotice?: (message: string | null) => void;
  onError?: (message: string | null) => void;
};

function isGeneralElection(e: AbsenteeElection) {
  return /general/i.test(`${e.slug} ${e.label} ${e.short_label}`);
}

function latestYear(elections: AbsenteeElection[]) {
  return elections.reduce((year, e) => {
    const y = electionYearKey(e);
    return y > year ? y : year;
  }, '');
}

function defaults(elections: AbsenteeElection[]) {
  const generals = elections.filter(isGeneralElection);
  const pool = generals.length ? generals : elections;
  const latest = latestYear(pool);
  const target = pool.filter((e) => electionYearKey(e) === latest).map((e) => e.slug);
  const habit = elections.filter((e) => !target.includes(e.slug)).map((e) => e.slug);
  return { target, habit };
}

function pickedValues(rule: ExtraRule, allValues: (field: ExtraField) => string[]) {
  if (rule.op === 'is_set' || rule.op === 'is_not_set') {
    if (rule.field === 'signed' || rule.field === 'support_score') return [];
    return allValues(rule.field);
  }
  return rule.op === 'is' ? rule.values.slice(0, 1) : rule.values;
}

function applyRule(
  out: Partial<VoterFilters>,
  exclude: ExcludeRules,
  rule: ExtraRule,
  allValues: (field: ExtraField) => string[],
) {
  const values = pickedValues(rule, allValues);
  if (rule.op !== 'is_set' && rule.op !== 'is_not_set' && !values.length) return;
  if (
    (rule.op === 'is_set' || rule.op === 'is_not_set') &&
    rule.field !== 'signed' &&
    rule.field !== 'support_score' &&
    !values.length
  ) {
    return;
  }

  if (rule.field === 'signed') {
    if (rule.op === 'is_set') out.signed_any = true;
    else if (rule.op === 'is_not_set') {
      const slugs = allValues('signed');
      if (slugs.length) exclude.signed = mergeArr(exclude.signed, slugs);
    } else if (rule.op === 'is_not') exclude.signed = mergeArr(exclude.signed, values);
    else {
      out.signed = [];
      out.signed_min = 1;
      out.signed_min_of = mergeArr(out.signed_min_of, values);
    }
    return;
  }

  if (rule.field === 'support_score') {
    const nums = (rule.op === 'is_set' || rule.op === 'is_not_set' ? [1, 2, 3, 4, 5] : values)
      .map(Number)
      .filter(Number.isFinite);
    if (!nums.length) return;
    if (rule.op === 'any_of') {
      out.any_of = [...(out.any_of ?? []), { field: 'support_score', values: nums }];
    } else if (rule.op === 'is' || rule.op === 'is_set') {
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      out.support_score_min =
        out.support_score_min == null ? min : Math.min(out.support_score_min, min);
      out.support_score_max =
        out.support_score_max == null ? max : Math.max(out.support_score_max, max);
    } else {
      exclude.support_score_min =
        exclude.support_score_min == null
          ? Math.min(...nums)
          : Math.min(exclude.support_score_min, Math.min(...nums));
      exclude.support_score_max =
        exclude.support_score_max == null
          ? Math.max(...nums)
          : Math.max(exclude.support_score_max, Math.max(...nums));
    }
    return;
  }

  const reject = rule.op === 'is_not' || rule.op === 'is_not_set';
  if (rule.field === 'party') {
    if (reject) exclude.party = mergeArr(exclude.party, values);
    else out.party = mergeArr(out.party, values);
  } else if (rule.field === 'county') {
    if (reject) exclude.county = mergeArr(exclude.county, values);
    else out.county = mergeArr(out.county, values);
  } else if (rule.field === 'alignment_label') {
    if (reject) exclude.alignment_label = mergeArr(exclude.alignment_label, values);
    else out.alignment_label = mergeArr(out.alignment_label, values);
  } else if (rule.field === 'status') {
    if (reject) exclude.status = mergeArr(exclude.status, values);
    else out.status = mergeArr(out.status, values);
  } else if (rule.field === 'supporter_tag') {
    if (reject) exclude.supporter_tag = mergeArr(exclude.supporter_tag, values);
    else out.supporter_tag = mergeArr(out.supporter_tag, values);
  }
}

function toAnyOf(
  rule: ExtraRule,
  allValues: (field: ExtraField) => string[],
): FilterAnyOfRule | null {
  if (rule.op === 'is_not' || rule.op === 'is_not_set') return null;
  if (rule.field === 'signed' || rule.field === 'supporter_tag') return null;
  const values = pickedValues(rule, allValues);
  if (rule.field === 'support_score') {
    const nums = (rule.op === 'is_set' ? [1, 2, 3, 4, 5] : values)
      .map(Number)
      .filter(Number.isFinite);
    return nums.length ? { field: 'support_score', values: nums } : null;
  }
  if (!values.length) return null;
  if (
    rule.field === 'party' ||
    rule.field === 'county' ||
    rule.field === 'alignment_label' ||
    rule.field === 'status'
  ) {
    return { field: rule.field, values };
  }
  return null;
}

function extraPatch(
  groups: ExtraGroup[],
  allValues: (field: ExtraField) => string[],
): Partial<VoterFilters> {
  const out: Partial<VoterFilters> = {};
  const exclude: ExcludeRules = {};
  const anyOf: FilterAnyOfRule[] = [];

  type Clause = { join: Join; rules: ExtraRule[] };
  const clauses: Clause[] = [];
  for (const group of groups) {
    const active = group.rules.filter(ruleActive);
    if (!active.length) continue;
    const runs: ExtraRule[][] = [];
    let run: ExtraRule[] = [];
    active.forEach((rule, ri) => {
      if (ri > 0 && rule.join === 'and') {
        if (run.length) runs.push(run);
        run = [rule];
      } else {
        run.push(rule);
      }
    });
    if (run.length) runs.push(run);
    runs.forEach((rules, ri) => {
      clauses.push({
        join: clauses.length === 0 ? 'and' : ri === 0 ? group.join : 'and',
        rules,
      });
    });
  }

  const applyOr = (rules: ExtraRule[]) => {
    for (const rule of rules) {
      const next = toAnyOf(rule, allValues);
      if (next) anyOf.push(next);
      else applyRule(out, exclude, rule, allValues);
    }
  };

  for (const clause of clauses) {
    const orClause = clause.join === 'or' || clause.rules.length > 1;
    if (orClause) applyOr(clause.rules);
    else applyRule(out, exclude, clause.rules[0], allValues);
  }

  if (anyOf.length) out.any_of = [...(out.any_of ?? []), ...anyOf];
  if (Object.keys(exclude).length) out.exclude = exclude;
  return out;
}

function labelsFor(elections: AbsenteeElection[], slugs: string[]) {
  return elections
    .filter((e) => slugs.includes(e.slug))
    .map((e) => e.short_label || e.label);
}

export function AbsenteeTarget({
  elections,
  groups,
  combos,
  maskParty,
  statusChart,
  onSearch,
  onNotice,
  onError,
}: Props) {
  const units = useMemo(
    () => resolveAbsenteeGroupUnits(elections, groups),
    [elections, groups],
  );
  const { activePetitions } = usePetitions();
  const [options, setOptions] = useState<FilterOptions>(FALLBACK_FILTER_OPTIONS);
  const [targetSlugs, setTargetSlugs] = useState<string[]>(() => defaults(elections).target);
  const [habitSlugs, setHabitSlugs] = useState<string[]>(() => defaults(elections).habit);
  const [minN, setMinN] = useState(2);
  const [editOpen, setEditOpen] = useState(false);
  const [draftTarget, setDraftTarget] = useState<string[]>([]);
  const [draftHabit, setDraftHabit] = useState<string[]>([]);
  const [draftMin, setDraftMin] = useState(2);
  const [extraGroups, setExtraGroups] = useState<ExtraGroup[]>([]);
  const [appliedGroups, setAppliedGroups] = useState<ExtraGroup[]>([]);
  const [exporting, setExporting] = useState(false);
  const [progressRows, setProgressRows] = useState(0);

  useEffect(() => {
    void fetchFilterOptions()
      .then((data) => setOptions(mergeOptions(data)))
      .catch(() => setOptions(FALLBACK_FILTER_OPTIONS));
  }, []);

  useEffect(() => {
    if (!elections.length) return;
    const valid = new Set(elections.map((e) => e.slug));
    const seed = defaults(elections);
    const latest = latestYear(elections);
    const oldDefault = elections
      .filter((e) => electionYearKey(e) === latest)
      .map((e) => e.slug);
    const sameSet = (a: string[], b: string[]) =>
      a.length === b.length && a.every((s) => b.includes(s));
    setTargetSlugs((cur) => {
      const kept = cur.filter((s) => valid.has(s));
      if (!kept.length || sameSet(kept, oldDefault)) return seed.target;
      return kept;
    });
    setHabitSlugs((cur) => {
      const kept = cur.filter((s) => valid.has(s));
      if (!kept.length || sameSet(kept, elections.map((e) => e.slug).filter((s) => !oldDefault.includes(s)))) {
        return seed.habit;
      }
      return kept;
    });
  }, [elections]);

  const habitElections = elections.filter((e) => habitSlugs.includes(e.slug));
  const targetElections = elections.filter((e) => targetSlugs.includes(e.slug));
  const maxMin = Math.max(1, habitSlugs.length);
  const need = Math.min(Math.max(1, minN), maxMin);
  const estimate = countAbsenteeTarget(combos, habitElections, targetElections, need);

  const valuesFor = (field: ExtraField) => {
    if (field === 'party') return options.parties.map((v) => ({ value: v, label: v }));
    if (field === 'county') return options.counties.map((v) => ({ value: v, label: v }));
    if (field === 'signed') {
      return activePetitions.map((p) => ({
        value: p.slug,
        label: p.short_label || p.label,
      }));
    }
    if (field === 'alignment_label') {
      return options.alignment_labels.map((v) => ({ value: v, label: v }));
    }
    if (field === 'status') return options.statuses.map((v) => ({ value: v, label: v }));
    if (field === 'supporter_tag') {
      return ['supporter', 'maybe', 'opposed'].map((v) => ({ value: v, label: v }));
    }
    return [1, 2, 3, 4, 5].map((n) => ({
      value: String(n),
      label: SUPPORT_SCORE_LABELS[n] ?? String(n),
    }));
  };

  const extra = extraPatch(extraGroups, (field) => valuesFor(field).map((c) => c.value));
  const appliedExtra = extraPatch(appliedGroups, (field) =>
    valuesFor(field).map((c) => c.value),
  );
  const base = filtersForAbsenteeTarget(habitSlugs, targetSlugs, need);
  const patch: Partial<VoterFilters> = {
    ...base,
    ...extra,
    exclude: { ...base.exclude, ...extra.exclude },
  };
  const appliedFields = appliedGroups.flatMap((g) =>
    g.rules.filter(ruleActive).map((r) => r.field),
  );
  const partyOnly =
    appliedFields.length > 0 && appliedFields.every((f) => f === 'party');
  const peopleCount =
    partyOnly && (maskParty?.length ?? 0)
      ? countAbsenteeTargetByParty(
          maskParty,
          habitElections,
          targetElections,
          need,
          appliedExtra.party ?? [],
          appliedExtra.exclude?.party ?? [],
        )
      : estimate;

  const openEdit = () => {
    setDraftTarget(targetSlugs);
    setDraftHabit(habitSlugs);
    setDraftMin(minN);
    setEditOpen(true);
  };

  const applyEdit = () => {
    setTargetSlugs(draftTarget);
    setHabitSlugs(draftHabit);
    setMinN(draftMin);
    setEditOpen(false);
  };

  const exportList = async () => {
    if (!habitSlugs.length || !targetSlugs.length) return;
    if (peopleCount > 3000) {
      const ok = window.confirm(
        `This will download about ${peopleCount.toLocaleString()} people in one CSV. Extra filters apply on the download. Continue?`,
      );
      if (!ok) return;
    }
    setExporting(true);
    setProgressRows(0);
    onError?.(null);
    onNotice?.(null);
    try {
      const { count, files } = await downloadVotersCsv({
        filters: { ...emptyFilters(), ...patch },
        filename: absenteeExportFilename('target-not-requested'),
        lean: true,
        splitEvery: null,
        onProgress: ({ rows }) => setProgressRows(rows),
      });
      void logActivity({
        action: 'export',
        entityType: 'voter',
        metadata: { label: 'Absentee target list', count, files },
      });
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
      setProgressRows(0);
    }
  };

  if (!elections.length) {
    return (
      <p className="px-4 py-3 text-sm text-slate-500">Add elections to build a target list.</p>
    );
  }

  const habitLabels = labelsFor(elections, habitSlugs);
  const targetLabels = labelsFor(elections, targetSlugs);
  const draftMax = Math.max(1, draftHabit.length);
  const draftNeed = Math.min(Math.max(1, draftMin), draftMax);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">Target</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Habitual absentees who have not requested in the elections you exclude.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-2xl font-semibold leading-none tabular-nums text-slate-900">
              {peopleCount.toLocaleString()}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">people</p>
          </div>
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-xs"
            disabled={!habitSlugs.length || !targetSlugs.length}
            onClick={() => onSearch(patch)}
          >
            Open in Search
          </button>
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs"
            disabled={exporting || !habitSlugs.length || !targetSlugs.length}
            onClick={() => void exportList()}
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>
      {exporting ? (
        <div className="border-b border-slate-100 px-4 py-2.5">
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-brand-600 transition-all"
              style={{
                width: `${
                  peopleCount
                    ? Math.min(100, (100 * progressRows) / peopleCount)
                    : 8
                }%`,
              }}
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {progressRows.toLocaleString()}
            {peopleCount ? ` of ${peopleCount.toLocaleString()}` : ''} people
          </p>
        </div>
      ) : null}

      <div className="grid lg:grid-cols-2">
        <div className="border-b border-slate-100 px-4 py-3 lg:border-b-0 lg:border-r">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Elections
            </p>
            <button
              type="button"
              className="text-xs font-medium text-brand-700 hover:underline"
              onClick={openEdit}
            >
              Edit elections
            </button>
          </div>
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-medium text-slate-500">Have not requested in</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {targetLabels.length ? (
                  targetLabels.map((label) => (
                    <span key={label} className="chip">
                      {label}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-slate-400">None selected</span>
                )}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-500">
                Requested regularly
                {habitLabels.length ? ` · at least ${need} of ${habitLabels.length}` : ''}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {habitLabels.length ? (
                  habitLabels.map((label) => (
                    <span key={label} className="chip">
                      {label}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-slate-400">None selected</span>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="border-b border-slate-100 px-4 py-3">
          {statusChart}
        </div>
      </div>

      <FilterGroup title="Further filters">
        {extraGroups.length === 0 ? (
          <p className="px-4 py-2 text-xs text-slate-400">
            Optional. Narrow by party, petitions, and other voter fields.
          </p>
        ) : null}
        {extraGroups.map((group, gi) => {
          const grouped = group.rules.length > 1;
          return (
            <div key={group.id} className={gi > 0 ? 'mt-1' : ''}>
              {gi > 0 && grouped ? (
                <div className="px-3">
                  <JoinSelect
                    value={group.join}
                    onChange={(join) =>
                      setExtraGroups((cur) =>
                        cur.map((g) => (g.id === group.id ? { ...g, join } : g)),
                      )
                    }
                  />
                </div>
              ) : null}
              <div className={grouped ? 'mx-3 mb-1 flex rounded-md border border-slate-100' : ''}>
                {grouped ? (
                  <div className="flex w-12 shrink-0 flex-col items-center py-2">
                    <span className="text-[11px] font-semibold text-slate-400">Where</span>
                    <span className="mt-1 w-px flex-1 bg-slate-200" />
                  </div>
                ) : null}
                <div className="min-w-0 flex-1">
                  {group.rules.map((rule, ri) => {
                    const needsValue = rule.op !== 'is_set' && rule.op !== 'is_not_set';
                    const connector =
                      ri > 0 ? (
                        <JoinSelect
                          value={rule.join}
                          onChange={(join) =>
                            setExtraGroups((cur) =>
                              cur.map((g) =>
                                g.id !== group.id
                                  ? g
                                  : {
                                      ...g,
                                      rules: g.rules.map((r) =>
                                        r.id === rule.id ? { ...r, join } : r,
                                      ),
                                    },
                              ),
                            )
                          }
                        />
                      ) : gi > 0 && !grouped ? (
                        <JoinSelect
                          value={group.join}
                          onChange={(join) =>
                            setExtraGroups((cur) =>
                              cur.map((g) => (g.id === group.id ? { ...g, join } : g)),
                            )
                          }
                        />
                      ) : (
                        ''
                      );
                    return (
                      <FilterRow
                        key={rule.id}
                        connector={connector}
                        linked={grouped}
                        onLink={() => {
                          if (grouped) {
                            setExtraGroups((cur) =>
                              cur.flatMap((g) => {
                                if (g.id !== group.id) return [g];
                                const left = g.rules.filter((r) => r.id !== rule.id);
                                const moved = newGroup({
                                  join: 'and',
                                  rules: [{ ...rule, join: 'or' }],
                                });
                                return left.length ? [{ ...g, rules: left }, moved] : [moved];
                              }),
                            );
                          } else {
                            setExtraGroups((cur) =>
                              cur.map((g) =>
                                g.id === group.id
                                  ? { ...g, rules: [...g.rules, newRule({ join: 'or' })] }
                                  : g,
                              ),
                            );
                          }
                        }}
                        field={
                          <select
                            className="input w-40 shrink-0 py-1.5 text-sm"
                            value={rule.field}
                            onChange={(e) => {
                              const field = e.target.value as ExtraField;
                              setExtraGroups((cur) =>
                                cur.map((g) =>
                                  g.id !== group.id
                                    ? g
                                    : {
                                        ...g,
                                        rules: g.rules.map((r) =>
                                          r.id === rule.id ? { ...r, field, values: [] } : r,
                                        ),
                                      },
                                ),
                              );
                            }}
                          >
                            {EXTRA_FIELDS.map((f) => (
                              <option key={f.field} value={f.field}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                        }
                        operator={
                          <select
                            className="input w-28 shrink-0 py-1.5 text-sm"
                            value={rule.op}
                            onChange={(e) => {
                              const op = e.target.value as ExtraOp;
                              setExtraGroups((cur) =>
                                cur.map((g) =>
                                  g.id !== group.id
                                    ? g
                                    : {
                                        ...g,
                                        rules: g.rules.map((r) => {
                                          if (r.id !== rule.id) return r;
                                          let values = r.values;
                                          if (op === 'is') values = values.slice(0, 1);
                                          if (op === 'is_set' || op === 'is_not_set') values = [];
                                          return { ...r, op, values };
                                        }),
                                      },
                                ),
                              );
                            }}
                          >
                            {EXTRA_OPS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        }
                        onRemove={() =>
                          setExtraGroups((cur) =>
                            cur.flatMap((g) => {
                              if (g.id !== group.id) return [g];
                              const rules = g.rules.filter((r) => r.id !== rule.id);
                              return rules.length ? [{ ...g, rules }] : [];
                            }),
                          )
                        }
                      >
                        {needsValue ? (
                          <ValuePicker
                            noun="option"
                            multiple={rule.op !== 'is'}
                            choices={valuesFor(rule.field)}
                            selected={rule.values}
                            onChange={(values) =>
                              setExtraGroups((cur) =>
                                cur.map((g) =>
                                  g.id !== group.id
                                    ? g
                                    : {
                                        ...g,
                                        rules: g.rules.map((r) =>
                                          r.id === rule.id ? { ...r, values } : r,
                                        ),
                                      },
                                ),
                              )
                            }
                          />
                        ) : (
                          <span className="min-w-0 flex-1 text-sm text-slate-400" />
                        )}
                      </FilterRow>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
        <div className="flex items-center justify-between px-4 py-2">
          <button
            type="button"
            className="text-xs font-medium text-brand-700 hover:underline"
            onClick={() => setExtraGroups((cur) => [...cur, newGroup({ join: 'and' })])}
          >
            + Add filter
          </button>
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs"
            disabled={!habitSlugs.length || !targetSlugs.length}
            onClick={() => setAppliedGroups(extraGroups)}
          >
            Apply
          </button>
        </div>
      </FilterGroup>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        wide
        title="Edit elections"
        description="Check who has not requested yet, and which past elections count as regular. An election cannot be on both sides."
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <ElectionChecks
              title="Have not requested in"
              units={units}
              selected={new Set(draftTarget)}
              onToggle={(slug) => {
                setDraftTarget((cur) =>
                  cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug],
                );
                setDraftHabit((cur) => cur.filter((s) => s !== slug));
              }}
              onToggleGroup={(slugs) => {
                const allOn = slugs.every((s) => draftTarget.includes(s));
                if (allOn) {
                  setDraftTarget((cur) => cur.filter((s) => !slugs.includes(s)));
                } else {
                  setDraftTarget((cur) => [...new Set([...cur, ...slugs])]);
                  setDraftHabit((cur) => cur.filter((s) => !slugs.includes(s)));
                }
              }}
            />
            <ElectionChecks
              title="Requested regularly in"
              units={units}
              selected={new Set(draftHabit)}
              onToggle={(slug) => {
                setDraftHabit((cur) =>
                  cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug],
                );
                setDraftTarget((cur) => cur.filter((s) => s !== slug));
              }}
              onToggleGroup={(slugs) => {
                const allOn = slugs.every((s) => draftHabit.includes(s));
                if (allOn) {
                  setDraftHabit((cur) => cur.filter((s) => !slugs.includes(s)));
                } else {
                  setDraftHabit((cur) => [...new Set([...cur, ...slugs])]);
                  setDraftTarget((cur) => cur.filter((s) => !slugs.includes(s)));
                }
              }}
            />
          </div>
          <label className="block max-w-[14rem]">
            <span className="label">At least this many past elections</span>
            <select
              className="input"
              value={draftNeed}
              onChange={(e) => setDraftMin(Number(e.target.value))}
              disabled={!draftHabit.length}
            >
              {Array.from({ length: draftMax }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} of {draftHabit.length}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setEditOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!draftTarget.length || !draftHabit.length}
              onClick={applyEdit}
            >
              Save elections
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ElectionChecks({
  title,
  units,
  selected,
  onToggle,
  onToggleGroup,
}: {
  title: string;
  units: AbsenteeUnit[];
  selected: Set<string>;
  onToggle: (slug: string) => void;
  onToggleGroup: (slugs: string[]) => void;
}) {
  return (
    <div>
      <p className="label">{title}</p>
      <ul className="mt-1 space-y-1 rounded-md border border-slate-200 p-2">
        {units.map((unit) => {
          const slugs = unit.elections.map((e) => e.slug);
          const onCount = slugs.filter((s) => selected.has(s)).length;
          const allOn = onCount === slugs.length && slugs.length > 0;
          const someOn = onCount > 0 && !allOn;
          const grouped = unit.elections.length > 1;
          return (
            <li key={unit.key}>
              {grouped ? (
                <>
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
                    <input
                      type="checkbox"
                      checked={allOn}
                      ref={(el) => {
                        if (el) el.indeterminate = someOn;
                      }}
                      onChange={() => onToggleGroup(slugs)}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="truncate">{unit.short_label || unit.label}</span>
                  </label>
                  <ul className="ml-6 mt-0.5 space-y-0.5">
                    {unit.elections.map((e) => (
                      <li key={e.slug}>
                        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
                          <input
                            type="checkbox"
                            checked={selected.has(e.slug)}
                            onChange={() => onToggle(e.slug)}
                            className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                          />
                          <span className="truncate">{e.short_label || e.label}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={selected.has(unit.elections[0].slug)}
                    onChange={() => onToggle(unit.elections[0].slug)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="truncate">
                    {unit.elections[0].short_label || unit.elections[0].label}
                  </span>
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-4 py-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </p>
      </div>
      <div className="border-t border-slate-100">{children}</div>
    </div>
  );
}

function JoinSelect({
  value,
  onChange,
}: {
  value: Join;
  onChange: (next: Join) => void;
}) {
  return (
    <select
      className="w-14 shrink-0 cursor-pointer border-0 bg-transparent py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 focus:ring-0"
      value={value}
      onChange={(e) => onChange(e.target.value as Join)}
    >
      <option value="and">AND</option>
      <option value="or">OR</option>
    </select>
  );
}

function FilterRow({
  connector,
  field,
  operator,
  onRemove,
  onLink,
  linked,
  children,
}: {
  connector: ReactNode;
  field: ReactNode;
  operator: ReactNode;
  onRemove?: () => void;
  onLink?: () => void;
  linked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0">
      <span className="flex w-14 shrink-0 items-center text-[11px] font-semibold text-slate-400">
        {connector}
      </span>
      {field}
      {operator}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {onLink ? (
        <button
          type="button"
          className={`shrink-0 rounded p-1 ${
            linked ? 'text-slate-600 hover:bg-slate-100' : 'text-slate-300 hover:text-slate-500'
          }`}
          onClick={onLink}
          aria-label={linked ? 'Ungroup filter' : 'Group with OR'}
          title={linked ? 'Ungroup' : 'Group with OR'}
        >
          <LinkGlyph linked={!!linked} />
        </button>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="shrink-0 px-1 text-lg leading-none text-slate-400 hover:text-slate-700"
          onClick={onRemove}
          aria-label="Remove filter"
        >
          ×
        </button>
      ) : (
        <span className="w-5 shrink-0" />
      )}
    </div>
  );
}

function LinkGlyph({ linked }: { linked: boolean }) {
  return linked ? (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

function ValuePicker({
  noun,
  choices,
  selected,
  onChange,
  multiple = true,
}: {
  noun: string;
  choices: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const picked = choices.filter((c) => selected.includes(c.value));
  const q = query.trim().toLowerCase();
  const shown = q
    ? choices.filter(
        (c) => c.label.toLowerCase().includes(q) || c.value.toLowerCase().includes(q),
      )
    : choices;

  const pick = (value: string) => {
    if (!multiple) {
      onChange([value]);
      setOpen(false);
      setQuery('');
      input.current?.blur();
      return;
    }
    onChange(
      selected.includes(value)
        ? selected.filter((s) => s !== value)
        : [...selected, value],
    );
    setQuery('');
  };

  return (
    <div ref={root} className="relative min-w-0 flex-1">
      <div
        className="input flex min-h-[34px] w-full cursor-text flex-wrap items-center gap-1 py-1"
        onClick={() => input.current?.focus()}
      >
        {picked.map((c) => (
          <span
            key={c.value}
            className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700"
          >
            {c.label}
            <button
              type="button"
              className="text-slate-400 hover:text-slate-700"
              aria-label={`Remove ${c.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(selected.filter((s) => s !== c.value));
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          className="min-w-[6rem] flex-1 border-0 bg-transparent p-0 text-sm outline-none focus:ring-0"
          value={query}
          placeholder={picked.length ? '' : `Select ${noun}`}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setOpen(true);
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              setQuery('');
              input.current?.blur();
            }
            if (e.key === 'Backspace' && !query && selected.length) {
              onChange(selected.slice(0, -1));
            }
            if (e.key === 'Enter' && shown[0]) {
              e.preventDefault();
              pick(shown[0].value);
              setQuery('');
            }
          }}
        />
      </div>
      {open ? (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white p-2 shadow-lg">
          {shown.length ? (
            shown.map((c) => (
              <label
                key={c.value}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50"
              >
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  name={multiple ? undefined : noun}
                  checked={selected.includes(c.value)}
                  onChange={() => pick(c.value)}
                  className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                <span className="truncate">{c.label}</span>
              </label>
            ))
          ) : (
            <p className="px-1 py-1 text-sm text-slate-400">No matches</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
