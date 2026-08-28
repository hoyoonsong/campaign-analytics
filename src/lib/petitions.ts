import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AnalyticsSummary,
  PetitionComboCount,
  VoterFilters,
} from './types';

export type PetitionGroup = {
  id: number;
  slug: string;
  label: string;
  short_label: string;
  sort_order: number;
};

export type Petition = {
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

export type PetitionUnit = {
  key: string;
  label: string;
  short_label: string;
  colorBit: number;
  group: PetitionGroup | null;
  petitions: Petition[];
};

export const PETITION_COLORS = [
  '#1d4ed8',
  '#0f766e',
  '#b45309',
  '#7c3aed',
  '#be123c',
  '#0369a1',
  '#4d7c0f',
  '#c2410c',
  '#4338ca',
  '#0e7490',
];

export function colorForBit(bitIndex: number): string {
  return PETITION_COLORS[Math.abs(bitIndex) % PETITION_COLORS.length];
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Same hue, stepped lightness so stacked group segments stay related. */
export function segmentShade(baseBit: number, index: number, total: number): string {
  const base = colorForBit(baseBit);
  if (total <= 1) return base;
  const t = (0.5 * index) / Math.max(total - 1, 1);
  const [r, g, b] = parseHex(base);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `#${[mix(r), mix(g), mix(b)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function buildPetitionUnits(
  petitions: Petition[],
  groups: PetitionGroup[],
): PetitionUnit[] {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const members = new Map<number, Petition[]>();
  for (const p of petitions) {
    if (p.group_id && groupById.has(p.group_id)) {
      const arr = members.get(p.group_id) ?? [];
      arr.push(p);
      members.set(p.group_id, arr);
    }
  }
  const units: PetitionUnit[] = [];
  const seen = new Set<number>();
  for (const p of petitions) {
    const gid = p.group_id ?? null;
    if (gid && groupById.has(gid)) {
      if (seen.has(gid)) continue;
      seen.add(gid);
      const g = groupById.get(gid)!;
      const ps = members.get(gid) ?? [p];
      units.push({
        key: `g:${g.id}`,
        label: g.label,
        short_label: g.short_label,
        colorBit: Math.min(...ps.map((x) => x.bit_index)),
        group: g,
        petitions: ps,
      });
    } else {
      units.push({
        key: `p:${p.id}`,
        label: p.label,
        short_label: p.short_label,
        colorBit: p.bit_index,
        group: null,
        petitions: [p],
      });
    }
  }
  return units;
}

export function unionCountForPetitions(
  combos: PetitionComboCount[] | null | undefined,
  petitions: Pick<Petition, 'bit_index'>[],
): number {
  const m = maskFor(petitions);
  if (!m) return 0;
  let n = 0;
  for (const c of combos ?? []) {
    if ((Number(c.mask) & m) !== 0) n += Number(c.count) || 0;
  }
  return n;
}

/** Search/export: signed this petition, or any petition in a group. */
export function filtersForSignedAny(slugs: string[]): Partial<VoterFilters> {
  if (slugs.length <= 1) {
    return { signed: slugs, signed_min: null, signed_min_of: [] };
  }
  return { signed: [], signed_min: 1, signed_min_of: slugs };
}

/** Map raw petition-bit combos onto grouped units (virtual bits 0..n-1). */
export function collapseCombosToUnits(
  combos: PetitionComboCount[] | null | undefined,
  units: PetitionUnit[],
): PetitionComboCount[] {
  const unitMasks = units.map((u) => maskFor(u.petitions));
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

export function unitsAsVirtualPetitions(units: PetitionUnit[]): Petition[] {
  return units.map((u, i) => ({
    id: u.petitions[0]?.id ?? i,
    slug: u.key,
    label: u.label,
    short_label: u.short_label,
    bit_index: i,
    sort_order: i * 10,
    is_default: u.petitions.some((p) => p.is_default),
    is_active: true,
    group_id: u.group?.id ?? null,
  }));
}

export function exclusiveCountForMask(
  combos: PetitionComboCount[] | null | undefined,
  mask: number,
): number {
  const want = Number(mask);
  let n = 0;
  for (const c of combos ?? []) {
    if (Number(c.mask) === want) n += Number(c.count) || 0;
  }
  return n;
}

export function mergeFiltersWithUnitCombo(
  base: VoterFilters,
  unitMask: number,
  units: PetitionUnit[],
): VoterFilters {
  const inUnits = units.filter((_, i) => maskHas(unitMask, i));
  const outSlugs = units
    .filter((_, i) => !maskHas(unitMask, i))
    .flatMap((u) => u.petitions.map((p) => p.slug));
  const singles = inUnits.filter((u) => u.petitions.length === 1);
  const grouped = inUnits.filter((u) => u.petitions.length > 1);
  const { signed: _s, signed_min: _m, signed_min_of: _o, exclude: baseEx = {}, ...rest } =
    base;
  const { signed: _exSigned, ...otherExclude } = baseEx;
  const nextExclude: VoterFilters['exclude'] = { ...otherExclude };
  if (outSlugs.length) nextExclude.signed = outSlugs;

  const signed = singles.map((u) => u.petitions[0].slug);
  let signed_min: number | null = null;
  let signed_min_of: string[] = [];
  if (grouped.length === 1) {
    signed_min = 1;
    signed_min_of = grouped[0].petitions.map((p) => p.slug);
  } else if (grouped.length > 1) {
    signed_min = grouped.length;
    signed_min_of = grouped.flatMap((u) => u.petitions.map((p) => p.slug));
  }

  return {
    ...rest,
    signed,
    signed_min,
    signed_min_of,
    exclude: nextExclude,
  };
}

let petitionLabelCache: Record<string, string> = {};

export function setPetitionLabelCache(rows: Petition[]) {
  petitionLabelCache = Object.fromEntries(rows.map((p) => [p.slug, p.label]));
}

export function addPetitionToLabelCache(p: Petition) {
  if (!p.is_active) return;
  petitionLabelCache = { ...petitionLabelCache, [p.slug]: p.label };
}

export function petitionLabel(slug: string): string {
  return petitionLabelCache[slug] ?? slug;
}

export function bitValue(bitIndex: number): number {
  return 2 ** bitIndex;
}

export function bitCount(mask: number): number {
  let n = Math.trunc(Number(mask));
  if (!Number.isFinite(n) || n <= 0) return 0;
  let c = 0;
  while (n > 0) {
    c += n % 2;
    n = Math.trunc(n / 2);
  }
  return c;
}

export function maskHas(mask: number, bitIndex: number): boolean {
  return Math.trunc(Number(mask) / bitValue(bitIndex)) % 2 === 1;
}

export function maskFor(petitions: Pick<Petition, 'bit_index'>[]): number {
  return petitions.reduce((m, p) => {
    const b = bitValue(p.bit_index);
    return maskHas(m, p.bit_index) ? m : m + b;
  }, 0);
}

export function maskForSlugs(
  slugs: string[],
  all: Pick<Petition, 'slug' | 'bit_index'>[],
): number {
  const set = new Set(slugs);
  return maskFor(all.filter((p) => set.has(p.slug)));
}

export function petitionsInMask(
  mask: number,
  all: Petition[],
): Petition[] {
  return all.filter((p) => maskHas(mask, p.bit_index));
}

export function comboLabel(mask: number, all: Petition[]): string {
  const hits = petitionsInMask(mask, all);
  if (hits.length === 0) return 'None';
  if (hits.length === all.length && all.length > 1) {
    return `All ${all.length} petitions`;
  }
  if (hits.length === 1) return `${hits[0].label} only`;
  return hits.map((p) => p.short_label || p.label).join(' + ');
}

export function comboExportFilename(
  mask: number,
  all: Petition[],
  date = new Date(),
): string {
  const hits = petitionsInMask(mask, all);
  const slug =
    hits.length === 0
      ? 'none'
      : hits.length === all.length && all.length > 1
        ? `all-${all.length}`
        : hits.map((p) => p.slug).join('-');
  return `petition-${slug}-${date.toISOString().slice(0, 10)}.csv`;
}

export function filtersForCombo(
  mask: number,
  selected: Petition[],
): VoterFilters {
  const inMask = petitionsInMask(mask, selected);
  const outside = selected.filter((p) => !maskHas(mask, p.bit_index));
  return {
    signed: inMask.map((p) => p.slug),
    exclude: outside.length ? { signed: outside.map((p) => p.slug) } : {},
  };
}

export function mergeFiltersWithCombo(
  base: VoterFilters,
  mask: number,
  selected: Petition[],
): VoterFilters {
  const segment = filtersForCombo(mask, selected);
  const { signed: _s, signed_min: _m, signed_min_of: _o, exclude: baseEx = {}, ...rest } =
    base;
  const { signed: _exSigned, ...otherExclude } = baseEx;
  const nextExclude: VoterFilters['exclude'] = { ...otherExclude };
  if (segment.exclude?.signed?.length) {
    nextExclude.signed = segment.exclude.signed;
  }
  return {
    ...rest,
    signed: segment.signed,
    signed_min: null,
    signed_min_of: [],
    exclude: nextExclude,
  };
}

export function superSignerFilters(selected: Petition[]): Partial<VoterFilters> {
  return {
    signed_min: 2,
    signed_min_of: selected.map((p) => p.slug),
  };
}

const SELECTION_KEY = 'petition_selection_v1';

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

export async function fetchPetitions(): Promise<Petition[]> {
  const { fetchPetitionsApi } = await import('./api');
  const { petitions } = await fetchPetitionsApi();
  return petitions;
}

/** Build picker rows from a cached analytics summary when GET /petitions is down. */
export function petitionsFromAnalyticsSummary(
  summary: AnalyticsSummary | null | undefined,
): Petition[] {
  const rows = summary?.petitions ?? [];
  return rows
    .filter((p) => p.slug && Number.isFinite(Number(p.bit_index)))
    .map((p, i) => ({
      id: i + 1,
      slug: p.slug,
      label: p.label || p.slug,
      short_label: p.short_label || p.label || p.slug,
      bit_index: Number(p.bit_index),
      sort_order: p.sort_order ?? i,
      is_default: Boolean(p.is_default),
      is_active: true,
    }));
}

export function usePetitions() {
  const [petitions, setPetitions] = useState<Petition[]>([]);
  const [groups, setGroups] = useState<PetitionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    void import('./api')
      .then(({ fetchPetitionsApi }) => fetchPetitionsApi())
      .then((data) => {
        const rows = data.petitions ?? [];
        setPetitionLabelCache(rows.filter((p) => p.is_active));
        setPetitions(rows);
        setGroups(data.groups ?? []);
        setError(null);
      })
      .catch((err: Error) => {
        setError(err.message);
        // Keep any already-loaded rows so charts do not collapse to 0 of 0.
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const addLocal = useCallback((row: Petition) => {
    addPetitionToLabelCache(row);
    setPetitions((cur) => {
      const hit = cur.findIndex((p) => p.id === row.id || p.slug === row.slug);
      if (hit >= 0) {
        return cur.map((p, i) => (i === hit ? { ...p, ...row } : p));
      }
      return [...cur, row];
    });
  }, []);

  const activePetitions = useMemo(
    () => petitions.filter((p) => p.is_active),
    [petitions],
  );

  return { petitions, groups, activePetitions, loading, error, reload, addLocal };
}

export function useSelectedPetitions(all: Petition[]) {
  const defaults = useMemo(
    () => all.filter((p) => p.is_default).map((p) => p.slug),
    [all],
  );
  const [slugs, setSlugs] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!all.length) return;
    const stored = readStoredSlugs();
    const valid = new Set(all.map((p) => p.slug));
    if (stored?.length) {
      const next = stored.filter((s) => valid.has(s));
      setSlugs(next.length ? next : defaults);
    } else {
      setSlugs(defaults.length ? defaults : all.slice(0, 3).map((p) => p.slug));
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
    () => all.filter((p) => slugs.includes(p.slug)),
    [all, slugs],
  );

  const isDefaultSelection =
    selected.length === defaults.length &&
    defaults.every((s) => slugs.includes(s));

  const setSelectedSlugs = useCallback((next: string[]) => {
    setSlugs(next);
  }, []);

  const toggle = useCallback((slug: string) => {
    setSlugs((cur) =>
      cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug],
    );
  }, []);

  const selectAll = useCallback(() => {
    setSlugs(all.map((p) => p.slug));
  }, [all]);

  const selectDefaults = useCallback(() => {
    setSlugs(defaults);
  }, [defaults]);

  return {
    slugs,
    selected,
    hydrated,
    isDefaultSelection,
    setSelectedSlugs,
    toggle,
    selectAll,
    selectDefaults,
  };
}

/** Restrict a full-universe summary to the petitions currently selected. */
export function sliceSummaryToPetitions(
  summary: AnalyticsSummary,
  petitions: Pick<Petition, 'slug' | 'bit_index'>[],
): AnalyticsSummary {
  if (!petitions.length) {
    return {
      ...summary,
      by_signature: [],
      petition_combos: [],
      super_signers: 0,
    };
  }

  const selMask = maskFor(petitions);
  const order = new Map(petitions.map((p, i) => [p.slug, i]));
  const slugs = new Set(petitions.map((p) => p.slug));
  const by_signature = (summary.by_signature ?? [])
    .filter((r) => r.slug && slugs.has(r.slug))
    .sort(
      (a, b) =>
        (order.get(a.slug ?? '') ?? 99) - (order.get(b.slug ?? '') ?? 99),
    );

  const comboMap = new Map<number, number>();
  for (const c of summary.petition_combos ?? []) {
    const sliced = Number(c.mask) & selMask;
    if (sliced === 0) continue;
    comboMap.set(sliced, (comboMap.get(sliced) ?? 0) + Number(c.count));
  }

  let super_signers = 0;
  const petition_combos: PetitionComboCount[] = [];
  for (const [mask, count] of comboMap) {
    petition_combos.push({ mask, count });
    if (bitCount(mask) >= 2) super_signers += count;
  }

  return { ...summary, by_signature, petition_combos, super_signers };
}

export function comboCountMap(
  combos?: PetitionComboCount[] | null,
): Map<number, number> {
  const map = new Map<number, number>();
  for (const c of combos ?? []) {
    map.set(Number(c.mask), Number(c.count) || 0);
  }
  return map;
}
