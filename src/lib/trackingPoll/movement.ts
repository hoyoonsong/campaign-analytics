import type { PollAnswer } from './answers';

export const MOVEMENTS = [
  'toward',
  'away',
  'none',
  'neutral',
  'first',
] as const;
export type MovementKind = (typeof MOVEMENTS)[number];

export const MOVEMENT_LABELS: Record<MovementKind, string> = {
  toward: 'Toward Todd',
  away: 'Away From Todd',
  none: 'No Change',
  neutral: 'Neutral Change',
  first: 'First-Time Respondent',
};

export const MOVEMENT_COLORS: Record<MovementKind, string> = {
  toward: '#15803d',
  away: '#be123c',
  none: '#475569',
  neutral: '#b45309',
  first: '#1d4ed8',
};

const TOWARD = new Set([
  'UNDECIDED>TODD',
  'RISCH>UNDECIDED',
  'RISCH>TODD',
  'OTHER>TODD',
]);

const AWAY = new Set([
  'TODD>UNDECIDED',
  'TODD>RISCH',
  'TODD>OTHER',
  'UNDECIDED>RISCH',
]);

/**
 * Classify previous → current. Unknown sides are never treated as toward/away.
 * Change this table to adjust movement rules later.
 */
export function classifyMovement(
  previous: PollAnswer | null | undefined,
  current: PollAnswer | null | undefined,
): MovementKind | null {
  if (!previous || !current) return null;
  if (previous === 'UNKNOWN' || current === 'UNKNOWN') {
    return previous === current ? 'none' : 'neutral';
  }
  if (previous === current) return 'none';
  const key = `${previous}>${current}`;
  if (TOWARD.has(key)) return 'toward';
  if (AWAY.has(key)) return 'away';
  return 'neutral';
}

export function transitionKey(
  previous: PollAnswer,
  current: PollAnswer,
): string {
  return `${previous}>${current}`;
}
