/** Minimal CSV parser (handles quotes and commas). */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (ch === '\r') i++;
    } else if (ch === '\r') {
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }

  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1) };
}

/** Strip PDI path prefixes: "Names > First Name" → "first name" */
function normalizeHeader(h: string): string {
  const leaf = h.includes('>') ? h.split('>').pop()!.trim() : h.trim();
  return leaf.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function guessMapping(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const norms = headers.map((h) => ({ raw: h, n: normalizeHeader(h) }));

  const rules: [string, RegExp[]][] = [
    ['murmuration_id', [/murmuration/, /^murmuration id$/, /^murm id$/, /^vanid$/, /^van id$/]],
    ['voter_id', [/state voter id/, /^voter id$/, /^voterid$/]],
    ['first_name', [/^first name$/, /^firstname$/]],
    ['last_name', [/^last name$/, /^lastname$/]],
    ['email', [/^email$/, /email address/]],
    ['phone', [/phone number.*best known/, /best known/, /^phone$/]],
    ['age', [/^age$/]],
    ['address_line_1', [/address 1.*residence/, /^address 1$/, /^address$/, /^street$/]],
    ['city', [/city.*residence/, /^city$/]],
    ['county', [/county.*residence/, /^county$/]],
    ['zip', [/zip code.*residence/, /^zip$/, /^zip code$/, /^postal$/]],
    ['state', [/state.*residence/, /^state$/]],
    ['lat', [/latitude/, /^lat$/]],
    ['lng', [/longitude/, /^lng$/, /^long$/]],
    ['party', [/registered party/, /^party$/]],
    ['voter_registered', [/voter registered/]],
    ['status', [/voter status/, /^status$/]],
    ['sig_open_primaries', [/open primaries/]],
    ['sig_reproductive_freedom', [/^reproductive freedom signature$/]],
    ['sig_achilles_petition', [/achilles petition/]],
    ['sig_medical_cannabis', [/medical cannabis/]],
    ['sig_medical_marijuana_valid_code', [/medical marijuana.*valid/]],
    ['sig_reproductive_freedom_valid_code', [/reproductive freedom act valid/]],
    ['volunteer_interest', [/volunteer interest/]],
    ['yard_sign', [/yard sign/]],
    ['support_score', [/support score/]],
    ['newsletter', [/^newsletter$/]],
    ['legacy_volunteer', [/legacy volunteer/]],
    ['alignment_score', [/^alignment score$/]],
    ['top_main_topic', [/top main topic/]],
    ['alignment_label', [/alignment label/]],
    ['contact_tags', [/contact tags/]],
    ['convos_candidate_support', [/candidate support/]],
    ['convos_contact_status', [/contact status/]],
    ['convos_poll_question', [/poll question/]],
    ['donated', [/^donated$/]],
    ['attended_event', [/attended event/]],
  ];

  for (const [field, patterns] of rules) {
    const hit = norms.find((h) => patterns.some((p) => p.test(h.n)));
    if (hit) map[field] = hit.raw;
  }
  return map;
}

export function rowsToObjects(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
): Record<string, string>[] {
  const headerIndex = new Map(headers.map((h, i) => [h, i]));
  return rows.map((row) => {
    const obj: Record<string, string> = {};
    for (const [field, header] of Object.entries(mapping)) {
      if (!header) continue;
      const idx = headerIndex.get(header);
      if (idx === undefined) continue;
      obj[field] = (row[idx] ?? '').trim();
    }
    return obj;
  });
}

export function escapeCsvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Columns Excel likes to mangle into scientific notation / numbers. */
const EXCEL_TEXT_COLS = new Set([
  'murmuration_id',
  'voter_id',
  'phone',
  'zip',
]);

/** US phone as (XXX) XXX-XXXX so Excel won't treat it as a number. */
export function formatPhoneForExport(value: unknown): string {
  if (value == null || value === '') return '';
  const raw = String(value).trim();
  const digits = raw.replace(/\D/g, '');
  const ten =
    digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length === 10) {
    return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  }
  return raw;
}

/**
 * Excel text formula — keeps long IDs / zips as text instead of scientific
 * notation (same idea as FormHandler phone formatting with punctuation).
 */
function excelTextFormula(value: string): string {
  return `="${value.replace(/"/g, '""')}"`;
}

function looksNumericId(s: string): boolean {
  // Pure digits, or ZIP+4, long enough that Excel may switch to scientific.
  return /^\d{5,}(-\d{4})?$/.test(s);
}

/** Format one export cell for a known column name. */
export function formatExportCell(column: string, value: unknown): string {
  if (value == null || value === '') return '';

  if (column === 'phone') {
    return escapeCsvCell(formatPhoneForExport(value));
  }

  const s = String(value);
  if (EXCEL_TEXT_COLS.has(column) && looksNumericId(s.trim())) {
    return excelTextFormula(s.trim());
  }

  return escapeCsvCell(value);
}

export function votersToCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(escapeCsvCell).join(',');
  const lines = rows.map((r) =>
    columns.map((c) => formatExportCell(c, r[c])).join(','),
  );
  return [header, ...lines].join('\n');
}
