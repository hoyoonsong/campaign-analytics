/** Format a YYYY-MM-DD poll date without timezone shift. */
export function formatPollDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Human-readable poll name: custom label, else the formatted date. */
export function pollDisplayName(poll: {
  poll_date: string;
  label?: string | null;
}): string {
  const date = formatPollDate(poll.poll_date);
  const label = poll.label?.trim();
  return label ? `${label} · ${date}` : date;
}

export function formatPollDateShort(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toIso(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function yearFromFilename(base: string, explicit?: string): number {
  if (explicit) {
    const y = Number(explicit.length === 2 ? `20${explicit}` : explicit);
    if (y >= 2000 && y <= 2100) return y;
  }
  const years = [...base.matchAll(/(20\d{2})/g)].map((m) => Number(m[1]));
  return years[0] ?? new Date().getUTCFullYear();
}

/**
 * Infer the poll date from a filename. Prefers an explicit poll date
 * (e.g. tracking-poll-8-14-…) over a trailing export/download date.
 */
export function inferPollDateFromFilename(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, '');

  const pollToken = base.match(
    /poll[-_]?(\d{1,2})[-_/.](\d{1,2})(?:[-_/.](\d{2,4}))?/i,
  );
  if (pollToken) {
    const year = yearFromFilename(base, pollToken[3]);
    const iso = toIso(year, Number(pollToken[1]), Number(pollToken[2]));
    if (iso) return iso;
  }

  const isoDates = [...base.matchAll(/(20\d{2})[-_/.](\d{1,2})[-_/.](\d{1,2})/g)]
    .map((m) => toIso(Number(m[1]), Number(m[2]), Number(m[3])))
    .filter((v): v is string => Boolean(v));
  const mdY = [...base.matchAll(/(\d{1,2})[-_/.](\d{1,2})[-_/.](20\d{2})/g)]
    .map((m) => toIso(Number(m[3]), Number(m[1]), Number(m[2])))
    .filter((v): v is string => Boolean(v));

  const all = [...isoDates, ...mdY];
  if (all.length === 0) return null;
  if (all.length === 1) return all[0];
  return all[0];
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return `len:${text.length}`;
}
