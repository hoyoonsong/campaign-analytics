/** Process-local last-good payloads so a recovering origin can still serve Analytics. */

let analytics: Record<string, unknown> | null = null;
let petitions: { petitions: unknown[]; groups: unknown[] } | null = null;
let filterOptions: Record<string, unknown> | null = null;
let syncState: Record<string, unknown> | null = null;
let campaignGeo: unknown[] | null = null;
let campaignGeoAt = 0;
const CAMPAIGN_GEO_TTL_MS = 120_000;
let tracking: Record<string, unknown> | null = null;

export function rememberAnalytics(data: Record<string, unknown> | null) {
  if (data && Array.isArray(data.petition_combos)) analytics = data;
}

export function recallAnalytics() {
  return analytics;
}

export function rememberPetitions(data: {
  petitions: unknown[];
  groups: unknown[];
}) {
  if (data.petitions?.length) petitions = data;
}

export function recallPetitions() {
  return petitions;
}

export function rememberFilterOptions(data: Record<string, unknown> | null) {
  if (data && Array.isArray(data.cities) && data.cities.length > 0) {
    filterOptions = data;
  }
}

export function recallFilterOptions() {
  return filterOptions;
}

export function rememberSyncState(data: Record<string, unknown> | null) {
  if (data) syncState = data;
}

export function recallSyncState() {
  return syncState;
}

export function rememberCampaignGeo(points: unknown[] | null) {
  if (Array.isArray(points) && points.length) {
    campaignGeo = points;
    campaignGeoAt = Date.now();
  }
}

export function recallCampaignGeo(opts?: { allowStale?: boolean }) {
  if (!campaignGeo) return null;
  if (!opts?.allowStale && Date.now() - campaignGeoAt > CAMPAIGN_GEO_TTL_MS) {
    return null;
  }
  return campaignGeo;
}

export function rememberTracking(data: Record<string, unknown> | null) {
  if (data && Array.isArray(data.polls)) tracking = data;
}

export function recallTracking() {
  return tracking;
}
