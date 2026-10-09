import { toFilterPayload } from './filters';
import { supabase } from './supabase';
import type {
  AnalyticsSummary,
  CampaignSyncState,
  DbUsage,
  MapPoint,
  SavedUniverse,
  VoterFilters,
  VoterRow,
} from './types';
import type {
  ParsedPollRow,
  PreviewSummary,
  TrackingPoll,
  TrackingPollImport,
  TrackingPollResponse,
} from './trackingPoll/types';
import type { VoterHit } from './trackingPoll/match';
import type { AbsenteeDashboard, AbsenteeElection, AbsenteeGroup } from './absentee';
import type { PollMapLocation, PollingImportRow } from './pollingLocations';
import { normalizeAbsenteeDashboard } from './absentee';

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function sanitizeApiError(raw: string, status: number): string {
  const text = raw.trim();
  if (status === 401 || /^unauthorized$/i.test(text)) {
    return 'API rejected the session. Stop other Vite processes, run `npm run dev`, then refresh.';
  }
  if (
    /<!DOCTYPE html/i.test(text) ||
    /<html[\s>]/i.test(text) ||
    /cf-error-details|Error code 522|522: Connection timed out/i.test(text) ||
    /aborted/i.test(text)
  ) {
    return 'Voter database timed out. Wait a minute and refresh — this is Supabase, not a local crash.';
  }
  if (text.length > 240) {
    return `Request failed (${status}).`;
  }
  return text || `Request failed (${status})`;
}

function readAnalyticsCache(): { at: number; data: AnalyticsSummary } | null {
  if (typeof sessionStorage === 'undefined') return null;
  const keys = [
    'analytics_summary_empty_v5',
    'analytics_summary_empty_v4',
  ];
  const stores = [sessionStorage, localStorage];
  for (const store of stores) {
    for (const cacheKey of keys) {
      try {
        const raw = store.getItem(cacheKey);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as { at?: number; data?: AnalyticsSummary };
        if (parsed?.data && Array.isArray(parsed.data.petition_combos)) {
          return { at: parsed.at ?? 0, data: parsed.data };
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function writeAnalyticsCache(data: AnalyticsSummary) {
  const payload = JSON.stringify({ at: Date.now(), data });
  try {
    sessionStorage.setItem('analytics_summary_empty_v5', payload);
    localStorage.setItem('analytics_summary_empty_v5', payload);
  } catch {
    /* ignore */
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders();
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error('API unreachable. Restart with `npm run dev`.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw =
      typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`;
    throw new Error(sanitizeApiError(raw, res.status));
  }
  return body as T;
}

export async function fetchAnalytics(
  filters: VoterFilters,
  _chartPetitions?: string[] | null,
) {
  // Petition picker is sliced client-side from the full-universe summary.
  // Sending slugs used to bust the cache and flash the 3-default snapshot.
  const payload = toFilterPayload(filters);
  const empty = Object.keys(payload).length === 0;
  const stale = empty ? readAnalyticsCache() : null;

  if (stale) {
    return stale.data;
  }

  try {
    const data = await apiFetch<AnalyticsSummary>('/api/voter/analytics', {
      method: 'POST',
      body: JSON.stringify({ filters: payload }),
    });

    const complete =
      (data.by_signature?.length ?? 0) >= 4 ||
      (data.petitions?.length ?? 0) >= 4;
    if (empty && complete) writeAnalyticsCache(data);
    return data;
  } catch (err) {
    const fallback = empty ? readAnalyticsCache() : null;
    if (fallback) return fallback.data;
    throw err;
  }
}

const CAMPAIGN_GEO_KEY = 'campaign_geo_v1';

function readCampaignGeoCache(): {
  campaign_geo?: Array<{
    kind: 'volunteer' | 'yard_sign';
    lat: number;
    lng: number;
    source_id?: string;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  }>;
} | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw =
      sessionStorage.getItem(CAMPAIGN_GEO_KEY) ??
      localStorage.getItem(CAMPAIGN_GEO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { campaign_geo?: unknown };
    if (Array.isArray(parsed?.campaign_geo) && parsed.campaign_geo.length) {
      return parsed as { campaign_geo: Array<{
        kind: 'volunteer' | 'yard_sign';
        lat: number;
        lng: number;
        source_id?: string;
        name?: string | null;
        email?: string | null;
        phone?: string | null;
        address?: string | null;
      }> };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeCampaignGeoCache(data: { campaign_geo?: unknown }) {
  if (!Array.isArray(data.campaign_geo) || !data.campaign_geo.length) return;
  try {
    const raw = JSON.stringify({ campaign_geo: data.campaign_geo });
    sessionStorage.setItem(CAMPAIGN_GEO_KEY, raw);
    localStorage.setItem(CAMPAIGN_GEO_KEY, raw);
  } catch {
    /* ignore */
  }
}

export function fetchMapPoints(filters: VoterFilters, limit = 2500) {
  return apiFetch<{
    points: MapPoint[];
    returned: number;
    total_with_coords: number;
    truncated: boolean;
    campaign_geo?: Array<{
      kind: 'volunteer' | 'yard_sign';
      lat: number;
      lng: number;
      source_id?: string;
      name?: string | null;
      email?: string | null;
      phone?: string | null;
      address?: string | null;
    }>;
  }>('/api/voter/map-points', {
    method: 'POST',
    body: JSON.stringify({ filters: toFilterPayload(filters), limit }),
  });
}

export async function fetchMapCampaignGeo() {
  const cached = readCampaignGeoCache();
  if (cached) return cached;
  try {
    const data = await apiFetch<{
      campaign_geo?: Array<{
        kind: 'volunteer' | 'yard_sign';
        lat: number;
        lng: number;
        source_id?: string;
        name?: string | null;
        email?: string | null;
        phone?: string | null;
        address?: string | null;
      }>;
    }>('/api/voter/map-points', {
      method: 'POST',
      body: JSON.stringify({ geo_only: true }),
    });
    writeCampaignGeoCache(data);
    return data;
  } catch {
    return { campaign_geo: [] };
  }
}

export function fetchMapSnapshot(county: string, haveVersion?: number | null) {
  return apiFetch<{
    unchanged?: boolean;
    version: number;
    county: string;
    count: number;
    ids?: number[];
    lat?: number[];
    lng?: number[];
  }>('/api/voter/map-snapshot', {
    method: 'POST',
    body: JSON.stringify({
      county,
      have_version: haveVersion ?? null,
    }),
  });
}

export function fetchSearch(opts: {
  filters: VoterFilters;
  q?: string;
  page?: number;
  pageSize?: number;
}) {
  return apiFetch<{ rows: VoterRow[]; total: number; page: number; page_size: number }>(
    '/api/voter/search',
    {
      method: 'POST',
      body: JSON.stringify({
        filters: toFilterPayload(opts.filters),
        q: opts.q ?? '',
        page: opts.page ?? 1,
        page_size: opts.pageSize ?? 50,
      }),
    },
  );
}

export function importVoters(opts: {
  rows: Record<string, unknown>[];
  filename?: string;
  batchId?: string | null;
}) {
  return apiFetch<{
    inserted: number;
    updated: number;
    skipped: number;
    errors: string[];
    batch_id: string | null;
  }>('/api/voter/import', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export function deleteVoters(ids: number[]) {
  return apiFetch<{ deleted: number }>('/api/voter/delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export type CampaignPersonDetail = {
  volunteer: Record<string, unknown> | null;
  yard_signs: Record<string, unknown>[];
  event_attendances: {
    id: string;
    event_id: string;
    guests: number;
    attended: boolean;
    notes: string | null;
    created_at: string;
    event_title: string | null;
    event_starts_at: string | null;
    event_ends_at: string | null;
    event_location: string | null;
    event_status: string | null;
  }[];
};

export function fetchVoterProfile(id: number) {
  return apiFetch<{
    voter: Record<string, unknown> & { id: number };
    campaign: CampaignPersonDetail | null;
    nearby: {
      yard_sign_miles: number | null;
      volunteer_miles: number | null;
    } | null;
    polls: {
      election_day: VoterPollSite | null;
      early_voting: VoterPollSite | null;
    } | null;
  }>('/api/voter/profile', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

export type VoterPollSite = {
  id: number;
  kind: 'election_day' | 'early_voting';
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

export function fetchPollingLocations() {
  return apiFetch<{
    locations: PollMapLocation[];
    summary: {
      election_day: number;
      early_voting: number;
      plotted: number;
      ungeocoded: number;
    };
  }>('/api/voter/polling-locations', {
    method: 'POST',
    body: JSON.stringify({ action: 'list' }),
  });
}

export function fetchPollLinks(county: string, kind: 'election_day' | 'early_voting') {
  return apiFetch<{
    total: number;
    truncated: boolean;
    links: number[][];
  }>('/api/voter/polling-locations', {
    method: 'POST',
    body: JSON.stringify({ action: 'links', county, kind }),
  });
}

export function importPollingLocations(input: {
  kind: 'election_day' | 'early_voting';
  locations: PollingImportRow[];
}) {
  return apiFetch<{
    kind: 'election_day' | 'early_voting';
    saved: number;
    geocoded: number;
    ungeocoded: number;
  }>('/api/voter/polling-locations', {
    method: 'POST',
    body: JSON.stringify({ action: 'import', ...input }),
  });
}

export function geocodeMissingPollingLocations() {
  return apiFetch<{ geocoded: number; remaining: number }>(
    '/api/voter/polling-locations',
    {
      method: 'POST',
      body: JSON.stringify({ action: 'geocode_missing' }),
    },
  );
}

export function assignNearestPollingLocations(afterId: number) {
  return apiFetch<{
    assigned: number;
    after_id: number;
    done: boolean;
    total: number | null;
  }>('/api/voter/polling-locations', {
    method: 'POST',
    body: JSON.stringify({ action: 'assign', after_id: afterId }),
  });
}

export type NearbyKind = 'yard_sign' | 'volunteer';

export type NearbyPinResponse = {
  voter: {
    id: number;
    first_name: string | null;
    last_name: string | null;
    address_line_1: string | null;
    city: string | null;
    zip: string | null;
    lat: number;
    lng: number;
    geocoded?: boolean;
  };
  nearest: {
    kind: NearbyKind;
    id: string;
    person_id: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    zip: string | null;
    status: string | null;
    quantity: number | null;
    is_big: boolean | null;
    lat: number;
    lng: number;
    miles: number;
  };
};

export function fetchNearbyPin(voterId: number, kind: NearbyKind) {
  return apiFetch<NearbyPinResponse>('/api/voter/nearby', {
    method: 'POST',
    body: JSON.stringify({ voter_id: voterId, kind }),
  });
}

export type YardSignSuggestion = {
  rank: number;
  voter_id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address_line_1: string | null;
  city: string | null;
  zip: string | null;
  county: string | null;
  party: string | null;
  lat: number;
  lng: number;
  yard_sign: string | null;
  supporter_tag: string | null;
  covers: number;
  already_has_sign: boolean;
  has_contact: boolean;
};

export type YardSignSuggestionsResult = {
  radius_miles: number;
  existing_signs: number;
  voters_with_coords: number;
  already_covered: number;
  uncovered: number;
  suggestions: YardSignSuggestion[];
  county?: string;
};

export function fetchYardSignSuggestions(opts?: {
  radius_miles?: number;
  max_suggestions?: number;
  county?: string[];
}) {
  return apiFetch<YardSignSuggestionsResult>(
    '/api/voter/yard-sign-suggestions',
    {
      method: 'POST',
      body: JSON.stringify({
        radius_miles: opts?.radius_miles ?? 0.5,
        max_suggestions: opts?.max_suggestions ?? 40,
        county: opts?.county,
      }),
    },
  );
}

export function autoMergeSureDuplicates() {
  return apiFetch<{ merged: number; skipped: number; found: number }>(
    '/api/voter/merge-duplicates',
    { method: 'POST' },
  );
}

export type ContactSuggestion = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  party: string | null;
  supporter_tag: string | null;
  petitions: number;
};

export type ContactSuggestionsResult = {
  rows: ContactSuggestion[];
  total: number;
  page: number;
  page_size: number;
  counts: {
    all?: number;
    republican?: number;
    democrat?: number;
    independent?: number;
    super?: number;
  };
};

export async function fetchContactSuggestions(opts?: {
  party?: string | null;
  signed_min?: number;
  page?: number;
  page_size?: number;
}) {
  const body = {
    party: opts?.party ?? null,
    signed_min: opts?.signed_min ?? 1,
    page: opts?.page ?? 1,
    page_size: opts?.page_size ?? 50,
  };
  const key = `contact_suggestions_${body.party ?? 'all'}_${body.signed_min}_${body.page}`;
  try {
    const data = await apiFetch<ContactSuggestionsResult>(
      '/api/voter/contact-suggestions',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    try {
      sessionStorage.setItem(key, JSON.stringify(data));
    } catch {
      /* ignore */
    }
    return data;
  } catch (err) {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) return JSON.parse(raw) as ContactSuggestionsResult;
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function exportPage(opts: {
  filters: VoterFilters;
  afterId?: number | null;
  limit?: number;
  exportedSoFar?: number;
  lean?: boolean;
}) {
  return apiFetch<{
    rows: VoterRow[];
    next_cursor: number | null;
    truncated?: boolean;
  }>('/api/voter/export', {
    method: 'POST',
    body: JSON.stringify({
      filters: toFilterPayload(opts.filters),
      after_id: opts.afterId ?? null,
      limit: opts.limit ?? 400,
      exported_so_far: opts.exportedSoFar ?? 0,
      lean: opts.lean === true,
    }),
  });
}

export function listUniverses() {
  return apiFetch<{ universes: SavedUniverse[] }>('/api/voter/universes', {
    method: 'GET',
  });
}

export function createUniverse(
  name: string,
  filters: VoterFilters,
  opts?: {
    supporter_tag?: string | null;
    tag_priority?: number;
    source?: string | null;
    skip_recompute?: boolean;
  },
) {
  return apiFetch<{ universe: SavedUniverse }>('/api/voter/universes', {
    method: 'POST',
    body: JSON.stringify({
      name,
      filters: toFilterPayload(filters),
      supporter_tag: opts?.supporter_tag ?? null,
      tag_priority: opts?.tag_priority ?? 0,
      source: opts?.source ?? null,
      skip_recompute: opts?.skip_recompute ?? false,
    }),
  });
}

export function updateUniverse(
  id: string,
  patch: {
    name?: string;
    filters?: VoterFilters;
    supporter_tag?: string | null;
    tag_priority?: number;
    source?: string | null;
    skip_recompute?: boolean;
  },
) {
  return apiFetch<{ universe: SavedUniverse }>('/api/voter/universes', {
    method: 'PATCH',
    body: JSON.stringify({
      id,
      name: patch.name,
      supporter_tag: patch.supporter_tag,
      tag_priority: patch.tag_priority,
      source: patch.source,
      skip_recompute: patch.skip_recompute ?? false,
      filters: patch.filters ? toFilterPayload(patch.filters) : undefined,
    }),
  });
}

export function recomputeSupporterTags() {
  return apiFetch<{ ok: boolean }>('/api/voter/universes', {
    method: 'POST',
    body: JSON.stringify({ action: 'recompute_tags' }),
  });
}

export function fetchCampaignSyncState() {
  return apiFetch<{ state: CampaignSyncState | null }>('/api/voter/sync-campaign', {
    method: 'GET',
  });
}

const PETITIONS_CACHE_KEY = 'voter_petitions_v1';

type PetitionsPayload = {
  petitions: Array<{
    id: number;
    slug: string;
    label: string;
    short_label: string;
    bit_index: number;
    sort_order: number;
    is_default: boolean;
    is_active: boolean;
    group_id?: number | null;
  }>;
  groups: Array<{
    id: number;
    slug: string;
    label: string;
    short_label: string;
    sort_order: number;
  }>;
};

let petitionsInflight: Promise<PetitionsPayload> | null = null;

function removeStorageKey(key: string) {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function invalidatePetitionsCache() {
  petitionsInflight = null;
  removeStorageKey(PETITIONS_CACHE_KEY);
}

export function clearClientDataCaches() {
  if (typeof sessionStorage === 'undefined' && typeof localStorage === 'undefined') {
    return;
  }
  try {
    sessionStorage.removeItem('analytics_summary_empty_v1');
    sessionStorage.removeItem('analytics_summary_empty_v2');
    sessionStorage.removeItem('analytics_summary_empty_v3');
    sessionStorage.removeItem('analytics_summary_empty_v4');
    sessionStorage.removeItem('analytics_summary_empty_v5');
    sessionStorage.removeItem('voter_filter_options_v1');
    sessionStorage.removeItem('voter_filter_options_v2');
    sessionStorage.removeItem('voter_filter_options_v3');
  } catch {
    /* ignore */
  }
  invalidatePetitionsCache();
  invalidateAbsenteeCache();
}

export async function syncCampaignIndexes(opts?: { recompute_tags?: boolean }) {
  const res = await apiFetch<{
    ok: boolean;
    sync: unknown;
    tags: unknown;
    state: CampaignSyncState | null;
  }>('/api/voter/sync-campaign', {
    method: 'POST',
    body: JSON.stringify({ recompute_tags: opts?.recompute_tags !== false }),
  });
  clearClientDataCaches();
  return res;
}

export function deleteUniverse(id: string) {
  return apiFetch<{ ok: boolean }>('/api/voter/universes', {
    method: 'DELETE',
    body: JSON.stringify({ id }),
  });
}

export function fetchUsage() {
  return apiFetch<DbUsage>('/api/voter/usage', { method: 'GET' });
}

export async function fetchFilterOptions() {
  const cacheKey = 'voter_filter_options_v3';
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem('voter_filter_options_v1');
      sessionStorage.removeItem('voter_filter_options_v2');
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { at: number; data: FilterOptionsCache };
        const cities = parsed.data?.cities;
        // Reject legacy truncated lists (RPC used to stop at 500 A–… names).
        const usable =
          Array.isArray(cities) &&
          cities.length > 0 &&
          cities.length !== 500 &&
          cities.some((c) => /preston/i.test(String(c)));
        if (
          Date.now() - parsed.at < 30 * 60 * 1000 &&
          parsed.data &&
          usable
        ) {
          return parsed.data;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const data = await apiFetch<FilterOptionsCache>('/api/voter/filter-options', {
    method: 'GET',
  });

  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(
        cacheKey,
        JSON.stringify({ at: Date.now(), data }),
      );
    } catch {
      /* ignore */
    }
  }

  return data;
}

export async function fetchPetitionsApi(opts?: { force?: boolean }) {
  const readLocal = (): PetitionsPayload | null => {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(PETITIONS_CACHE_KEY) ?? localStorage.getItem(PETITIONS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { data?: PetitionsPayload };
      if (parsed?.data?.petitions?.length) return parsed.data;
    } catch {
      /* ignore */
    }
    return null;
  };

  if (!opts?.force) {
    const local = readLocal();
    if (local) return local;
  } else {
    petitionsInflight = null;
  }

  if (!petitionsInflight) {
    petitionsInflight = apiFetch<PetitionsPayload>('/api/voter/petitions')
      .then((data) => {
        const payload = {
          petitions: data.petitions ?? [],
          groups: data.groups ?? [],
        };
        try {
          const raw = JSON.stringify({ at: Date.now(), data: payload });
          sessionStorage.setItem(PETITIONS_CACHE_KEY, raw);
          localStorage.setItem(PETITIONS_CACHE_KEY, raw);
        } catch {
          /* ignore */
        }
        return payload;
      })
      .catch(() => {
        const cached = readLocal();
        if (cached) return cached;
        return { petitions: [], groups: [] };
      })
      .finally(() => {
        petitionsInflight = null;
      });
  }
  return petitionsInflight;
}

export async function createPetitionApi(body: {
  label: string;
  slug?: string;
  short_label?: string;
  is_default?: boolean;
}) {
  const res = await apiFetch<{
    petition: {
      id: number;
      slug: string;
      label: string;
      short_label: string;
      bit_index: number;
      sort_order: number;
      is_default: boolean;
      is_active: boolean;
      group_id?: number | null;
    };
  }>('/api/voter/petitions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  invalidatePetitionsCache();
  return res;
}

export async function createPetitionGroupApi(body: {
  label: string;
  short_label?: string;
  petition_ids: number[];
}) {
  const res = await apiFetch<{
    group: {
      id: number;
      slug: string;
      label: string;
      short_label: string;
      sort_order: number;
    };
  }>('/api/voter/petitions', {
    method: 'POST',
    body: JSON.stringify({ kind: 'group', ...body }),
  });
  invalidatePetitionsCache();
  return res;
}

export async function updatePetitionApi(body: {
  id: number;
  label?: string;
  short_label?: string;
  sort_order?: number;
  is_default?: boolean;
  is_active?: boolean;
  group_id?: number | null;
}) {
  const res = await apiFetch<{
    petition: {
      id: number;
      slug: string;
      label: string;
      short_label: string;
      bit_index: number;
      sort_order: number;
      is_default: boolean;
      is_active: boolean;
      group_id?: number | null;
    };
  }>('/api/voter/petitions', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  invalidatePetitionsCache();
  return res;
}

export async function updatePetitionGroupApi(body: {
  id: number;
  label?: string;
  short_label?: string;
  sort_order?: number;
}) {
  const res = await apiFetch<{
    group: {
      id: number;
      slug: string;
      label: string;
      short_label: string;
      sort_order: number;
    };
  }>('/api/voter/petitions', {
    method: 'PATCH',
    body: JSON.stringify({ kind: 'group', ...body }),
  });
  invalidatePetitionsCache();
  return res;
}

export async function deletePetitionApi(id: number) {
  const res = await apiFetch<{ ok: boolean }>('/api/voter/petitions', {
    method: 'DELETE',
    body: JSON.stringify({ id }),
  });
  invalidatePetitionsCache();
  return res;
}

export async function deletePetitionGroupApi(id: number) {
  const res = await apiFetch<{ ok: boolean }>('/api/voter/petitions', {
    method: 'DELETE',
    body: JSON.stringify({ kind: 'group', id }),
  });
  invalidatePetitionsCache();
  return res;
}

export async function fetchTrackingPolls() {
  const key = 'tracking_polls_v1';
  try {
    const data = await apiFetch<{
      polls: TrackingPoll[];
      imports: TrackingPollImport[];
      responses: TrackingPollResponse[];
    }>('/api/voter/tracking-polls');
    try {
      const raw = JSON.stringify(data);
      sessionStorage.setItem(key, raw);
      localStorage.setItem(key, raw);
    } catch {
      /* ignore */
    }
    return data;
  } catch (err) {
    try {
      const raw = sessionStorage.getItem(key) ?? localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function previewTrackingPollImport(body: {
  poll_date: string;
  filename: string;
  file_hash?: string | null;
  rows: ParsedPollRow[];
}) {
  return apiFetch<{ preview: PreviewSummary }>('/api/voter/tracking-polls', {
    method: 'POST',
    body: JSON.stringify({ action: 'preview', ...body }),
  });
}

export async function createTrackingPolls(
  polls: Array<{ poll_date: string; label?: string | null }>,
) {
  return apiFetch<{ poll: TrackingPoll | null; polls: TrackingPoll[] }>(
    '/api/voter/tracking-polls',
    {
      method: 'POST',
      body: JSON.stringify({ action: 'create', polls }),
    },
  );
}

export async function confirmTrackingPollImport(body: {
  poll_id?: number;
  poll_date: string;
  filename: string;
  file_hash?: string | null;
  rows: ParsedPollRow[];
  resolutions?: Record<string, 'keep' | 'replace'>;
}) {
  return apiFetch<{
    ok: boolean;
    import_id: string;
    imported: number;
    existing?: number;
    unmatched?: number;
    conflicts?: number;
    poll: TrackingPoll;
  }>('/api/voter/tracking-polls', {
    method: 'POST',
    body: JSON.stringify({ action: 'confirm', ...body }),
  });
}

export async function lookupTrackingPollVoters(q: string) {
  return apiFetch<{ voters: VoterHit[] }>('/api/voter/tracking-polls', {
    method: 'POST',
    body: JSON.stringify({ action: 'lookup', q }),
  });
}

export async function linkTrackingPollResponse(responseId: number, voterId: number) {
  return apiFetch<{ ok: boolean }>('/api/voter/tracking-polls', {
    method: 'PATCH',
    body: JSON.stringify({ response_id: responseId, voter_id: voterId }),
  });
}

export async function rollbackTrackingPollImport(importId: string) {
  return apiFetch<{ ok: boolean }>('/api/voter/tracking-polls', {
    method: 'DELETE',
    body: JSON.stringify({ import_id: importId }),
  });
}

const ABSENTEE_CACHE_KEY = 'voter_absentee_v6';
const ABSENTEE_STALE_KEYS = [
  'voter_absentee_v1',
  'voter_absentee_v2',
  'voter_absentee_v3',
  'voter_absentee_v4',
  'voter_absentee_v5',
];
let absenteeInflight: Promise<AbsenteeDashboard> | null = null;

function dropStaleAbsenteeCaches() {
  for (const key of ABSENTEE_STALE_KEYS) {
    try {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

export function fetchAbsenteeTargetCount(filters: VoterFilters) {
  return apiFetch<{ count: number }>('/api/voter/absentee', {
    method: 'POST',
    body: JSON.stringify({ kind: 'count', filters: toFilterPayload(filters) }),
  });
}

export function invalidateAbsenteeCache() {
  absenteeInflight = null;
  removeStorageKey(ABSENTEE_CACHE_KEY);
  dropStaleAbsenteeCaches();
}

export async function fetchAbsenteeDashboard(opts?: {
  force?: boolean;
  slugs?: string[];
}) {
  const slugs = (opts?.slugs ?? []).filter(Boolean);
  const useCache = slugs.length === 0;
  const readLocal = (): AbsenteeDashboard | null => {
    if (!useCache) return null;
    try {
      const raw =
        sessionStorage.getItem(ABSENTEE_CACHE_KEY) ??
        localStorage.getItem(ABSENTEE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { data?: AbsenteeDashboard } | AbsenteeDashboard;
      const data =
        'data' in parsed && parsed.data ? parsed.data : (parsed as AbsenteeDashboard);
      if (
        Array.isArray(data.elections) &&
        data.headline &&
        Array.isArray(data.by_election) &&
        (data.by_election.length > 0 || data.elections.length === 0) &&
        (Number(data.headline.rows) > 0 ||
          Number(data.headline.unique_voters) > 0 ||
          data.elections.length === 0)
      ) {
        return normalizeAbsenteeDashboard(data);
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  dropStaleAbsenteeCaches();

  if (!opts?.force) {
    const local = readLocal();
    if (local) return local;
  } else if (useCache) {
    absenteeInflight = null;
  }

  const qs = slugs.length
    ? `?slugs=${encodeURIComponent(slugs.join(','))}`
    : '';
  const request = () =>
    apiFetch<AbsenteeDashboard>(`/api/voter/absentee${qs}`).then((data) => {
      const payload = normalizeAbsenteeDashboard(data);
      const usable =
        payload.by_election.length > 0 ||
        payload.headline.rows > 0 ||
        payload.headline.unique_voters > 0 ||
        payload.elections.length === 0;
      if (useCache && usable) {
        try {
          const raw = JSON.stringify({ at: Date.now(), data: payload });
          sessionStorage.setItem(ABSENTEE_CACHE_KEY, raw);
          localStorage.setItem(ABSENTEE_CACHE_KEY, raw);
        } catch {
          /* ignore */
        }
      }
      return payload;
    });

  if (!useCache) return request();

  if (!absenteeInflight) {
    absenteeInflight = request()
      .catch((err) => {
        const cached = readLocal();
        if (cached) return cached;
        throw err;
      })
      .finally(() => {
        absenteeInflight = null;
      });
  }
  return absenteeInflight;
}

export async function createAbsenteeElectionApi(body: {
  label: string;
  slug?: string;
  short_label?: string;
  is_default?: boolean;
}) {
  const res = await apiFetch<{ election: AbsenteeElection }>('/api/voter/absentee', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  invalidateAbsenteeCache();
  return res;
}

export async function updateAbsenteeElectionApi(body: {
  id: number;
  label?: string;
  short_label?: string;
  sort_order?: number;
  is_default?: boolean;
  is_active?: boolean;
  group_id?: number | null;
}) {
  const res = await apiFetch<{ election: AbsenteeElection }>('/api/voter/absentee', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  invalidateAbsenteeCache();
  return res;
}

export async function deleteAbsenteeElectionApi(id: number) {
  const res = await apiFetch<{ ok: boolean }>('/api/voter/absentee', {
    method: 'DELETE',
    body: JSON.stringify({ id }),
  });
  invalidateAbsenteeCache();
  return res;
}

export async function createAbsenteeGroupApi(body: {
  label: string;
  short_label?: string;
  election_ids: number[];
}) {
  const res = await apiFetch<{ group: AbsenteeGroup }>('/api/voter/absentee', {
    method: 'POST',
    body: JSON.stringify({ kind: 'group', ...body }),
  });
  invalidateAbsenteeCache();
  return res;
}

export async function updateAbsenteeGroupApi(body: {
  id: number;
  label?: string;
  short_label?: string;
  sort_order?: number;
}) {
  const res = await apiFetch<{ group: AbsenteeGroup }>('/api/voter/absentee', {
    method: 'PATCH',
    body: JSON.stringify({ kind: 'group', ...body }),
  });
  invalidateAbsenteeCache();
  return res;
}

export async function deleteAbsenteeGroupApi(id: number) {
  const res = await apiFetch<{ ok: boolean }>('/api/voter/absentee', {
    method: 'DELETE',
    body: JSON.stringify({ kind: 'group', id }),
  });
  invalidateAbsenteeCache();
  return res;
}

type FilterOptionsCache = {
  counties: string[];
  parties: string[];
  statuses: string[];
  cities: string[];
  states?: string[];
  alignment_labels: string[];
  yard_signs: string[];
  volunteer_interests: string[];
  newsletters: string[];
  donated: string[];
  attended_events: string[];
  top_main_topics: string[];
  convos_candidate_support: string[];
  convos_contact_status: string[];
};

