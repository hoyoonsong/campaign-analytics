import { parseCsv, rowsToObjects } from '../csv';
import { formatPollDate } from './dates';
import type { ParsedPollRow } from './types';

export type PollImportTarget = {
  key: string;
  label: string;
  aliases: string[];
  group?: string;
};

export const POLL_FIELDS = [
  'source_profile_id',
  'source_phone',
  'source_email',
  'source_name',
  'first_name',
  'last_name',
  'raw_answer',
  'answered_at',
] as const;

export type PollField = (typeof POLL_FIELDS)[number];

export const POLL_FIELD_LABELS: Record<PollField, string> = {
  source_profile_id: 'Profile / External ID',
  source_phone: 'Phone',
  source_email: 'Email',
  source_name: 'Name',
  first_name: 'First name',
  last_name: 'Last name',
  raw_answer: 'Poll answer',
  answered_at: 'Last answered at',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `Poll 2026-04-11` → 2026-04-11. Ignores Poll Count / Polls Answered. */
export function detectPollDateFromHeader(header: string): string | null {
  const n = header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (/^polls?\s*(count|answered|response|answer)$/.test(n)) return null;
  const m = n.match(
    /(?:^|\b)poll(?:s)?\s*(20\d{2})\s+(\d{1,2})\s+(\d{1,2})(?:\b|$)/,
  );
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function normHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Columns the poll mapper should show. Address, petitions, tags, etc. stay off this page. */
export function isPollMappingHeader(header: string): boolean {
  if (detectPollDateFromHeader(header)) return true;
  const n = normHeader(header);
  return (
    /^(profileid|profile id|external id|murmuration|murmuration id|vanid|van id)$/.test(n) ||
    /^(first name|firstname|last name|lastname|email|email address)$/.test(n) ||
    /^(phone|phone number|phone number best known|best known|mobile|cell)$/.test(n) ||
    /^(name|full name|respondent)$/.test(n) ||
    /^(answer|poll response|poll answer|last answered|answered at|last answered at)$/.test(n)
  );
}

export function visiblePollImportColumns(
  headers: string[],
  rows: string[][],
): { headers: string[]; rows: string[][]; hiddenCount: number } {
  const keep = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => isPollMappingHeader(header));
  return {
    headers: keep.map((k) => k.header),
    rows: rows.map((row) => keep.map((k) => row[k.index] ?? '')),
    hiddenCount: headers.length - keep.length,
  };
}

export function pollColumnKey(date: string): string {
  return `poll:${date}`;
}

export function dateFromPollColumnKey(key: string): string | null {
  return key.startsWith('poll:') ? key.slice(5) : null;
}

export function pollAnswerTarget(): PollImportTarget {
  return {
    key: 'raw_answer',
    label: 'Poll answer',
    group: 'Tracking polls',
    aliases: [
      'poll answer',
      'poll response',
      'raw answer',
      'response',
      'preference',
    ],
  };
}

/** Poll-date columns only — use as extraTargets on the full voter mapper. */
export function pollDateTargets(headers: string[]): PollImportTarget[] {
  const seen = new Set<string>();
  const polls: PollImportTarget[] = [];
  for (const header of headers) {
    const date = detectPollDateFromHeader(header);
    if (!date || seen.has(date)) continue;
    seen.add(date);
    polls.push({
      key: pollColumnKey(date),
      label: `Poll ${formatPollDate(date)}`,
      group: 'Tracking polls',
      aliases: [header, `poll ${date}`, date, date.replace(/-/g, ' ')],
    });
  }
  return [
    pollAnswerTarget(),
    {
      key: 'gender',
      label: 'Gender',
      group: 'Contact',
      aliases: ['gender', 'sex'],
    },
    ...polls,
  ];
}

export function expandMappedPollResponses(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
  fallbackDate?: string | null,
  forceDate?: string | null,
): Array<ParsedPollRow & { poll_date: string }> {
  const pollEntries = Object.entries(mapping).filter(([key]) =>
    key.startsWith('poll:'),
  );
  const identityMap: Record<string, string> = {};
  for (const [key, header] of Object.entries(mapping)) {
    if (!key.startsWith('poll:')) identityMap[key] = header;
  }

  const out: Array<ParsedPollRow & { poll_date: string }> = [];
  const headerIndex = new Map(headers.map((h, i) => [h, i]));
  const assignedDate = forceDate?.trim() || null;

  rows.forEach((row, i) => {
    const obj = rowsToObjects(headers, [row], identityMap)[0] ?? {};
    const first = (obj.first_name ?? '').trim();
    const last = (obj.last_name ?? '').trim();
    const combined = [first, last].filter(Boolean).join(' ');
    const base = {
      source_name: (obj.source_name ?? '').trim() || combined || null,
      source_phone: (obj.source_phone ?? obj.phone ?? '').trim() || null,
      source_email: (obj.source_email ?? obj.email ?? '').trim() || null,
      source_profile_id:
        (obj.source_profile_id ?? obj.murmuration_id ?? '').trim() || null,
      source_party: (obj.party ?? '').trim() || null,
      source_gender: (obj.gender ?? '').trim() || null,
      answered_at: (obj.answered_at ?? '').trim() || null,
    };

    if (pollEntries.length > 0 && !assignedDate) {
      for (const [key, header] of pollEntries) {
        const date = dateFromPollColumnKey(key);
        if (!date) continue;
        const idx = headerIndex.get(header);
        const raw = (idx == null ? '' : row[idx] ?? '').trim();
        if (!raw) continue;
        out.push({
          uid: `r${i}:${date}`,
          poll_date: date,
          raw_answer: raw,
          ...base,
        });
      }
      return;
    }

    let raw = (obj.raw_answer ?? '').trim();
    if (!raw && assignedDate) {
      for (const [, header] of pollEntries) {
        const idx = headerIndex.get(header);
        raw = (idx == null ? '' : row[idx] ?? '').trim();
        if (raw) break;
      }
    }
    const date = assignedDate || fallbackDate || null;
    if (raw && date) {
      out.push({
        uid: `r${i}`,
        poll_date: date,
        raw_answer: raw,
        ...base,
      });
    }
  });

  return out;
}

export function parsePollCsv(text: string): { headers: string[]; rows: string[][] } {
  return parseCsv(text);
}
