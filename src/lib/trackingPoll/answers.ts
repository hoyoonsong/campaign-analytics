export const POLL_ANSWERS = ['TODD', 'RISCH', 'UNDECIDED', 'OTHER', 'UNKNOWN'] as const;
export type PollAnswer = (typeof POLL_ANSWERS)[number];

export const ANSWER_LABELS: Record<PollAnswer, string> = {
  TODD: 'Todd Achilles',
  RISCH: 'Jim Risch',
  UNDECIDED: 'Undecided',
  OTHER: 'Other',
  UNKNOWN: 'Unknown',
};

export const ANSWER_COLORS: Record<PollAnswer, string> = {
  TODD: '#1d4ed8',
  RISCH: '#b45309',
  UNDECIDED: '#0f766e',
  OTHER: '#475569',
  UNKNOWN: '#94a3b8',
};

/** Centralized answer normalization. Never guess — unknown stays UNKNOWN. */
export function normalizePollAnswer(raw: string | null | undefined): PollAnswer {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return 'UNKNOWN';

  if (
    /\btodd\b/.test(s) ||
    /\bachilles\b/.test(s) ||
    s === 'ta' ||
    s === 'achilles for idaho'
  ) {
    return 'TODD';
  }
  if (/\brisch\b/.test(s) || /\bjim risch\b/.test(s) || s === 'jr') {
    return 'RISCH';
  }
  if (
    /\bundecided\b/.test(s) ||
    /\bunsure\b/.test(s) ||
    /\bnot sure\b/.test(s) ||
    /\bdk\b/.test(s) ||
    s === 'und' ||
    s === "don't know" ||
    s === 'dont know'
  ) {
    return 'UNDECIDED';
  }
  if (
    /\bother\b/.test(s) ||
    /\banother\b/.test(s) ||
    /\bthird party\b/.test(s) ||
    /\bsomeone else\b/.test(s)
  ) {
    return 'OTHER';
  }
  return 'UNKNOWN';
}
