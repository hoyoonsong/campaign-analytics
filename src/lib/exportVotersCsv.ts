import { exportPage } from './api';
import { votersToCsv } from './csv';
import type { VoterFilters } from './types';

/** Hard cap — full-file downloads of ~177k rows take the voter origin down. */
export const MAX_EXPORT_ROWS = 20_000;

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

/** Paginate export RPC and download a single CSV. */
export async function downloadVotersCsv(opts: {
  filters: VoterFilters;
  filename: string;
  columns?: readonly string[];
  pageSize?: number;
}): Promise<{ count: number; truncated: boolean }> {
  const columns = [...(opts.columns ?? VOTER_EXPORT_COLS)];
  const chunks: string[] = [];
  let afterId: number | null = null;
  let first = true;
  let total = 0;
  let truncated = false;
  const pageSize = Math.min(opts.pageSize ?? 400, 400);

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
          exportedSoFar: total,
        });
        page = {
          rows: res.rows as unknown as Record<string, unknown>[],
          next_cursor: res.next_cursor,
          truncated: res.truncated,
        };
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (attempt < 4 && /429|another export/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
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
    truncated = truncated || Boolean(page.truncated);
    const csv = votersToCsv(batch, columns);
    if (first) {
      chunks.push(csv);
      first = false;
    } else {
      chunks.push(csv.split('\n').slice(1).join('\n'));
    }
    if (page.next_cursor == null || page.truncated || total >= MAX_EXPORT_ROWS) {
      truncated = truncated || Boolean(page.truncated);
      break;
    }
    afterId = page.next_cursor;
    await new Promise((r) => setTimeout(r, 350));
  }

  if (chunks.length === 0) {
    // Still emit a header-only file so the export action is visible.
    chunks.push(columns.map((c) => c).join(','));
  }

  // BOM so Excel opens UTF-8 correctly (same as FormHandler downloads).
  const blob = new Blob(['\uFEFF' + chunks.join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  downloadBlob(blob, opts.filename);
  return { count: total, truncated };
}

/** Brief pause so browsers allow multiple sequential downloads. */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
