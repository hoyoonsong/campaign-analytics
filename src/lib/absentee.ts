import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VoterFilters } from './types';

export const ABSENTEE_STATUSES = [
  'REQUESTED',
  'ISSUED',
  'MAILED',
  'RETURNED',
  'ACCEPTED',
  'REJECTED',
  'CANCELLED',
  'UNKNOWN',
] as const;

export type AbsenteeStatus = (typeof ABSENTEE_STATUSES)[number];

export type AbsenteeElection = {
  id: number;
  slug: string;
  label: string;
  short_label: string;
  bit_index: number;
  sort_order: number;
  is_default: boolean;
  is_active: boolean;
  group_id?: number | null;
};

export type AbsenteeGroup = {
  id: number;
  slug: string;
  label: string;
  short_label: string;
  sort_order: number;
};

export type AbsenteeBallot = {
  voter_id: number;
  election_id: number;
  election_slug: string;
  status: AbsenteeStatus | string;
  requested_at?: string | null;
  issued_at?: string | null;
  returned_at?: string | null;
  party?: string | null;
  county?: string | null;
  age?: number | null;
  signed_mask?: number | null;
};

export const ABSENTEE_STATUS_LABELS: Record<string, string> = {
  REQUESTED: 'Requested',
  ISSUED: 'Issued',
  MAILED: 'Mailed',
  RETURNED: 'Returned',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  UNKNOWN: 'Unknown',
};

export const ABSENTEE_STATUS_COLORS: Record<string, string> = {
  REQUESTED: '#7c3aed',
  ISSUED: '#2563eb',
  MAILED: '#0891b2',
  RETURNED: '#059669',
  ACCEPTED: '#047857',
  REJECTED: '#dc2626',
  CANCELLED: '#64748b',
  UNKNOWN: '#94a3b8',
};

export function absenteeStatusLabel(status: string): string {
  return ABSENTEE_STATUS_LABELS[status] ?? status;
}

const SELECTION_KEY = 'absentee_selection_v1';
const LABEL_CACHE = new Map<string, string>();

export function setAbsenteeLabelCache(elections: AbsenteeElection[]) {
  LABEL_CACHE.clear();
  for (const e of elections) LABEL_CACHE.set(e.slug, e.label);
}

export function absenteeLabel(slug: string): string {
  return LABEL_CACHE.get(slug) ?? slug;
}

function readStoredSlugs(): string[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((s) => typeof s === 'string');
  } catch {
    return null;
  }
}

type AbsenteeCache = AbsenteeDashboard;
let absenteeMemory: AbsenteeCache | null = null;
let absenteeInflight: Promise<AbsenteeCache> | null = null;

async function loadAbsenteeShared(force = false): Promise<AbsenteeCache> {
  if (!force && absenteeMemory) return absenteeMemory;
  if (force) {
    absenteeMemory = null;
    absenteeInflight = null;
  }
  if (!absenteeInflight) {
    absenteeInflight = import('./api')
      .then(({ fetchAbsenteeDashboard }) => fetchAbsenteeDashboard({ force }))
      .then((data) => {
        const next = normalizeAbsenteeDashboard(data);
        absenteeMemory = next;
        setAbsenteeLabelCache(next.elections.filter((e) => e.is_active));
        return next;
      })
      .finally(() => {
        absenteeInflight = null;
      });
  }
  return absenteeInflight;
}

export function useAbsenteeElections() {
  const [elections, setElections] = useState<AbsenteeElection[]>(
    () => absenteeMemory?.elections ?? [],
  );
  const [groups, setGroups] = useState<AbsenteeGroup[]>(
    () => absenteeMemory?.groups ?? [],
  );
  const [summary, setSummary] = useState<AbsenteeDashboard | null>(
    () => absenteeMemory,
  );
  const [loading, setLoading] = useState(!absenteeMemory);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    absenteeMemory = null;
    setLoading(true);
    void loadAbsenteeShared(true)
      .then((data) => {
        setElections(data.elections);
        setGroups(data.groups ?? []);
        setSummary(data);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (absenteeMemory) {
      setElections(absenteeMemory.elections);
      setGroups(absenteeMemory.groups ?? []);
      setSummary(absenteeMemory);
      setLoading(false);
      return;
    }
    void loadAbsenteeShared()
      .then((data) => {
        setElections(data.elections);
        setGroups(data.groups ?? []);
        setSummary(data);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const addLocal = useCallback((row: AbsenteeElection) => {
    LABEL_CACHE.set(row.slug, row.label);
    setElections((cur) => {
      const hit = cur.findIndex((e) => e.id === row.id || e.slug === row.slug);
      const next =
        hit >= 0 ? cur.map((e, i) => (i === hit ? { ...e, ...row } : e)) : [...cur, row];
      const dash = absenteeMemory
        ? { ...absenteeMemory, elections: next }
        : emptyAbsenteeDashboard(next);
      absenteeMemory = dash;
      setSummary(dash);
      return next;
    });
  }, []);

  const activeElections = useMemo(
    () => elections.filter((e) => e.is_active),
    [elections],
  );

  return {
    elections,
    activeElections,
    groups,
    summary,
    loading,
    error,
    reload,
    addLocal,
  };
}

export function useAbsenteeDashboard(slugs: string[], hydrated: boolean) {
  const shared = useAbsenteeElections();
  const [scoped, setScoped] = useState<AbsenteeDashboard | null>(null);
  const [scopedLoading, setScopedLoading] = useState(false);

  useEffect(() => {
    if (!hydrated || !shared.activeElections.length) return;
    const allSelected =
      slugs.length === shared.activeElections.length &&
      shared.activeElections.every((e) => slugs.includes(e.slug));
    if (allSelected) {
      setScoped(null);
      return;
    }
    if (slugs.length === 0) {
      setScoped(emptyAbsenteeDashboard(shared.elections));
      return;
    }
    let cancelled = false;
    setScopedLoading(true);
    void import('./api')
      .then(({ fetchAbsenteeDashboard }) => fetchAbsenteeDashboard({ slugs }))
      .then((data) => {
        if (!cancelled) setScoped(normalizeAbsenteeDashboard(data));
      })
      .finally(() => {
        if (!cancelled) setScopedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, slugs, shared.activeElections, shared.elections]);

  return {
    ...shared,
    summary: scoped ?? shared.summary,
    loading: shared.loading || scopedLoading,
  };
}

export function useSelectedElections(all: AbsenteeElection[]) {
  const defaults = useMemo(
    () => all.filter((e) => e.is_default).map((e) => e.slug),
    [all],
  );
  const [slugs, setSlugs] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!all.length) return;
    const stored = readStoredSlugs();
    const valid = new Set(all.map((e) => e.slug));
    if (stored?.length) {
      const kept = stored.filter((s) => valid.has(s));
      setSlugs(kept.length ? kept : defaults.length ? defaults : all.map((e) => e.slug));
    } else {
      setSlugs(defaults.length ? defaults : all.map((e) => e.slug));
    }
    setHydrated(true);
  }, [all, defaults]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(SELECTION_KEY, JSON.stringify(slugs));
    } catch {
      /* ignore */
    }
  }, [hydrated, slugs]);

  const selected = useMemo(
    () => all.filter((e) => slugs.includes(e.slug)),
    [all, slugs],
  );

  const toggle = useCallback((slug: string) => {
    setSlugs((cur) =>
      cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug],
    );
  }, []);

  return { slugs, selected, setSlugs, toggle, hydrated };
}

export type AbsenteeHeadline = {
  total: number;
  requestedNotReturned: number;
  returned: number;
  accepted: number;
  rejected: number;
};

export type StatusBarPoint = {
  key: string;
  label: string;
  REQUESTED: number;
  ISSUED: number;
  MAILED: number;
  RETURNED: number;
  ACCEPTED: number;
  REJECTED: number;
  CANCELLED: number;
  UNKNOWN: number;
};

export type CountRow = { name: string; count: number };

export type AbsenteeHeadlineSql = {
  unique_voters: number;
  rows: number;
  requested_not_returned: number;
  returned: number;
  accepted: number;
  rejected: number;
};

export type AbsenteeElectionCounts = {
  id: number;
  slug: string;
  label: string;
  short_label: string;
  unique_voters?: number;
  REQUESTED: number;
  ISSUED: number;
  MAILED: number;
  RETURNED: number;
  ACCEPTED: number;
  REJECTED: number;
  CANCELLED: number;
  UNKNOWN: number;
};

export type AbsenteeComboCount = { mask: number; count: number };

export type AbsenteeMaskParty = { mask: number; party: string; count: number };

export type AbsenteeDashboard = {
  elections: AbsenteeElection[];
  groups: AbsenteeGroup[];
  headline: AbsenteeHeadlineSql;
  by_election: AbsenteeElectionCounts[];
  by_county: CountRow[];
  by_party: CountRow[];
  petition_overlap: PetitionOverlapRow[];
  combos: AbsenteeComboCount[];
  mask_party: AbsenteeMaskParty[];
};

export type AbsenteeUnit = {
  key: string;
  label: string;
  short_label: string;
  elections: AbsenteeElection[];
  group: AbsenteeGroup | null;
};

function asId(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function electionYearKey(e: AbsenteeElection): string {
  return (
    e.slug.match(/(19|20)\d{2}/)?.[0] ??
    e.label.match(/(19|20)\d{2}/)?.[0] ??
    'Other'
  );
}

export function buildAbsenteeUnits(
  elections: AbsenteeElection[],
  groups: AbsenteeGroup[],
): AbsenteeUnit[] {
  const groupById = new Map(
    groups.map((g) => [asId(g.id), { ...g, id: asId(g.id) }]),
  );
  const members = new Map<number, AbsenteeElection[]>();
  for (const e of elections) {
    const gid = asId(e.group_id);
    if (gid && groupById.has(gid)) {
      const arr = members.get(gid) ?? [];
      arr.push(e);
      members.set(gid, arr);
    }
  }
  const units: AbsenteeUnit[] = [];
  const seen = new Set<number>();
  for (const e of elections) {
    const gid = asId(e.group_id);
    if (gid && groupById.has(gid)) {
      if (seen.has(gid)) continue;
      seen.add(gid);
      const g = groupById.get(gid)!;
      units.push({
        key: `g:${g.id}`,
        label: g.label,
        short_label: g.short_label,
        group: g,
        elections: members.get(gid) ?? [e],
      });
    } else {
      units.push({
        key: `e:${asId(e.id)}`,
        label: e.label,
        short_label: e.short_label,
        group: null,
        elections: [e],
      });
    }
  }
  return units;
}

export function buildAbsenteeUnitsByYear(elections: AbsenteeElection[]): AbsenteeUnit[] {
  const buckets = new Map<string, AbsenteeElection[]>();
  for (const e of elections) {
    const key = electionYearKey(e);
    const list = buckets.get(key) ?? [];
    list.push(e);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, members]) => ({
      key: `year:${year}`,
      label: year,
      short_label: year,
      group: {
        id: Number(year) || 0,
        slug: `year_${year}`,
        label: year,
        short_label: year,
        sort_order: Number(year) || 0,
      },
      elections: members,
    }));
}

export function buildAbsenteeElectionUnits(elections: AbsenteeElection[]): AbsenteeUnit[] {
  return elections.map((e) => ({
    key: `e:${asId(e.id)}`,
    label: e.short_label || e.label,
    short_label: e.short_label || e.label,
    group: null,
    elections: [e],
  }));
}

export function resolveAbsenteeGroupUnits(
  elections: AbsenteeElection[],
  groups: AbsenteeGroup[],
): AbsenteeUnit[] {
  const fromDb = buildAbsenteeUnits(elections, groups).filter((u) => u.group);
  return fromDb.length ? fromDb : buildAbsenteeUnitsByYear(elections);
}

export function collapseAbsenteeCombos(
  combos: AbsenteeComboCount[] | null | undefined,
  units: AbsenteeUnit[],
): AbsenteeComboCount[] {
  const unitMasks = units.map((u) =>
    u.elections.reduce((m, e) => m | (1 << e.bit_index), 0),
  );
  const map = new Map<number, number>();
  for (const c of combos ?? []) {
    const orig = Number(c.mask);
    let um = 0;
    unitMasks.forEach((m, i) => {
      if ((orig & m) !== 0) um |= 1 << i;
    });
    if (um === 0) continue;
    map.set(um, (map.get(um) ?? 0) + Number(c.count));
  }
  return [...map.entries()].map(([mask, count]) => ({ mask, count }));
}

export function filtersForAbsenteeAny(slugs: string[]): Partial<VoterFilters> {
  if (slugs.length <= 1) {
    return { absentee: slugs, absentee_min: null, absentee_min_of: [] };
  }
  return { absentee: [], absentee_min: 1, absentee_min_of: slugs };
}

export function absenteeComboLabel(mask: number, units: AbsenteeUnit[]): string {
  const hits = units.filter((_, i) => (mask & (1 << i)) !== 0);
  if (!hits.length) return 'None';
  if (hits.length === units.length && units.length > 1) {
    return `All ${units.length}`;
  }
  if (hits.length === 1) return `${hits[0].label} only`;
  return hits.map((u) => u.short_label || u.label).join(' + ');
}

export function absenteeExportFilename(label: string, date = new Date()): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'list';
  return `absentee-${slug}-${date.toISOString().slice(0, 10)}.csv`;
}

export function absenteeComboFilename(
  mask: number,
  units: AbsenteeUnit[],
  date = new Date(),
): string {
  const hits = units.filter((_, i) => (mask & (1 << i)) !== 0);
  const slug =
    hits.length === 0
      ? 'none'
      : hits.length === units.length && units.length > 1
        ? `all-${units.length}`
        : hits.map((u) => u.short_label || u.label).join('-');
  return absenteeExportFilename(slug, date);
}

export function unionCountForAbsenteeUnit(
  combos: AbsenteeComboCount[] | null | undefined,
  units: AbsenteeUnit[],
  unitIndex: number,
): number {
  const bit = 1 << unitIndex;
  return collapseAbsenteeCombos(combos, units)
    .filter((c) => (c.mask & bit) !== 0)
    .reduce((s, c) => s + (Number(c.count) || 0), 0);
}

export function filtersForAbsenteeExclusive(
  election: AbsenteeElection,
  units: AbsenteeUnit[],
): Partial<VoterFilters> {
  const others = units
    .flatMap((u) => u.elections)
    .filter((e) => e.slug !== election.slug)
    .map((e) => e.slug);
  return {
    absentee: [election.slug],
    absentee_min: null,
    absentee_min_of: [],
    exclude: others.length ? { absentee: others } : {},
  };
}

export function filtersForAbsenteeSuper(units: AbsenteeUnit[]): Partial<VoterFilters> {
  const slugs = units.flatMap((u) => u.elections.map((e) => e.slug));
  return {
    absentee: [],
    absentee_min: slugs.length ? 2 : null,
    absentee_min_of: slugs,
    exclude: {},
  };
}

export function filtersForAbsenteeTarget(
  habitSlugs: string[],
  targetSlugs: string[],
  minN: number,
): Partial<VoterFilters> {
  return {
    absentee: [],
    absentee_min: habitSlugs.length ? Math.max(1, minN) : null,
    absentee_min_of: habitSlugs,
    exclude: targetSlugs.length ? { absentee: targetSlugs } : {},
  };
}

export function countAbsenteeTarget(
  combos: AbsenteeComboCount[] | null | undefined,
  habit: AbsenteeElection[],
  target: AbsenteeElection[],
  minN: number,
): number {
  const history = habit.reduce((m, e) => m | (1 << e.bit_index), 0);
  const skip = target.reduce((m, e) => m | (1 << e.bit_index), 0);
  let n = 0;
  for (const c of combos ?? []) {
    const mask = Number(c.mask);
    if (skip && (mask & skip) !== 0) continue;
    let bits = mask & history;
    let got = 0;
    while (bits) {
      bits &= bits - 1;
      got += 1;
    }
    if (got >= minN) n += Number(c.count) || 0;
  }
  return n;
}

export function countAbsenteeTargetByParty(
  rows: AbsenteeMaskParty[] | null | undefined,
  habit: AbsenteeElection[],
  target: AbsenteeElection[],
  minN: number,
  includeParty: string[] = [],
  excludeParty: string[] = [],
): number {
  const history = habit.reduce((m, e) => m | (1 << e.bit_index), 0);
  const skip = target.reduce((m, e) => m | (1 << e.bit_index), 0);
  const want = new Set(includeParty.map((p) => p.trim().toLowerCase()).filter(Boolean));
  const no = new Set(excludeParty.map((p) => p.trim().toLowerCase()).filter(Boolean));
  let n = 0;
  for (const row of rows ?? []) {
    const mask = Number(row.mask);
    if (skip && (mask & skip) !== 0) continue;
    let bits = mask & history;
    let got = 0;
    while (bits) {
      bits &= bits - 1;
      got += 1;
    }
    if (got < minN) continue;
    const party = (row.party ?? '').trim().toLowerCase();
    if (want.size && !want.has(party)) continue;
    if (no.size && no.has(party)) continue;
    n += Number(row.count) || 0;
  }
  return n;
}

export function filtersForAbsenteeCombo(
  unitMask: number,
  units: AbsenteeUnit[],
): Partial<VoterFilters> {
  const inUnits = units.filter((_, i) => (unitMask & (1 << i)) !== 0);
  const outSlugs = units
    .filter((_, i) => (unitMask & (1 << i)) === 0)
    .flatMap((u) => u.elections.map((e) => e.slug));
  const singles = inUnits.filter((u) => u.elections.length === 1);
  const grouped = inUnits.filter((u) => u.elections.length > 1);
  const absentee = singles.map((u) => u.elections[0].slug);
  let absentee_min: number | null = null;
  let absentee_min_of: string[] = [];
  if (grouped.length === 1) {
    absentee_min = 1;
    absentee_min_of = grouped[0].elections.map((e) => e.slug);
  } else if (grouped.length > 1) {
    absentee_min = grouped.length;
    absentee_min_of = grouped.flatMap((u) => u.elections.map((e) => e.slug));
  }
  return {
    absentee,
    absentee_min,
    absentee_min_of,
    exclude: outSlugs.length ? { absentee: outSlugs } : {},
  };
}

export const EMPTY_ABSENTEE_HEADLINE: AbsenteeHeadlineSql = {
  unique_voters: 0,
  rows: 0,
  requested_not_returned: 0,
  returned: 0,
  accepted: 0,
  rejected: 0,
};

export function emptyAbsenteeDashboard(
  elections: AbsenteeElection[] = [],
): AbsenteeDashboard {
  return {
    elections,
    groups: [],
    headline: { ...EMPTY_ABSENTEE_HEADLINE },
    by_election: [],
    by_county: [],
    by_party: [],
    petition_overlap: [],
    combos: [],
    mask_party: [],
  };
}

export function normalizeAbsenteeDashboard(
  raw: Partial<AbsenteeDashboard> | null | undefined,
): AbsenteeDashboard {
  return {
    elections: raw?.elections ?? [],
    groups: raw?.groups ?? [],
    headline: { ...EMPTY_ABSENTEE_HEADLINE, ...(raw?.headline ?? {}) },
    by_election: raw?.by_election ?? [],
    by_county: raw?.by_county ?? [],
    by_party: raw?.by_party ?? [],
    petition_overlap: raw?.petition_overlap ?? [],
    combos: raw?.combos ?? [],
    mask_party: raw?.mask_party ?? [],
  };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function dashboardHeadline(dash: AbsenteeDashboard | null): AbsenteeHeadline {
  if (!dash) {
    return { total: 0, requestedNotReturned: 0, returned: 0, accepted: 0, rejected: 0 };
  }
  return {
    total: num(dash.headline.unique_voters),
    requestedNotReturned: num(dash.headline.requested_not_returned),
    returned: num(dash.headline.returned),
    accepted: num(dash.headline.accepted),
    rejected: num(dash.headline.rejected),
  };
}

export function dashboardStacked(
  dash: AbsenteeDashboard | null,
  slugs: string[],
): StatusBarPoint[] {
  if (!dash) return [];
  const allow = new Set(slugs);
  return dash.by_election
    .filter((e) => !allow.size || allow.has(e.slug))
    .map((e) => ({
      key: e.slug,
      label: e.short_label || e.label,
      REQUESTED: num(e.REQUESTED),
      ISSUED: num(e.ISSUED),
      MAILED: num(e.MAILED),
      RETURNED: num(e.RETURNED),
      ACCEPTED: num(e.ACCEPTED),
      REJECTED: num(e.REJECTED),
      CANCELLED: num(e.CANCELLED),
      UNKNOWN: num(e.UNKNOWN),
    }));
}

export function dashboardFunnel(dash: AbsenteeDashboard | null): FunnelStep[] {
  if (!dash) {
    return [
      { key: 'requested', label: 'On file', count: 0 },
      { key: 'mailed', label: 'Issued / mailed', count: 0 },
      { key: 'returned', label: 'Returned', count: 0 },
      { key: 'accepted', label: 'Accepted', count: 0 },
    ];
  }
  let mailed = 0;
  let returned = 0;
  let accepted = 0;
  for (const e of dash.by_election) {
    mailed += num(e.ISSUED) + num(e.MAILED) + num(e.RETURNED) + num(e.ACCEPTED);
    returned += num(e.RETURNED) + num(e.ACCEPTED);
    accepted += num(e.ACCEPTED);
  }
  return [
    { key: 'requested', label: 'On file', count: num(dash.headline.rows) },
    { key: 'mailed', label: 'Issued / mailed', count: mailed },
    { key: 'returned', label: 'Returned', count: returned },
    { key: 'accepted', label: 'Accepted', count: accepted },
  ];
}

const RETURNED_STATUSES = new Set(['RETURNED', 'ACCEPTED']);
const OUT_STATUSES = new Set(['REQUESTED', 'ISSUED', 'MAILED']);

function partyBucket(party?: string | null): string {
  const p = (party ?? '').toLowerCase();
  if (/republ|\bgop\b|(^|[^a-z])r([^a-z]|$)/.test(p)) return 'Republican';
  if (/democrat|\bdem\b|(^|[^a-z])d([^a-z]|$)/.test(p)) return 'Democrat';
  if (p) return 'Independent / other';
  return 'Unknown';
}

export function absenteeHeadline(
  ballots: AbsenteeBallot[],
  slugs: string[],
): AbsenteeHeadline {
  const allow = new Set(slugs);
  const people = new Map<number, Set<string>>();
  let requestedNotReturned = 0;
  let returned = 0;
  let accepted = 0;
  let rejected = 0;
  for (const b of ballots) {
    if (allow.size && !allow.has(b.election_slug)) continue;
    const set = people.get(b.voter_id) ?? new Set();
    set.add(b.status);
    people.set(b.voter_id, set);
    if (b.status === 'ACCEPTED') accepted += 1;
    if (b.status === 'REJECTED') rejected += 1;
    if (RETURNED_STATUSES.has(b.status)) returned += 1;
    if (OUT_STATUSES.has(b.status)) requestedNotReturned += 1;
  }
  return {
    total: people.size,
    requestedNotReturned,
    returned,
    accepted,
    rejected,
  };
}

export function stackedStatusByElection(
  elections: AbsenteeElection[],
  ballots: AbsenteeBallot[],
  slugs: string[],
): StatusBarPoint[] {
  const allow = new Set(slugs);
  const selected = elections.filter((e) => allow.has(e.slug));
  return selected.map((e) => {
    const point: StatusBarPoint = {
      key: e.slug,
      label: e.short_label || e.label,
      REQUESTED: 0,
      ISSUED: 0,
      MAILED: 0,
      RETURNED: 0,
      ACCEPTED: 0,
      REJECTED: 0,
      CANCELLED: 0,
      UNKNOWN: 0,
    };
    for (const b of ballots) {
      if (b.election_id !== e.id) continue;
      const s = (b.status in point ? b.status : 'UNKNOWN') as keyof StatusBarPoint;
      if (typeof point[s] === 'number') {
        (point[s] as number) += 1;
      }
    }
    return point;
  });
}

export function countsByCounty(ballots: AbsenteeBallot[], slugs: string[]): CountRow[] {
  const allow = new Set(slugs);
  const seen = new Set<string>();
  const map = new Map<string, number>();
  for (const b of ballots) {
    if (allow.size && !allow.has(b.election_slug)) continue;
    const key = `${b.voter_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (b.county || 'Unknown').trim() || 'Unknown';
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

export function countsByParty(ballots: AbsenteeBallot[], slugs: string[]): CountRow[] {
  const allow = new Set(slugs);
  const seen = new Set<string>();
  const map = new Map<string, number>();
  for (const b of ballots) {
    if (allow.size && !allow.has(b.election_slug)) continue;
    const key = `${b.voter_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = partyBucket(b.party);
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export type FunnelStep = { key: string; label: string; count: number };

export function absenteeFunnel(ballots: AbsenteeBallot[], slugs: string[]): FunnelStep[] {
  const allow = new Set(slugs);
  let requested = 0;
  let mailed = 0;
  let returned = 0;
  let accepted = 0;
  for (const b of ballots) {
    if (allow.size && !allow.has(b.election_slug)) continue;
    requested += 1;
    if (['ISSUED', 'MAILED', 'RETURNED', 'ACCEPTED'].includes(b.status)) mailed += 1;
    if (RETURNED_STATUSES.has(b.status)) returned += 1;
    if (b.status === 'ACCEPTED') accepted += 1;
  }
  return [
    { key: 'requested', label: 'On file', count: requested },
    { key: 'mailed', label: 'Issued / mailed', count: mailed },
    { key: 'returned', label: 'Returned', count: returned },
    { key: 'accepted', label: 'Accepted', count: accepted },
  ];
}

export type PetitionOverlapRow = {
  slug: string;
  label: string;
  count: number;
};

export function petitionOverlap(
  ballots: AbsenteeBallot[],
  slugs: string[],
  petitions: Array<{ slug: string; label: string; bit_index: number }>,
): PetitionOverlapRow[] {
  const allow = new Set(slugs);
  const voters = new Map<number, number>();
  for (const b of ballots) {
    if (allow.size && !allow.has(b.election_slug)) continue;
    const prev = voters.get(b.voter_id) ?? 0;
    voters.set(b.voter_id, prev | Number(b.signed_mask ?? 0));
  }
  return petitions.map((p) => {
    const bit = 1n << BigInt(p.bit_index);
    let count = 0;
    for (const mask of voters.values()) {
      if ((BigInt(mask) & bit) === bit) count += 1;
    }
    return { slug: p.slug, label: p.label, count };
  });
}
