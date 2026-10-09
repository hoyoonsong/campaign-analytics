import { parseCsv } from './csv';
import { parseXlsx } from './xlsxLite';

export type PollingKind = 'election_day' | 'early_voting';

export type PollingImportRow = {
  external_key: string;
  name: string;
  address_line_1: string;
  address_line_2: string;
  city: string;
  zip: string;
  county: string;
  status: string;
  availability: string;
  precinct_combos: string;
  precinct_names: string;
  poll_ids: string;
  active_voters: number | null;
};

export type PollingFilePreview = {
  filename: string;
  kind: PollingKind;
  locations: PollingImportRow[];
  sourceRows: number;
  countyCount: number;
};

export type PollMapLocation = {
  id: number;
  kind: PollingKind;
  name: string;
  address_line_1: string | null;
  city: string | null;
  zip: string | null;
  county: string | null;
  lat: number;
  lng: number;
  precinct_names: string | null;
  assigned_count: number;
};

export function countyKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/\bcounty\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function displayCounty(raw: string | null | undefined): string {
  const key = countyKey(raw);
  if (!key) return '';
  return key.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

export function pollingKindLabel(kind: PollingKind): string {
  return kind === 'early_voting' ? 'Early voting' : 'Election day';
}

function headerKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function detectPollingKind(headers: string[]): PollingKind | null {
  const keys = new Set(headers.map(headerKey));
  const has = (...names: string[]) => names.every((name) => keys.has(name));
  if (!has('name', 'address 1', 'city', 'county')) return null;
  if (keys.has('precinct names') || keys.has('total precincts') || keys.has('active voters')) {
    return 'election_day';
  }
  if (keys.has('poll id') && keys.has('location status')) return 'early_voting';
  return null;
}

function normalizeZip(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 5) return digits.slice(0, 5);
  return digits;
}

function normToken(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseCount(raw: string): number | null {
  const n = Number(raw.replace(/,/g, '').trim());
  return Number.isFinite(n) ? Math.round(n) : null;
}

function cell(row: string[], index: number): string {
  return (row[index] ?? '').trim();
}

function joinUnique(values: string[], max = 500): string {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out.join(', ').slice(0, max);
}

export function rowsToPollingLocations(
  headers: string[],
  rows: string[][],
): { kind: PollingKind; locations: PollingImportRow[]; sourceRows: number } {
  const kind = detectPollingKind(headers);
  if (!kind) {
    throw new Error(
      'This file does not look like the statewide polling list or the early-voting list.',
    );
  }
  const index = new Map(headers.map((header, i) => [headerKey(header), i]));
  const col = (name: string) => index.get(name) ?? -1;
  const iCombo = col('precinct combo');
  const iPoll = col('poll id');
  const iNames = col('precinct names');
  const iName = col('name');
  const iAddr1 = col('address 1');
  const iAddr2 = col('address 2');
  const iCity = col('city');
  const iZip = col('zip');
  const iStatus = col('location status');
  const iAvail = col('location availability');
  const iCounty = col('county');
  const iVoters = col('active voters');

  type Bucket = PollingImportRow & { pollSeen: string[] };
  const buckets = new Map<string, Bucket>();
  let sourceRows = 0;

  for (const row of rows) {
    const name = cell(row, iName);
    const address = cell(row, iAddr1);
    if (!name && !address) continue;
    sourceRows += 1;
    const city = cell(row, iCity);
    const county = displayCounty(cell(row, iCounty)) || cell(row, iCounty);
    const streetKey = normToken(address) || normToken(name);
    const key = `${kind}|${countyKey(county) || 'unknown'}|${streetKey}|${normToken(city)}`.slice(
      0,
      180,
    );
    const pollId = cell(row, iPoll);
    const voters = iVoters >= 0 ? parseCount(cell(row, iVoters)) : null;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        external_key: key,
        name,
        address_line_1: address,
        address_line_2: cell(row, iAddr2),
        city,
        zip: normalizeZip(cell(row, iZip)),
        county,
        status: cell(row, iStatus),
        availability: cell(row, iAvail),
        precinct_combos: cell(row, iCombo),
        precinct_names: cell(row, iNames),
        poll_ids: pollId,
        active_voters: voters,
        pollSeen: pollId ? [pollId] : [],
      });
      continue;
    }
    if (name && !existing.name.split(' · ').includes(name)) {
      existing.name = joinUnique([existing.name, name], 300);
    }
    if (!existing.address_line_2) existing.address_line_2 = cell(row, iAddr2);
    if (/active/i.test(cell(row, iStatus))) existing.status = cell(row, iStatus);
    existing.precinct_combos = joinUnique(
      [existing.precinct_combos, cell(row, iCombo)].join(',').split(','),
    );
    existing.precinct_names = joinUnique(
      [existing.precinct_names, cell(row, iNames)].join(',').split(','),
    );
    if (pollId && !existing.pollSeen.includes(pollId)) {
      existing.pollSeen.push(pollId);
      existing.poll_ids = joinUnique(existing.pollSeen, 300);
      if (voters != null) existing.active_voters = (existing.active_voters ?? 0) + voters;
    }
  }

  const locations = [...buckets.values()].map((bucket) => ({
    external_key: bucket.external_key,
    name: bucket.name,
    address_line_1: bucket.address_line_1,
    address_line_2: bucket.address_line_2,
    city: bucket.city,
    zip: bucket.zip,
    county: bucket.county,
    status: bucket.status,
    availability: bucket.availability,
    precinct_combos: bucket.precinct_combos,
    precinct_names: bucket.precinct_names,
    poll_ids: bucket.poll_ids,
    active_voters: bucket.active_voters,
  }));
  if (locations.length === 0) {
    throw new Error('No polling locations were found in this file.');
  }
  return { kind, locations, sourceRows };
}

function tableFromGrid(grid: string[][]): { headers: string[]; rows: string[][] } {
  const headerAt = grid.findIndex((row) => detectPollingKind(row));
  if (headerAt < 0) {
    throw new Error(
      'This file does not look like the statewide polling list or the early-voting list.',
    );
  }
  return {
    headers: grid[headerAt].map((cell) => cell.trim()),
    rows: grid.slice(headerAt + 1),
  };
}

export async function readPollingFile(file: File): Promise<PollingFilePreview> {
  let headers: string[];
  let rows: string[][];
  if (/\.csv$/i.test(file.name)) {
    const parsed = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
    headers = parsed.headers;
    rows = parsed.rows;
  } else if (/\.xlsx$/i.test(file.name)) {
    const grid = await parseXlsx(await file.arrayBuffer());
    const table = tableFromGrid(grid);
    headers = table.headers;
    rows = table.rows;
  } else {
    throw new Error('Choose the .xlsx file from the state, or a .csv with the same columns.');
  }

  const parsed = rowsToPollingLocations(headers, rows);
  const counties = new Set(parsed.locations.map((row) => countyKey(row.county)).filter(Boolean));
  return {
    filename: file.name,
    kind: parsed.kind,
    locations: parsed.locations,
    sourceRows: parsed.sourceRows,
    countyCount: counties.size,
  };
}
