import { ANSWER_LABELS, type PollAnswer } from './answers';
import { isStablePersonKey } from './identity';
import { classifyMovement, type MovementKind } from './movement';
import type {
  PersonHistoryRow,
  PersonTableFilter,
  TrackingPoll,
  TrackingPollResponse,
} from './types';

export const MATRIX_ANSWERS: PollAnswer[] = ['TODD', 'RISCH', 'UNDECIDED', 'OTHER'];

export type PollVolume = {
  poll_date: string;
  total: number;
  first_time: number;
  repeat: number;
  first_time_pct: number;
};

export type PreferencePoint = {
  poll_date: string;
  TODD: number;
  RISCH: number;
  UNDECIDED: number;
  OTHER: number;
  UNKNOWN: number;
  n: number;
};

export type SelectedPollStats = {
  total: number;
  first_time: number;
  first_time_pct: number;
  repeat: number;
  repeat_pct: number;
  changed: number;
  changed_pct: number;
  toward: number;
  away: number;
  none: number;
  neutral: number;
  retention_pct: number | null;
  returning: number;
  cumulative_unique: number;
  avg_polls: number;
  first_pref: Record<PollAnswer, number>;
  repeat_pref: Record<PollAnswer, number>;
  matrix: Record<string, number>;
};

function emptyPref(): Record<PollAnswer, number> {
  return { TODD: 0, RISCH: 0, UNDECIDED: 0, OTHER: 0, UNKNOWN: 0 };
}

function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}

function share(counts: Record<PollAnswer, number>, key: PollAnswer): number {
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  return pct(counts[key], n);
}

export function buildPersonHistories(
  polls: TrackingPoll[],
  responses: TrackingPollResponse[],
): Map<string, TrackingPollResponse[]> {
  const dateById = new Map(polls.map((p) => [p.id, p.poll_date]));
  const byPerson = new Map<string, TrackingPollResponse[]>();
  for (const r of responses) {
    const date = r.poll_date || dateById.get(r.poll_id);
    if (!date) continue;
    const row = { ...r, poll_date: date };
    const list = byPerson.get(row.person_key) ?? [];
    list.push(row);
    byPerson.set(row.person_key, list);
  }
  for (const [key, list] of byPerson) {
    list.sort((a, b) => a.poll_date.localeCompare(b.poll_date));
    byPerson.set(key, list);
  }
  return byPerson;
}

function priorResponse(
  history: TrackingPollResponse[],
  pollDate: string,
): TrackingPollResponse | null {
  let prior: TrackingPollResponse | null = null;
  for (const r of history) {
    if (r.poll_date >= pollDate) break;
    prior = r;
  }
  return prior;
}

export function personRowsForPoll(
  polls: TrackingPoll[],
  responses: TrackingPollResponse[],
  pollDate: string,
): PersonHistoryRow[] {
  const histories = buildPersonHistories(polls, responses);
  const selected = responses.filter((r) => r.poll_date === pollDate);
  const rows: PersonHistoryRow[] = [];

  for (const current of selected) {
    const history = histories.get(current.person_key) ?? [current];
    const prior = isStablePersonKey(current.person_key)
      ? priorResponse(history, pollDate)
      : null;
    const first = history[0] ?? current;
    const movement = prior
      ? classifyMovement(prior.normalized_answer, current.normalized_answer)
      : isStablePersonKey(current.person_key)
        ? 'first'
        : null;

    const timeline = history.map((r, i) => {
      const prev = i > 0 ? history[i - 1] : null;
      return {
        poll_date: r.poll_date,
        answer: r.normalized_answer,
        raw_answer: r.raw_answer,
        movement: prev
          ? classifyMovement(prev.normalized_answer, r.normalized_answer)
          : ('first' as MovementKind),
      };
    });

    rows.push({
      person_key: current.person_key,
      voter_id: current.voter_id,
      name: current.display_name || current.source_name,
      phone: current.display_phone || current.source_phone,
      email: current.display_email || current.source_email,
      profile_id: current.profile_id || current.source_profile_id,
      first_poll: first.poll_date,
      latest_poll: history[history.length - 1]?.poll_date ?? pollDate,
      polls_answered: history.length,
      first_answer: first.normalized_answer,
      previous_answer: prior?.normalized_answer ?? null,
      current_answer: current.normalized_answer,
      movement,
      history: timeline,
      matched: current.match_status === 'matched' && current.voter_id != null,
      stable: isStablePersonKey(current.person_key),
    });
  }

  rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return rows;
}

export function volumeByPoll(
  polls: TrackingPoll[],
  responses: TrackingPollResponse[],
): PollVolume[] {
  const histories = buildPersonHistories(polls, responses);
  return [...polls]
    .sort((a, b) => a.poll_date.localeCompare(b.poll_date))
    .map((poll) => {
      const rows = responses.filter((r) => r.poll_date === poll.poll_date);
      let first = 0;
      let repeat = 0;
      for (const r of rows) {
        if (!isStablePersonKey(r.person_key)) continue;
        const prior = priorResponse(histories.get(r.person_key) ?? [], poll.poll_date);
        if (prior) repeat += 1;
        else first += 1;
      }
      const total = rows.length;
      return {
        poll_date: poll.poll_date,
        total,
        first_time: first,
        repeat,
        first_time_pct: pct(first, total),
      };
    });
}

export function preferenceOverTime(
  polls: TrackingPoll[],
  responses: TrackingPollResponse[],
  mode: 'all' | 'repeat',
): PreferencePoint[] {
  const histories = buildPersonHistories(polls, responses);
  return [...polls]
    .sort((a, b) => a.poll_date.localeCompare(b.poll_date))
    .map((poll) => {
      const counts = emptyPref();
      let n = 0;
      for (const r of responses) {
        if (r.poll_date !== poll.poll_date) continue;
        if (mode === 'repeat') {
          if (!isStablePersonKey(r.person_key)) continue;
          const prior = priorResponse(histories.get(r.person_key) ?? [], poll.poll_date);
          if (!prior) continue;
        }
        counts[r.normalized_answer] += 1;
        n += 1;
      }
      return {
        poll_date: poll.poll_date,
        TODD: share(counts, 'TODD'),
        RISCH: share(counts, 'RISCH'),
        UNDECIDED: share(counts, 'UNDECIDED'),
        OTHER: share(counts, 'OTHER'),
        UNKNOWN: share(counts, 'UNKNOWN'),
        n,
      };
    });
}

export function statsForPoll(
  polls: TrackingPoll[],
  responses: TrackingPollResponse[],
  pollDate: string,
): SelectedPollStats {
  const people = personRowsForPoll(polls, responses, pollDate);
  const selected = responses.filter((r) => r.poll_date === pollDate);
  const stable = people.filter((p) => p.stable);
  const first = stable.filter((p) => p.movement === 'first');
  const repeat = stable.filter((p) => p.movement !== 'first');
  const changed = repeat.filter(
    (p) => p.previous_answer && p.current_answer && p.previous_answer !== p.current_answer,
  );
  const toward = repeat.filter((p) => p.movement === 'toward');
  const away = repeat.filter((p) => p.movement === 'away');
  const none = repeat.filter((p) => p.movement === 'none');
  const neutral = repeat.filter((p) => p.movement === 'neutral');

  const first_pref = emptyPref();
  const repeat_pref = emptyPref();
  for (const p of first) {
    if (p.current_answer) first_pref[p.current_answer] += 1;
  }
  for (const p of repeat) {
    if (p.current_answer) repeat_pref[p.current_answer] += 1;
  }

  const matrix: Record<string, number> = {};
  for (const p of repeat) {
    if (!p.previous_answer || !p.current_answer) continue;
    const key = `${p.previous_answer}>${p.current_answer}`;
    matrix[key] = (matrix[key] ?? 0) + 1;
  }

  const dates = [...new Set(polls.map((p) => p.poll_date))].sort();
  const idx = dates.indexOf(pollDate);
  const prevDate = idx > 0 ? dates[idx - 1] : null;
  let retention_pct: number | null = null;
  if (prevDate) {
    const prevKeys = new Set(
      responses
        .filter((r) => r.poll_date === prevDate && isStablePersonKey(r.person_key))
        .map((r) => r.person_key),
    );
    const nowKeys = new Set(
      selected.filter((r) => isStablePersonKey(r.person_key)).map((r) => r.person_key),
    );
    let returned = 0;
    for (const k of prevKeys) if (nowKeys.has(k)) returned += 1;
    retention_pct = prevKeys.size ? pct(returned, prevKeys.size) : 0;
  }

  const priorKeys = new Set(
    responses
      .filter((r) => r.poll_date < pollDate && isStablePersonKey(r.person_key))
      .map((r) => r.person_key),
  );
  const nowStable = new Set(
    selected.filter((r) => isStablePersonKey(r.person_key)).map((r) => r.person_key),
  );
  let returning = 0;
  for (const k of nowStable) if (priorKeys.has(k)) returning += 1;

  const through = responses.filter(
    (r) => r.poll_date <= pollDate && isStablePersonKey(r.person_key),
  );
  const unique = new Set(through.map((r) => r.person_key));
  const counts = new Map<string, number>();
  for (const r of through) counts.set(r.person_key, (counts.get(r.person_key) ?? 0) + 1);
  const avg =
    unique.size > 0
      ? [...counts.values()].reduce((a, b) => a + b, 0) / unique.size
      : 0;

  return {
    total: selected.length,
    first_time: first.length,
    first_time_pct: pct(first.length, selected.length),
    repeat: repeat.length,
    repeat_pct: pct(repeat.length, selected.length),
    changed: changed.length,
    changed_pct: pct(changed.length, repeat.length),
    toward: toward.length,
    away: away.length,
    none: none.length,
    neutral: neutral.length,
    retention_pct,
    returning,
    cumulative_unique: unique.size,
    avg_polls: avg,
    first_pref,
    repeat_pref,
    matrix,
  };
}

export function filterPersonRows(
  rows: PersonHistoryRow[],
  filter: PersonTableFilter,
  query: string,
): PersonHistoryRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q) {
      const hay = [r.name, r.phone, r.email, r.profile_id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === 'all') return true;
    if (filter === 'first') return r.movement === 'first';
    if (filter === 'repeat') return r.stable && r.movement !== 'first';
    if (filter === 'changed') {
      return Boolean(
        r.previous_answer && r.current_answer && r.previous_answer !== r.current_answer,
      );
    }
    if (filter === 'toward' || filter === 'away' || filter === 'none' || filter === 'neutral') {
      return r.movement === filter;
    }
    if (filter.startsWith('current_')) {
      return r.current_answer === filter.slice('current_'.length);
    }
    if (filter.includes('>')) {
      const [prev, cur] = filter.split('>') as [PollAnswer, PollAnswer];
      return r.previous_answer === prev && r.current_answer === cur;
    }
    return true;
  });
}

export function dataQuality(
  responses: TrackingPollResponse[],
): {
  source_records: number;
  unique_matched: number;
  unmatched: number;
  by_profile_id: number;
  by_phone: number;
  by_email: number;
  by_manual: number;
  unknown_answers: number;
} {
  const matched = responses.filter((r) => r.match_status === 'matched' && r.voter_id);
  return {
    source_records: responses.length,
    unique_matched: new Set(matched.map((r) => r.voter_id)).size,
    unmatched: responses.filter((r) => r.match_status !== 'matched').length,
    by_profile_id: responses.filter((r) => r.match_method === 'profile_id').length,
    by_phone: responses.filter((r) => r.match_method === 'phone').length,
    by_email: responses.filter((r) => r.match_method === 'email').length,
    by_manual: responses.filter((r) => r.match_method === 'manual').length,
    unknown_answers: responses.filter((r) => r.normalized_answer === 'UNKNOWN').length,
  };
}

export function prefPct(counts: Record<PollAnswer, number>, key: PollAnswer): string {
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!n) return '—';
  return `${share(counts, key).toFixed(1)}%`;
}

export type PartyBucket = 'republican' | 'democrat' | 'independent' | null;
export type GenderBucket = 'female' | 'male' | null;

export function partyBucket(party: string | null | undefined): PartyBucket {
  const p = (party ?? '').toLowerCase();
  if (!p) return null;
  if (/republ|\bgop\b|^r$/.test(p)) return 'republican';
  if (/democrat|^d$|\bdem\b/.test(p)) return 'democrat';
  if (/unaffil|independ|non.?partisan|\bnpa\b|none|other|no party/.test(p)) {
    return 'independent';
  }
  return null;
}

export function genderBucket(
  gender: string | null | undefined,
  tags?: string | null,
): GenderBucket {
  const s = `${gender ?? ''} ${tags ?? ''}`.toLowerCase();
  if (/\bfemale\b|\bwoman\b|gender:\s*f\b/.test(s)) return 'female';
  if (/\bmale\b|\bman\b|gender:\s*m\b/.test(s)) return 'male';
  return null;
}

export type StackedPoint = {
  poll_date: string;
  label: string;
  todd: number;
  risch: number;
  unsure: number;
  n: number;
};

export function stackedPreference(
  polls: TrackingPoll[],
  responses: TrackingPollResponse[],
  opts?: {
    party?: PartyBucket;
    gender?: GenderBucket;
    repeatOnly?: boolean;
  },
): StackedPoint[] {
  const byDate = new Map<string, TrackingPollResponse[]>();
  for (const r of responses) {
    const list = byDate.get(r.poll_date);
    if (list) list.push(r);
    else byDate.set(r.poll_date, [r]);
  }
  const histories = opts?.repeatOnly
    ? buildPersonHistories(polls, responses)
    : null;
  return [...polls]
    .sort((a, b) => a.poll_date.localeCompare(b.poll_date))
    .map((poll) => {
      let todd = 0;
      let risch = 0;
      let unsure = 0;
      for (const r of byDate.get(poll.poll_date) ?? []) {
        if (opts?.party && partyBucket(r.party) !== opts.party) continue;
        if (opts?.gender && genderBucket(r.gender) !== opts.gender) continue;
        if (histories) {
          if (!isStablePersonKey(r.person_key)) continue;
          if (!priorResponse(histories.get(r.person_key) ?? [], poll.poll_date)) {
            continue;
          }
        }
        if (r.normalized_answer === 'TODD') todd += 1;
        else if (r.normalized_answer === 'RISCH') risch += 1;
        else unsure += 1;
      }
      const n = todd + risch + unsure;
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(poll.poll_date);
      const short = m ? `${Number(m[2])}/${Number(m[3])}` : poll.poll_date;
      return {
        poll_date: poll.poll_date,
        label: `${short}\n(n=${n})`,
        todd: n ? (todd / n) * 100 : 0,
        risch: n ? (risch / n) * 100 : 0,
        unsure: n ? (unsure / n) * 100 : 0,
        n,
      };
    });
}

export type PrefBucket = 'todd' | 'risch' | 'unsure';

export const PREF_ORDER: PrefBucket[] = ['todd', 'risch', 'unsure'];

export const PREF_LABELS: Record<PrefBucket, string> = {
  todd: 'Achilles',
  risch: 'Risch',
  unsure: 'Not sure',
};

export function prefBucket(answer: PollAnswer): PrefBucket {
  if (answer === 'TODD') return 'todd';
  if (answer === 'RISCH') return 'risch';
  return 'unsure';
}

export type TransitionFlow = {
  from: PrefBucket;
  to: PrefBucket;
  count: number;
  same: boolean;
  movement: MovementKind | null;
};

export type TransitionView = {
  n: number;
  first: Record<PrefBucket, number>;
  second: Record<PrefBucket, number>;
  flows: TransitionFlow[];
};

function emptyBuckets(): Record<PrefBucket, number> {
  return { todd: 0, risch: 0, unsure: 0 };
}

function pairToAnswers(
  from: PrefBucket,
  to: PrefBucket,
): { prev: PollAnswer; next: PollAnswer } {
  const toAnswer = (b: PrefBucket): PollAnswer =>
    b === 'todd' ? 'TODD' : b === 'risch' ? 'RISCH' : 'UNDECIDED';
  return { prev: toAnswer(from), next: toAnswer(to) };
}

function addFlow(
  first: Record<PrefBucket, number>,
  second: Record<PrefBucket, number>,
  flowMap: Map<string, TransitionFlow>,
  from: PrefBucket,
  to: PrefBucket,
) {
  first[from] += 1;
  second[to] += 1;
  const k = `${from}>${to}`;
  const existing = flowMap.get(k);
  if (existing) {
    existing.count += 1;
    return;
  }
  const { prev, next } = pairToAnswers(from, to);
  flowMap.set(k, {
    from,
    to,
    count: 1,
    same: from === to,
    movement: classifyMovement(prev, next),
  });
}

function finalizeFlows(
  first: Record<PrefBucket, number>,
  second: Record<PrefBucket, number>,
  flowMap: Map<string, TransitionFlow>,
): TransitionView {
  const flows = [...flowMap.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const di = PREF_ORDER.indexOf(a.from) - PREF_ORDER.indexOf(b.from);
    if (di) return di;
    return PREF_ORDER.indexOf(a.to) - PREF_ORDER.indexOf(b.to);
  });
  return {
    n: Object.values(first).reduce((s, v) => s + v, 0),
    first,
    second,
    flows,
  };
}

function firstFlip(
  list: TrackingPollResponse[],
): { from: PrefBucket; to: PrefBucket } | null {
  for (let i = 1; i < list.length; i++) {
    const prev = prefBucket(list[i - 1].normalized_answer);
    const next = prefBucket(list[i].normalized_answer);
    if (prev !== next) return { from: prev, to: next };
  }
  return null;
}

/**
 * First contact → second contact for people with two or more answers.
 * `flippedOnly` keeps the first time their Achilles / Risch / Not sure bucket changed.
 */
export function firstSecondTransitions(
  polls: TrackingPoll[],
  responses: TrackingPollResponse[],
  opts?: { flippedOnly?: boolean },
): TransitionView {
  return trackingOverview(polls, responses)[opts?.flippedOnly ? 'flipped' : 'repeats'];
}

export function headlineStats(
  polls: TrackingPoll[],
  responses: TrackingPollResponse[],
) {
  return trackingOverview(polls, responses).headline;
}

export function trackingOverview(
  polls: TrackingPoll[],
  responses: TrackingPollResponse[],
): {
  headline: {
    unique: number;
    unmatched: number;
    answers: number;
    multi: number;
    flipped: number;
  };
  repeats: TransitionView;
  flipped: TransitionView;
} {
  const histories = buildPersonHistories(polls, responses);
  let unique = 0;
  let unmatched = 0;
  let answers = 0;
  let multi = 0;
  let flipped = 0;
  const repeatFirst = emptyBuckets();
  const repeatSecond = emptyBuckets();
  const repeatFlows = new Map<string, TransitionFlow>();
  const flipFirst = emptyBuckets();
  const flipSecond = emptyBuckets();
  const flipFlows = new Map<string, TransitionFlow>();

  for (const [key, list] of histories) {
    answers += list.length;
    if (!isStablePersonKey(key)) {
      unmatched += 1;
      continue;
    }
    unique += 1;
    if (list.length < 2) continue;
    multi += 1;
    addFlow(
      repeatFirst,
      repeatSecond,
      repeatFlows,
      prefBucket(list[0].normalized_answer),
      prefBucket(list[1].normalized_answer),
    );
    const change = firstFlip(list);
    if (!change) continue;
    flipped += 1;
    addFlow(flipFirst, flipSecond, flipFlows, change.from, change.to);
  }

  return {
    headline: { unique, unmatched, answers, multi, flipped },
    repeats: finalizeFlows(repeatFirst, repeatSecond, repeatFlows),
    flipped: finalizeFlows(flipFirst, flipSecond, flipFlows),
  };
}

export { ANSWER_LABELS };
