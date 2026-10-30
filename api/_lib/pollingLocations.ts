import type { SupabaseClient } from '@supabase/supabase-js';
import counties from '../../src/data/idahoCounties.json' with { type: 'json' };
import { campaignAdminClient } from './campaign.js';
import { milesBetween } from './geo.js';

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

export type PollSiteView = {
  id: number;
  kind: PollingKind;
  name: string;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  zip: string | null;
  county: string | null;
  miles: number | null;
  lat: number | null;
  lng: number | null;
  precinct_names: string | null;
};

type Site = {
  id: number;
  kind: PollingKind;
  lat: number;
  lng: number;
  countyKey: string;
  name: string;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  zip: string | null;
  county: string | null;
  precinct_names: string | null;
};

type CountyFeature = {
  properties?: { name?: string };
  geometry?:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] };
};

const COUNTY_FEATURES = (
  counties as { features?: CountyFeature[] }
).features ?? [];

const ASSIGN_PAGE = 1000;
let siteCache: { at: number; sites: Site[] } | null = null;

export function clearPollingSiteCache() {
  siteCache = null;
}

export function pollingDbError(message: string): Error {
  if (/polling_locations|voter_nearest_polls|schema cache|does not exist|could not find the function/i.test(message)) {
    return new Error(
      'Polling locations are not in the database yet. Apply migration 0068 with APPLY_FROM=0068 npm run db:apply-campaign.',
    );
  }
  return new Error(message);
}

function countyKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/\bcounty\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function displayCounty(raw: string | null | undefined): string {
  const key = countyKey(raw);
  if (!key) return '';
  return key.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

function isActive(status: string | null | undefined): boolean {
  const trimmed = (status ?? '').trim();
  if (!trimmed) return true;
  return /^active$/i.test(trimmed);
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function countyForPoint(lat: number, lng: number): string | null {
  for (const feature of COUNTY_FEATURES) {
    const name = feature.properties?.name;
    const geometry = feature.geometry;
    if (!name || !geometry) continue;
    if (geometry.type === 'Polygon') {
      const [outer, ...holes] = geometry.coordinates;
      if (!outer || !pointInRing(lng, lat, outer)) continue;
      if (holes.some((hole) => pointInRing(lng, lat, hole))) continue;
      return name;
    }
    for (const polygon of geometry.coordinates) {
      const [outer, ...holes] = polygon;
      if (!outer || !pointInRing(lng, lat, outer)) continue;
      if (holes.some((hole) => pointInRing(lng, lat, hole))) continue;
      return name;
    }
  }
  return null;
}

function parseCsv(text: string): string[][] {
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
      } else if (ch === '"') inQuotes = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
      row.push(cell);
      cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      if (ch === '\r') i++;
    } else if (ch === '\r') {
      row.push(cell);
      cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function geocodeStreet(line1: string | null, line2: string | null): string {
  let street = (line1 ?? '').trim();
  const extra = (line2 ?? '').trim();
  if (/^(ste|suite|rm|room|apt|unit|#)\b/i.test(extra)) street = `${street} ${extra}`;
  return street
    .replace(/\b(ste|suite|rm|room|apt|unit)\b\.?\s*[#A-Za-z0-9-]+/gi, '')
    .replace(/\b(us|state)\s+hwy\b/gi, '$1 HIGHWAY')
    .replace(/\bhwy\b/gi, 'HIGHWAY')
    .replace(/\b([NS])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function geocodeCensusBatch(
  rows: Array<{ street: string; city: string; zip: string }>,
): Promise<Array<{ lat: number; lng: number } | null>> {
  const hits: Array<{ lat: number; lng: number } | null> = rows.map(() => null);
  if (rows.length === 0) return hits;
  const csv = rows
    .map((row, index) =>
      [
        String(index + 1),
        csvField(row.street),
        csvField(row.city),
        'ID',
        csvField(row.zip),
      ].join(','),
    )
    .join('\n');
  const form = new FormData();
  form.set('benchmark', 'Public_AR_Current');
  form.set('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
  const res = await fetch(
    'https://geocoding.geo.census.gov/geocoder/locations/addressbatch',
    { method: 'POST', body: form },
  );
  if (!res.ok) return hits;
  const parsed = parseCsv(await res.text());
  for (const record of parsed) {
    const index = Number(record[0]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) continue;
    if ((record[2] ?? '').toLowerCase() !== 'match') continue;
    const coords = (record[5] ?? '').split(',');
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    hits[index] = { lat, lng };
  }
  return hits;
}

function withCounty<T extends { county: string | null; lat: number | null; lng: number | null }>(
  row: T,
): T {
  if (countyKey(row.county) || row.lat == null || row.lng == null) return row;
  const name = countyForPoint(row.lat, row.lng);
  if (!name) return row;
  return { ...row, county: name };
}

function cleanImportRow(row: PollingImportRow, kind: PollingKind) {
  const name = (row.name ?? '').trim();
  const address = (row.address_line_1 ?? '').trim();
  if (!name && !address) return null;
  const key = (row.external_key ?? '').trim().slice(0, 180);
  if (!key) return null;
  return {
    kind,
    external_key: key,
    name: name || address,
    address_line_1: blankToNull(address),
    address_line_2: blankToNull(row.address_line_2),
    city: blankToNull(row.city),
    zip: blankToNull(row.zip),
    county: blankToNull(row.county),
    state: 'ID',
    status: blankToNull(row.status),
    availability: blankToNull(row.availability),
    precinct_combos: blankToNull(row.precinct_combos)?.slice(0, 500) ?? null,
    precinct_names: blankToNull(row.precinct_names)?.slice(0, 500) ?? null,
    poll_ids: blankToNull(row.poll_ids)?.slice(0, 300) ?? null,
    active_voters:
      typeof row.active_voters === 'number' && Number.isFinite(row.active_voters)
        ? Math.round(row.active_voters)
        : null,
    lat: null as number | null,
    lng: null as number | null,
  };
}

type StoredRow = NonNullable<ReturnType<typeof cleanImportRow>>;

async function geocodeRows(rows: StoredRow[]): Promise<StoredRow[]> {
  const pending = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.address_line_1 || row.city || row.zip);
  const batch = await geocodeCensusBatch(
    pending.map(({ row }) => ({
      street: geocodeStreet(row.address_line_1, row.address_line_2),
      city: (row.city ?? '').replace(/\bD ALENE\b/i, "D'ALENE"),
      zip: row.zip ?? '',
    })),
  ).catch(() => pending.map(() => null));

  const next = rows.slice();
  pending.forEach(({ index }, batchIndex) => {
    const hit = batch[batchIndex];
    if (!hit) return;
    next[index] = withCounty({ ...next[index], lat: hit.lat, lng: hit.lng });
  });
  return next;
}

async function selectKind(voter: SupabaseClient, kind: PollingKind) {
  const page = 1000;
  const out: Array<{
    id: number;
    external_key: string;
    lat: number | null;
    lng: number | null;
    county: string | null;
  }> = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await voter
      .from('polling_locations')
      .select('id, external_key, lat, lng, county')
      .eq('kind', kind)
      .range(from, from + page - 1);
    if (error) throw pollingDbError(error.message);
    const rows = (data ?? []) as typeof out;
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

async function selectAll<T>(
  voter: SupabaseClient,
  table: string,
  columns: string,
): Promise<T[]> {
  const page = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await voter
      .from(table)
      .select(columns)
      .range(from, from + page - 1);
    if (error) throw pollingDbError(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

export async function importPollingLocations(
  voter: SupabaseClient,
  kind: PollingKind,
  input: PollingImportRow[],
) {
  if (kind !== 'election_day' && kind !== 'early_voting') {
    throw new Error('kind must be election_day or early_voting');
  }
  const cleaned = input
    .slice(0, 3000)
    .map((row) => cleanImportRow(row, kind))
    .filter((row): row is StoredRow => row != null);
  if (cleaned.length === 0) throw new Error('No polling locations to import.');

  const located = await geocodeRows(cleaned);
  const existing = await selectKind(voter, kind);
  const previous = new Map(existing.map((row) => [row.external_key, row]));

  const payload = located.map((row) => {
    const prior = previous.get(row.external_key);
    const lat = row.lat ?? prior?.lat ?? null;
    const lng = row.lng ?? prior?.lng ?? null;
    const county =
      row.county ??
      (lat != null && lng != null ? countyForPoint(lat, lng) : null) ??
      prior?.county ??
      null;
    return { ...row, lat, lng, county };
  });

  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await voter
      .from('polling_locations')
      .upsert(payload.slice(i, i + 200), { onConflict: 'kind,external_key' });
    if (error) throw pollingDbError(error.message);
  }

  const keep = new Set(payload.map((row) => row.external_key));
  const remove = (await selectKind(voter, kind))
    .filter((row) => !keep.has(row.external_key))
    .map((row) => row.id);
  for (let i = 0; i < remove.length; i += 100) {
    const { error } = await voter
      .from('polling_locations')
      .delete()
      .in('id', remove.slice(i, i + 100));
    if (error) throw pollingDbError(error.message);
  }

  clearPollingSiteCache();
  const geocoded = payload.filter((row) => row.lat != null && row.lng != null).length;
  return {
    kind,
    saved: payload.length,
    geocoded,
    ungeocoded: payload.length - geocoded,
  };
}

export async function geocodeMissingPollingLocations(voter: SupabaseClient) {
  const { data, error } = await voter
    .from('polling_locations')
    .select('id, name, address_line_1, address_line_2, city, zip, county')
    .is('lat', null)
    .limit(200);
  if (error) throw pollingDbError(error.message);
  const rows = data ?? [];
  if (rows.length === 0) return { geocoded: 0, remaining: 0 };

  const hits = await geocodeCensusBatch(
    rows.map((row) => ({
      street: geocodeStreet(row.address_line_1, row.address_line_2),
      city: (row.city ?? '').replace(/\bD ALENE\b/i, "D'ALENE"),
      zip: row.zip ?? '',
    })),
  ).catch(() => rows.map(() => null));

  let geocoded = 0;
  for (let i = 0; i < rows.length; i++) {
    const hit = hits[i];
    if (!hit) continue;
    const county = rows[i].county || countyForPoint(hit.lat, hit.lng);
    const { error: updateError } = await voter
      .from('polling_locations')
      .update({ lat: hit.lat, lng: hit.lng, county })
      .eq('id', rows[i].id);
    if (updateError) throw pollingDbError(updateError.message);
    geocoded += 1;
  }

  const { count, error: countError } = await voter
    .from('polling_locations')
    .select('id', { count: 'exact', head: true })
    .is('lat', null);
  if (countError) throw pollingDbError(countError.message);
  clearPollingSiteCache();
  return { geocoded, remaining: count ?? 0 };
}

function nearestSite(
  lat: number,
  lng: number,
  voterCounty: string,
  sites: Site[],
): { id: number; miles: number } | null {
  const key = countyKey(voterCounty);
  let pool = key ? sites.filter((site) => site.countyKey === key) : [];
  if (pool.length === 0) pool = sites;
  let best: Site | null = null;
  let bestMiles = Infinity;
  for (const site of pool) {
    const miles = milesBetween(lat, lng, site.lat, site.lng);
    if (miles < bestMiles) {
      bestMiles = miles;
      best = site;
    }
  }
  if (!best) return null;
  return { id: best.id, miles: Math.round(bestMiles * 100) / 100 };
}

async function loadSites(voter: SupabaseClient, fresh = false): Promise<Site[]> {
  if (!fresh && siteCache && Date.now() - siteCache.at < 60_000) return siteCache.sites;
  const rows = await selectAll<{
    id: number;
    kind: PollingKind;
    lat: number | null;
    lng: number | null;
    county: string | null;
    status: string | null;
    name: string;
    address_line_1: string | null;
    address_line_2: string | null;
    city: string | null;
    zip: string | null;
    precinct_names: string | null;
  }>(
    voter,
    'polling_locations',
    'id, kind, lat, lng, county, status, name, address_line_1, address_line_2, city, zip, precinct_names',
  );
  const sites = rows
    .filter(
      (row) =>
        isActive(row.status) &&
        row.lat != null &&
        row.lng != null &&
        Number.isFinite(row.lat) &&
        Number.isFinite(row.lng),
    )
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      lat: row.lat as number,
      lng: row.lng as number,
      countyKey: countyKey(row.county),
      name: row.name,
      address_line_1: row.address_line_1,
      address_line_2: row.address_line_2,
      city: row.city,
      zip: row.zip,
      county: row.county,
      precinct_names: row.precinct_names,
    }));
  siteCache = { at: Date.now(), sites };
  return sites;
}

function toView(site: Site, miles: number | null): PollSiteView {
  return {
    id: site.id,
    kind: site.kind,
    name: site.name,
    address_line_1: site.address_line_1,
    address_line_2: site.address_line_2,
    city: site.city,
    zip: site.zip,
    county: site.county,
    miles,
    lat: site.lat,
    lng: site.lng,
    precinct_names: site.precinct_names,
  };
}

export async function assignNearestPollingChunk(
  voter: SupabaseClient,
  afterId: number,
) {
  const sites = await loadSites(voter, afterId <= 0);
  const election = sites.filter((site) => site.kind === 'election_day');
  const early = sites.filter((site) => site.kind === 'early_voting');

  let total: number | null = null;
  if (afterId <= 0) {
    const { count } = await voter
      .from('voters')
      .select('id', { count: 'exact', head: true })
      .not('lat', 'is', null)
      .not('lng', 'is', null);
    total = count ?? null;
  }

  const { data, error } = await voter
    .from('voters')
    .select('id, lat, lng, county')
    .not('lat', 'is', null)
    .not('lng', 'is', null)
    .gt('id', afterId)
    .order('id', { ascending: true })
    .limit(ASSIGN_PAGE);
  if (error) throw pollingDbError(error.message);

  const people = (data ?? []) as Array<{
    id: number;
    lat: number;
    lng: number;
    county: string | null;
  }>;

  const updates = people
    .filter((person) => Number.isFinite(person.lat) && Number.isFinite(person.lng))
    .filter((person) => !(person.lat === 0 && person.lng === 0))
    .map((person) => {
      const day = nearestSite(person.lat, person.lng, person.county ?? '', election);
      const vote = nearestSite(person.lat, person.lng, person.county ?? '', early);
      return {
        voter_id: person.id,
        election_day_id: day?.id ?? null,
        election_day_miles: day?.miles ?? null,
        early_voting_id: vote?.id ?? null,
        early_voting_miles: vote?.miles ?? null,
      };
    });

  for (let i = 0; i < updates.length; i += 400) {
    const { error: upsertError } = await voter
      .from('voter_nearest_polls')
      .upsert(updates.slice(i, i + 400), { onConflict: 'voter_id' });
    if (upsertError) throw pollingDbError(upsertError.message);
  }

  const done = people.length < ASSIGN_PAGE;
  if (done) {
    const { error: refreshError } = await voter.rpc('refresh_polling_assigned_counts');
    if (refreshError) throw pollingDbError(refreshError.message);
    clearPollingSiteCache();
  }

  return {
    assigned: updates.length,
    after_id: people.length ? people[people.length - 1].id : afterId,
    done,
    total,
  };
}

export async function listPollingLocations(voter: SupabaseClient) {
  const rows = await selectAll<{
    id: number;
    kind: PollingKind;
    name: string;
    address_line_1: string | null;
    city: string | null;
    zip: string | null;
    county: string | null;
    lat: number | null;
    lng: number | null;
    precinct_names: string | null;
    assigned_count: number | null;
    active_voters: number | null;
    status: string | null;
  }>(
    voter,
    'polling_locations',
    'id, kind, name, address_line_1, city, zip, county, lat, lng, precinct_names, assigned_count, active_voters, status',
  );
  const active = rows.filter((row) => isActive(row.status));
  const locations = active
    .filter((row) => row.lat != null && row.lng != null)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      address_line_1: row.address_line_1,
      city: row.city,
      zip: row.zip,
      county: row.county,
      lat: row.lat as number,
      lng: row.lng as number,
      precinct_names: row.precinct_names,
      assigned_count: row.assigned_count ?? 0,
      active_voters:
        row.kind === 'election_day' && row.active_voters != null && row.active_voters > 0
          ? row.active_voters
          : null,
    }));
  return {
    locations,
    summary: {
      election_day: active.filter((row) => row.kind === 'election_day').length,
      early_voting: active.filter((row) => row.kind === 'early_voting').length,
      plotted: locations.length,
      ungeocoded: active.filter((row) => row.lat == null || row.lng == null).length,
    },
  };
}

export async function pollingLinks(
  voter: SupabaseClient,
  county: string,
  kind: PollingKind,
) {
  const { data, error } = await voter.rpc('polling_assignment_links', {
    p_county: county,
    p_kind: kind,
  });
  if (error) throw pollingDbError(error.message);
  const body = (data ?? {}) as {
    total?: number;
    truncated?: boolean;
    links?: number[][];
  };
  return {
    total: body.total ?? 0,
    truncated: Boolean(body.truncated),
    links: Array.isArray(body.links) ? body.links : [],
  };
}

export async function pollsForVoter(
  voter: SupabaseClient,
  person: {
    id: number;
    lat?: number | null;
    lng?: number | null;
    county?: string | null;
  },
): Promise<{ election_day: PollSiteView | null; early_voting: PollSiteView | null } | null> {
  const { data, error } = await voter
    .from('voter_nearest_polls')
    .select('election_day_id, election_day_miles, early_voting_id, early_voting_miles')
    .eq('voter_id', person.id)
    .maybeSingle();
  if (error) {
    if (/does not exist|schema cache|voter_nearest_polls/i.test(error.message)) return null;
    throw pollingDbError(error.message);
  }

  const sites = await loadSites(voter).catch((err: Error) => {
    if (/does not exist|schema cache|polling_locations/i.test(err.message)) return null;
    throw err;
  });
  if (!sites) return null;
  if (sites.length === 0 && data?.election_day_id == null && data?.early_voting_id == null) {
    return null;
  }

  const byId = new Map(sites.map((site) => [site.id, site]));
  const storedDay = data?.election_day_id != null ? byId.get(data.election_day_id) : undefined;
  const storedEarly = data?.early_voting_id != null ? byId.get(data.early_voting_id) : undefined;
  let election = storedDay ? toView(storedDay, data?.election_day_miles ?? null) : null;
  let early = storedEarly ? toView(storedEarly, data?.early_voting_miles ?? null) : null;

  const lat = person.lat == null ? null : Number(person.lat);
  const lng = person.lng == null ? null : Number(person.lng);
  if ((election == null || early == null) && lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    const day = election
      ? null
      : nearestSite(lat, lng, person.county ?? '', sites.filter((site) => site.kind === 'election_day'));
    const vote = early
      ? null
      : nearestSite(lat, lng, person.county ?? '', sites.filter((site) => site.kind === 'early_voting'));
    if (day) election = toView(byId.get(day.id) as Site, day.miles);
    if (vote) early = toView(byId.get(vote.id) as Site, vote.miles);
    if (day || vote) {
      await voter.from('voter_nearest_polls').upsert(
        {
          voter_id: person.id,
          election_day_id: election?.id ?? null,
          election_day_miles: election?.miles ?? null,
          early_voting_id: early?.id ?? null,
          early_voting_miles: early?.miles ?? null,
        },
        { onConflict: 'voter_id' },
      );
    }
  }

  return { election_day: election, early_voting: early };
}

type YardSignPoint = {
  name: string | null;
  address: string | null;
  lat: number;
  lng: number;
  is_big: boolean;
};

async function loadYardSigns(): Promise<YardSignPoint[]> {
  const campaign = campaignAdminClient();
  const page = 1000;
  const out: YardSignPoint[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await campaign
      .from('yard_signs')
      .select('name, address, lat, lng, is_big')
      .not('lat', 'is', null)
      .not('lng', 'is', null)
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    for (const row of rows) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      out.push({
        name: (row.name as string | null) ?? null,
        address: (row.address as string | null) ?? null,
        lat,
        lng,
        is_big: row.is_big === true,
      });
    }
    if (rows.length < page) break;
  }
  return out;
}

export async function pollingCountyRanks(voter: SupabaseClient) {
  const [{ data, error }, sites] = await Promise.all([
    voter.rpc('county_voter_counts'),
    selectAll<{
      county: string | null;
      kind: string;
      active_voters: number | null;
      status: string | null;
    }>(voter, 'polling_locations', 'county, kind, active_voters, status'),
  ]);
  if (error) throw pollingDbError(error.message);
  const known = new Set(
    COUNTY_FEATURES.map((feature) => countyKey(feature.properties?.name)).filter(Boolean),
  );
  const inFile = new Map<string, { name: string; voters: number }>();
  for (const row of (data ?? []) as Array<{ county?: string | null; voters?: number | string }>) {
    const key = countyKey(row.county);
    if (!key || !known.has(key)) continue;
    const name = displayCounty(row.county);
    const voters = Number(row.voters) || 0;
    const prev = inFile.get(key);
    if (prev) prev.voters += voters;
    else inFile.set(key, { name, voters });
  }
  const registered = new Map<string, { name: string; voters: number }>();
  for (const row of sites) {
    if (row.kind !== 'election_day' || !isActive(row.status)) continue;
    const key = countyKey(row.county);
    if (!key || !known.has(key)) continue;
    const prev = registered.get(key);
    const voters = Number(row.active_voters) || 0;
    if (prev) prev.voters += voters;
    else registered.set(key, { name: displayCounty(row.county), voters });
  }
  const keys = new Set([...inFile.keys(), ...registered.keys()]);
  const counties = [...keys]
    .map((key) => {
      const official = registered.get(key)?.voters ?? 0;
      const file = inFile.get(key)?.voters ?? 0;
      return {
        name: registered.get(key)?.name ?? inFile.get(key)?.name ?? displayCounty(key),
        voters: official > 0 ? official : file,
        in_file: file,
      };
    })
    .sort((a, b) => b.voters - a.voters || a.name.localeCompare(b.name));
  return { counties };
}

export async function pollingYardSignGaps(voter: SupabaseClient, county: string) {
  const key = countyKey(county);
  if (!key) throw new Error('county is required');
  const [locations, signs] = await Promise.all([
    selectAll<{
      id: number;
      kind: PollingKind;
      name: string;
      address_line_1: string | null;
      city: string | null;
      zip: string | null;
      county: string | null;
      lat: number | null;
      lng: number | null;
      status: string | null;
    }>(
      voter,
      'polling_locations',
      'id, kind, name, address_line_1, city, zip, county, lat, lng, status',
    ),
    loadYardSigns(),
  ]);

  const sites = locations
    .filter(
      (row) =>
        isActive(row.status) &&
        countyKey(row.county) === key &&
        row.lat != null &&
        row.lng != null,
    )
    .map((row) => {
      let best: YardSignPoint | null = null;
      let bestMiles = Infinity;
      for (const sign of signs) {
        const miles = milesBetween(row.lat as number, row.lng as number, sign.lat, sign.lng);
        if (miles < bestMiles) {
          bestMiles = miles;
          best = sign;
        }
      }
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        address_line_1: row.address_line_1,
        city: row.city,
        zip: row.zip,
        lat: row.lat as number,
        lng: row.lng as number,
        miles: best ? bestMiles : null,
        nearest_is_big: best ? best.is_big : null,
        nearest_name: best?.name ?? null,
        nearest_address: best?.address ?? null,
        nearest_lat: best ? best.lat : null,
        nearest_lng: best ? best.lng : null,
      };
    })
    .sort((a, b) => {
      if (a.miles == null && b.miles == null) return a.name.localeCompare(b.name);
      if (a.miles == null) return -1;
      if (b.miles == null) return 1;
      return b.miles - a.miles || a.name.localeCompare(b.name);
    })
    .map((site) => ({
      ...site,
      miles: site.miles == null ? null : Math.round(site.miles * 100) / 100,
    }));

  return {
    county: displayCounty(county),
    yard_sign_count: signs.length,
    big_yard_sign_count: signs.filter((sign) => sign.is_big).length,
    sites,
  };
}
