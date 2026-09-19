import { exportPage } from './api';
import { votersToCsv } from './csv';
import { filtersActive } from './filters';
import type { VoterFilters } from './types';

/** Hard cap for an unfiltered whole-file dump — that is what took the origin down. */
export const MAX_EXPORT_ROWS = 20_000;

/** Filtered lists split into this many rows per file so the database can breathe. */
export const EXPORT_FILE_ROWS = 20_000;

const PAGE_PAUSE_MS = 450;
const FILE_PAUSE_MS = 1_600;

/** Shared columns for voter + petition combo exports. */
export const VOTER_EXPORT_COLS = [
  'murmuration_id',
  'voter_id',
  'first_name',
  'last_name',
  'email',
  'phone',
  'age',
  'address_line_1',
  'city',
  'zip',
  'state',
  'lat',
  'lng',
  'party',
  'support_score',
  'volunteer_interest',
  'yard_sign',
  'donated',
  'attended_event',
  'supporter_tag',
  'sig_open_primaries',
  'sig_reproductive_freedom',
  'sig_medical_marijuana_valid_code',
  'nearby_yard_sign_miles',
  'nearby_volunteer_miles',
] as const;

export type ExportProgress = {
  rows: number;
  fileIndex: number;
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  // Detached anchors are ignored in Firefox/Safari; keep it in the DOM briefly.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function partFilename(filename: string, index: number, split: boolean): string {
  if (!split) return filename;
  const dot = filename.lastIndexOf('.');
  const base = dot >= 0 ? filename.slice(0, dot) : filename;
  const ext = dot >= 0 ? filename.slice(dot) : '.csv';
  return `${base}-part${index}${ext}`;
}

function emitCsv(chunks: string[], columns: string[], filename: string) {
  const body = chunks.length ? chunks.join('\n') : columns.join(',');
  const blob = new Blob(['\uFEFF' + body], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, filename);
}

/** Paginate export RPC and download one or more CSVs. */
export async function downloadVotersCsv(opts: {
  filters: VoterFilters;
  filename: string;
  columns?: readonly string[];
  pageSize?: number;
  /** Stop after this many rows. Unfiltered dumps default to MAX_EXPORT_ROWS. */
  maxRows?: number;
  /** Start a new file after this many rows. `null` keeps everything in one file. */
  splitEvery?: number | null;
  /** Skip nearby/tag enrichment so large filtered dumps stay cheap. */
  lean?: boolean;
  onProgress?: (progress: ExportProgress) => void;
}): Promise<{ count: number; truncated: boolean; files: number }> {
  const columns = [...(opts.columns ?? VOTER_EXPORT_COLS)];
  const unfiltered = !filtersActive(opts.filters);
  const maxRows = opts.maxRows ?? (unfiltered ? MAX_EXPORT_ROWS : Number.POSITIVE_INFINITY);
  const splitEvery =
    opts.splitEvery === null
      ? Number.POSITIVE_INFINITY
      : Math.max(1, opts.splitEvery ?? (unfiltered ? maxRows : EXPORT_FILE_ROWS));
  const lean = opts.lean ?? !unfiltered;
  const pageSize = Math.min(opts.pageSize ?? 400, 400);

  let chunks: string[] = [];
  let afterId: number | null = null;
  let firstInFile = true;
  let total = 0;
  let fileRows = 0;
  let fileIndex = 1;
  let truncated = false;

  const flush = (moreComing: boolean) => {
    if (!chunks.length && firstInFile) return;
    emitCsv(chunks, columns, partFilename(opts.filename, fileIndex, moreComing || fileIndex > 1));
    chunks = [];
    firstInFile = true;
    fileRows = 0;
    fileIndex += 1;
  };

  for (;;) {
    let page: {
      rows: Record<string, unknown>[];
      next_cursor: number | null;
      truncated?: boolean;
    };
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await exportPage({
          filters: opts.filters,
          afterId,
          limit: pageSize,
          exportedSoFar: unfiltered ? total : 0,
          lean,
        });
        page = {
          rows: res.rows as unknown as Record<string, unknown>[],
          next_cursor: res.next_cursor,
          truncated: res.truncated,
        };
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (attempt < 6 && /429|another export/i.test(msg)) {
          await sleep(900 * attempt);
          continue;
        }
        throw err;
      }
    }

    const batch = page.rows;
    if (!batch?.length) {
      truncated = truncated || Boolean(page.truncated);
      break;
    }

    total += batch.length;
    fileRows += batch.length;
    truncated = truncated || Boolean(page.truncated);
    const csv = votersToCsv(batch, columns);
    if (firstInFile) {
      chunks.push(csv);
      firstInFile = false;
    } else {
      chunks.push(csv.split('\n').slice(1).join('\n'));
    }

    opts.onProgress?.({ rows: total, fileIndex });

    const hitCap = total >= maxRows;
    const hitSplit = fileRows >= splitEvery;
    const hasMore = page.next_cursor != null && !page.truncated && !hitCap;
    if (hitSplit || !hasMore) {
      flush(hasMore);
      if (!hasMore) break;
      await sleep(FILE_PAUSE_MS);
    }

    if (hitCap) {
      truncated = true;
      break;
    }
    afterId = page.next_cursor;
    await sleep(PAGE_PAUSE_MS);
  }

  if (chunks.length) {
    flush(false);
  } else if (total === 0) {
    emitCsv([], columns, opts.filename);
  }

  return { count: total, truncated, files: Math.max(1, fileIndex - 1) };
}

/** Brief pause so browsers allow multiple sequential downloads. */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
