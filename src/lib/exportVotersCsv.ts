import { exportPage } from './api';
import { votersToCsv } from './csv';
import type { VoterFilters } from './types';

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
}): Promise<number> {
  const columns = [...(opts.columns ?? VOTER_EXPORT_COLS)];
  const chunks: string[] = [];
  let afterId: number | null = null;
  let first = true;
  let total = 0;

  for (;;) {
    const { rows: batch, next_cursor } = await exportPage({
      filters: opts.filters,
      afterId,
      limit: opts.pageSize ?? 1000,
    });
    if (!batch?.length) break;
    total += batch.length;
    const csv = votersToCsv(
      batch as unknown as Record<string, unknown>[],
      columns,
    );
    if (first) {
      chunks.push(csv);
      first = false;
    } else {
      chunks.push(csv.split('\n').slice(1).join('\n'));
    }
    if (next_cursor == null) break;
    afterId = next_cursor;
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
  return total;
}

/** Brief pause so browsers allow multiple sequential downloads. */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
