import { emptyFilters } from './filters';
import type {
  PetitionVennCounts,
  PetitionVennKey,
  SignedPetitionKey,
  VoterFilters,
} from './types';

export type { PetitionVennKey, PetitionVennCounts };

export type PetitionComboDef = {
  key: PetitionVennKey;
  /** Full label for legend / export filenames. */
  label: string;
  /** Short label for Venn region. */
  shortLabel: string;
  signed: SignedPetitionKey[];
  excludeSigned: SignedPetitionKey[];
  /** Filename slug (without date/extension). */
  fileSlug: string;
};

/** Exclusive OP × RF × MMJ segments — Achilles ignored. */
export const PETITION_COMBOS: PetitionComboDef[] = [
  {
    key: 'op_only',
    label: 'Open Primaries only',
    shortLabel: 'OP',
    signed: ['open_primaries'],
    excludeSigned: ['reproductive_freedom', 'medical_marijuana_valid'],
    fileSlug: 'petition-op-only',
  },
  {
    key: 'rf_only',
    label: 'Reproductive Freedom only',
    shortLabel: 'RF',
    signed: ['reproductive_freedom'],
    excludeSigned: ['open_primaries', 'medical_marijuana_valid'],
    fileSlug: 'petition-rf-only',
  },
  {
    key: 'mmj_only',
    label: 'Medical Marijuana only',
    shortLabel: 'MMJ',
    signed: ['medical_marijuana_valid'],
    excludeSigned: ['open_primaries', 'reproductive_freedom'],
    fileSlug: 'petition-mmj-only',
  },
  {
    key: 'op_rf',
    label: 'Open Primaries + Reproductive Freedom only',
    shortLabel: 'OP+RF',
    signed: ['open_primaries', 'reproductive_freedom'],
    excludeSigned: ['medical_marijuana_valid'],
    fileSlug: 'petition-op-rf-only',
  },
  {
    key: 'op_mmj',
    label: 'Open Primaries + Medical Marijuana only',
    shortLabel: 'OP+MMJ',
    signed: ['open_primaries', 'medical_marijuana_valid'],
    excludeSigned: ['reproductive_freedom'],
    fileSlug: 'petition-op-mmj-only',
  },
  {
    key: 'rf_mmj',
    label: 'Reproductive Freedom + Medical Marijuana only',
    shortLabel: 'RF+MMJ',
    signed: ['reproductive_freedom', 'medical_marijuana_valid'],
    excludeSigned: ['open_primaries'],
    fileSlug: 'petition-rf-mmj-only',
  },
  {
    key: 'all_three',
    label: 'All three petitions',
    shortLabel: 'All 3',
    signed: [
      'open_primaries',
      'reproductive_freedom',
      'medical_marijuana_valid',
    ],
    excludeSigned: [],
    fileSlug: 'petition-all-three',
  },
];

export const PETITION_COMBO_BY_KEY = Object.fromEntries(
  PETITION_COMBOS.map((c) => [c.key, c]),
) as Record<PetitionVennKey, PetitionComboDef>;

export const EMPTY_PETITION_VENN: PetitionVennCounts = {
  op_only: 0,
  rf_only: 0,
  mmj_only: 0,
  op_rf: 0,
  op_mmj: 0,
  rf_mmj: 0,
  all_three: 0,
};

/** Segment-only filters (include signed + exclude signed). */
export function filtersForSegment(key: PetitionVennKey): VoterFilters {
  const combo = PETITION_COMBO_BY_KEY[key];
  const base = emptyFilters();
  return {
    ...base,
    signed: [...combo.signed],
    exclude: {
      ...(combo.excludeSigned.length
        ? { signed: [...combo.excludeSigned] }
        : {}),
    },
  };
}

/**
 * Merge page filters with an exclusive Venn segment.
 * Segment `signed` / `exclude.signed` win; other exclude rules are kept.
 */
export function mergeFiltersWithSegment(
  base: VoterFilters,
  key: PetitionVennKey,
): VoterFilters {
  const segment = filtersForSegment(key);
  const { signed: _s, exclude: baseEx = {}, ...rest } = base;
  const { signed: _exSigned, ...otherExclude } = baseEx;
  const nextExclude: VoterFilters['exclude'] = { ...otherExclude };
  if (segment.exclude?.signed?.length) {
    nextExclude.signed = segment.exclude.signed;
  }
  return {
    ...rest,
    signed: segment.signed,
    exclude: nextExclude,
  };
}

export function comboExportFilename(key: PetitionVennKey, date = new Date()): string {
  const slug = PETITION_COMBO_BY_KEY[key].fileSlug;
  return `${slug}-${date.toISOString().slice(0, 10)}.csv`;
}

export function normalizePetitionVenn(
  raw?: Partial<PetitionVennCounts> | null,
): PetitionVennCounts {
  return {
    ...EMPTY_PETITION_VENN,
    ...(raw ?? {}),
  };
}
