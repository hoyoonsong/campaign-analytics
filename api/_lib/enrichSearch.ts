import type { SupabaseClient } from '@supabase/supabase-js';
import { geocodeVoterAddress } from './geo.js';

type AnyOfRule = {
  field: string;
  values: Array<string | number>;
};

type TagUniverse = {
  tag: string;
  priority: number;
  any_of: AnyOfRule[];
};

type AttrRow = {
  id: number;
  yard_sign: string | null;
  donated: string | null;
  alignment_label: string | null;
  support_score: number | null;
  convos_candidate_support: string | null;
  convos_poll_question: string | null;
  volunteer_interest: string | null;
  newsletter: string | null;
  attended_event: string | null;
  is_campaign_volunteer?: boolean | null;
  is_campaign_donor?: boolean | null;
  is_campaign_attendee?: boolean | null;
  is_campaign_yard_sign?: boolean | null;
  is_campaign_newsletter?: boolean | null;
  email: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  address_line_1: string | null;
  city: string | null;
  zip: string | null;
  state: string | null;
  county: string | null;
};

export type GeoPoint = { kind: 'volunteer' | 'yard_sign'; lat: number; lng: number };

/** Built-in organizer presets — used when universes lack supporter_tag meta. */
const BUILTIN_TAG_PRESETS: TagUniverse[] = [
  {
    tag: 'supporter',
    priority: 30,
    any_of: [
      { field: 'yard_sign', values: ['Yes', 'Delivered'] },
      { field: 'donated', values: ['Yes'] },
      { field: 'alignment_label', values: ['Positive'] },
      { field: 'support_score', values: [1, 2] },
      { field: 'convos_candidate_support', values: ['yes'] },
      { field: 'volunteer_interest', values: ['Yes'] },
      { field: 'attended_event', values: ['Yes'] },
      { field: 'newsletter', values: ['Yes'] },
      { field: 'campaign_volunteer', values: ['Yes'] },
      { field: 'campaign_donor', values: ['Yes'] },
      { field: 'campaign_attendee', values: ['Yes'] },
      { field: 'campaign_yard_sign', values: ['Yes'] },
      { field: 'campaign_newsletter', values: ['Yes'] },
    ],
  },
  {
    tag: 'opposed',
    priority: 20,
    any_of: [
      { field: 'convos_candidate_support', values: ['no'] },
      { field: 'alignment_label', values: ['Negative'] },
      { field: 'support_score', values: [4, 5] },
    ],
  },
  {
    tag: 'maybe',
    priority: 10,
    any_of: [
      { field: 'alignment_label', values: ['Neutral'] },
      { field: 'convos_candidate_support', values: ['maybe'] },
      { field: 'convos_poll_question', values: ['C) Not Sure'] },
      { field: 'support_score', values: [3] },
    ],
  },
];

const NAME_TAG_FALLBACK: Record<string, { tag: string; priority: number }> = {
  'achilles vote': { tag: 'supporter', priority: 30 },
  'oppose achilles': { tag: 'opposed', priority: 20 },
  maybe: { tag: 'maybe', priority: 10 },
};

function lower(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function wantsYes(values: Array<string | number>): boolean {
  return values.some((v) =>
    ['yes', 'y', 'true', '1'].includes(lower(String(v))),
  );
}

function matchesAnyOf(row: AttrRow, rules: AnyOfRule[]): boolean {
  if (!rules.length) return false;
  for (const rule of rules) {
    const field = lower(rule.field);
    const values = rule.values ?? [];
    if (!values.length) continue;

    if (field === 'support_score') {
      const nums = values.map(Number).filter((n) => Number.isFinite(n));
      if (row.support_score != null && nums.includes(row.support_score)) {
        return true;
      }
      continue;
    }

    if (field === 'campaign_volunteer' && row.is_campaign_volunteer && wantsYes(values)) {
      return true;
    }
    if (field === 'campaign_donor' && row.is_campaign_donor && wantsYes(values)) {
      return true;
    }
    if (field === 'campaign_attendee' && row.is_campaign_attendee && wantsYes(values)) {
      return true;
    }
    if (field === 'campaign_yard_sign' && row.is_campaign_yard_sign && wantsYes(values)) {
      return true;
    }
    if (field === 'campaign_newsletter' && row.is_campaign_newsletter && wantsYes(values)) {
      return true;
    }

    const want = values.map((v) => lower(String(v)));
    const got = (() => {
      switch (field) {
        case 'yard_sign':
          return lower(row.yard_sign);
        case 'donated':
          return lower(row.donated);
        case 'alignment_label':
          return lower(row.alignment_label);
        case 'convos_candidate_support':
          return lower(row.convos_candidate_support);
        case 'convos_poll_question':
          return lower(row.convos_poll_question);
        case 'volunteer_interest':
          return lower(row.volunteer_interest);
        case 'newsletter':
          return lower(row.newsletter);
        case 'attended_event':
          return lower(row.attended_event);
        default:
          return '';
      }
    })();
    if (got && want.includes(got)) return true;
  }
  return false;
}

function milesBetween(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Nearest pin of kind. Pass maxMiles=null for unbounded (everyone). */
export function nearestMiles(
  lat: number | null | undefined,
  lng: number | null | undefined,
  points: GeoPoint[],
  kind: 'volunteer' | 'yard_sign',
  maxMiles: number | null = null,
): number | null {
  if (lat == null || lng == null) return null;
  let best: number | null = null;
  const bboxDeg = maxMiles != null ? maxMiles / 69 : 500 / 69;
  for (const p of points) {
    if (p.kind !== kind) continue;
    if (Math.abs(p.lat - lat) > bboxDeg) continue;
    const m = milesBetween(lat, lng, p.lat, p.lng);
    if (maxMiles != null && m > maxMiles) continue;
    if (best == null || m < best) best = m;
  }
  return best;
}

function parseTagUniverses(
  rows: Array<{
    name?: string | null;
    supporter_tag?: string | null;
    tag_priority?: number | null;
    filters?: Record<string, unknown> | null;
  }>,
): TagUniverse[] {
  const out: TagUniverse[] = [];
  for (const u of rows) {
    const filters = (u.filters ?? {}) as Record<string, unknown>;
    const any_of = Array.isArray(filters.any_of)
      ? (filters.any_of as AnyOfRule[])
      : [];
    if (!any_of.length) continue;

    let tag =
      (typeof u.supporter_tag === 'string' && u.supporter_tag.trim()) ||
      (typeof filters._supporter_tag === 'string' &&
        String(filters._supporter_tag).trim()) ||
      '';
    let priority =
      (typeof u.tag_priority === 'number' ? u.tag_priority : null) ??
      (typeof filters._tag_priority === 'number'
        ? Number(filters._tag_priority)
        : null) ??
      0;

    if (!tag) {
      const fb = NAME_TAG_FALLBACK[lower(u.name)];
      if (fb) {
        tag = fb.tag;
        priority = fb.priority;
      }
    }
    if (!tag) continue;
    out.push({ tag, priority, any_of });
  }
  out.sort((a, b) => a.priority - b.priority);
  return out;
}

let geoCache: { at: number; points: GeoPoint[] } | null = null;
const GEO_TTL_MS = 5 * 60 * 1000;

/** Prefer lean synced pins — avoids FormHandler round-trips on every Search page. */
export async function loadLeanGeo(
  voter: SupabaseClient,
): Promise<GeoPoint[]> {
  if (geoCache && Date.now() - geoCache.at < GEO_TTL_MS) {
    return geoCache.points;
  }
  const pageSize = 1000;
  const points: GeoPoint[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await voter
      .from('campaign_geo_points')
      .select('kind, lat, lng')
      .in('kind', ['volunteer', 'yard_sign'])
      .range(from, from + pageSize - 1);
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[enrich] loadLeanGeo failed', error.message);
      break;
    }
    const batch = data ?? [];
    for (const row of batch) {
      const kind = row.kind === 'yard_sign' ? 'yard_sign' : 'volunteer';
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        points.push({ kind, lat, lng });
      }
    }
    if (batch.length < pageSize) break;
  }
  geoCache = { at: Date.now(), points };
  return points;
}

/** @deprecated Prefer loadLeanGeo — kept for callers that still need live FormHandler. */
export async function loadCampaignGeo(): Promise<GeoPoint[]> {
  try {
    const { campaignAdminClient } = await import('./campaign.js');
    const campaign = campaignAdminClient();
    const pageSize = 1000;
    const points: GeoPoint[] = [];

    for (const [table, kind] of [
      ['volunteers', 'volunteer'],
      ['yard_signs', 'yard_sign'],
    ] as const) {
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await campaign
          .from(table)
          .select('lat,lng')
          .not('lat', 'is', null)
          .not('lng', 'is', null)
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const batch = data ?? [];
        for (const row of batch) {
          const lat = Number(row.lat);
          const lng = Number(row.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            points.push({ kind, lat, lng });
          }
        }
        if (batch.length < pageSize) break;
      }
    }
    return points;
  } catch {
    return [];
  }
}

function resolveTagUniverses(dbUniverses: TagUniverse[]): TagUniverse[] {
  if (dbUniverses.length > 0) return dbUniverses;
  return BUILTIN_TAG_PRESETS;
}

/**
 * Enrich search rows with supporter tags + nearby distances.
 * Uses lean campaign_geo_points. Geocoding is opt-in (profile).
 */
export async function enrichSearchRows(
  voter: SupabaseClient,
  rows: Array<Record<string, unknown>>,
  opts?: { nearbyMiles?: number | null; geocode?: boolean },
): Promise<Array<Record<string, unknown>>> {
  if (!rows.length) return rows;
  void opts?.nearbyMiles;

  const ids = rows
    .map((r) => Number(r.id))
    .filter((id) => Number.isFinite(id) && id > 0);

  const needsTagCompute = rows.some((r) => {
    const t = r.supporter_tag;
    return !(typeof t === 'string' && t.trim());
  });

  const [universesRes, attrsRes, geoPoints] = await Promise.all([
    needsTagCompute
      ? voter.from('saved_voter_universes').select('*')
      : Promise.resolve({ data: [] as unknown[] }),
    needsTagCompute
      ? voter
          .from('voters')
          .select(
            'id, yard_sign, donated, alignment_label, support_score, convos_candidate_support, convos_poll_question, volunteer_interest, newsletter, attended_event, is_campaign_volunteer, is_campaign_donor, is_campaign_attendee, is_campaign_yard_sign, is_campaign_newsletter, email, phone, lat, lng, address_line_1, city, zip, state, county, supporter_tag',
          )
          .in('id', ids)
      : Promise.resolve({ data: [] as unknown[] }),
    loadLeanGeo(voter),
  ]);

  const tagUniverses = needsTagCompute
    ? resolveTagUniverses(parseTagUniverses(universesRes.data ?? []))
    : [];
  const attrsById = new Map<number, AttrRow & { supporter_tag?: string | null }>();
  for (const a of (attrsRes.data ?? []) as Array<
    AttrRow & { supporter_tag?: string | null }
  >) {
    attrsById.set(a.id, a);
  }

  const geocodedCoords = new Map<number, { lat: number; lng: number }>();
  if (opts?.geocode) {
    const geocodeTargets = ids.filter((id) => {
      const a = attrsById.get(id);
      const row = rows.find((r) => Number(r.id) === id);
      const lat =
        typeof row?.lat === 'number'
          ? row.lat
          : a?.lat != null
            ? Number(a.lat)
            : null;
      const lng =
        typeof row?.lng === 'number'
          ? row.lng
          : a?.lng != null
            ? Number(a.lng)
            : null;
      if (lat != null && lng != null) return false;
      const street =
        (typeof row?.address_line_1 === 'string' && row.address_line_1) ||
        a?.address_line_1 ||
        '';
      const city =
        (typeof row?.city === 'string' && row.city) || a?.city || '';
      const zip = (typeof row?.zip === 'string' && row.zip) || a?.zip || '';
      return Boolean(street.trim() || city.trim() || zip.trim());
    });

    const GEOCODE_CONCURRENCY = 6;
    for (let i = 0; i < geocodeTargets.length; i += GEOCODE_CONCURRENCY) {
      const chunk = geocodeTargets.slice(i, i + GEOCODE_CONCURRENCY);
      await Promise.all(
        chunk.map(async (id) => {
          const a = attrsById.get(id);
          const row = rows.find((r) => Number(r.id) === id);
          const hit = await geocodeVoterAddress({
            address_line_1:
              (typeof row?.address_line_1 === 'string'
                ? row.address_line_1
                : null) ?? a?.address_line_1,
            city:
              (typeof row?.city === 'string' ? row.city : null) ?? a?.city,
            zip: (typeof row?.zip === 'string' ? row.zip : null) ?? a?.zip,
            state:
              (typeof row?.state === 'string' ? row.state : null) ?? a?.state,
            county:
              (typeof row?.county === 'string' ? row.county : null) ??
              a?.county,
          });
          if (!hit) return;
          geocodedCoords.set(id, hit);
          await voter
            .from('voters')
            .update({ lat: hit.lat, lng: hit.lng })
            .eq('id', id)
            .is('lat', null);
        }),
      );
    }
  }

  return rows.map((row) => {
    const id = Number(row.id);
    const attrs = attrsById.get(id);

    let supporter_tag: string | null =
      (typeof row.supporter_tag === 'string' && row.supporter_tag.trim()) ||
      (typeof attrs?.supporter_tag === 'string' && attrs.supporter_tag.trim()) ||
      null;

    if (!supporter_tag && attrs && tagUniverses.length) {
      for (const u of tagUniverses) {
        if (matchesAnyOf(attrs, u.any_of)) {
          supporter_tag = u.tag;
        }
      }
    }

    const geocoded = geocodedCoords.get(id);
    const lat =
      geocoded?.lat ??
      (typeof row.lat === 'number'
        ? row.lat
        : attrs?.lat != null
          ? Number(attrs.lat)
          : null);
    const lng =
      geocoded?.lng ??
      (typeof row.lng === 'number'
        ? row.lng
        : attrs?.lng != null
          ? Number(attrs.lng)
          : null);

    // Prefer unbounded JS distances; keep SQL values if a kind is missing
    // from a truncated pin page.
    const sqlYard =
      typeof row.nearby_yard_sign_miles === 'number'
        ? Number(row.nearby_yard_sign_miles)
        : null;
    const sqlVol =
      typeof row.nearby_volunteer_miles === 'number'
        ? Number(row.nearby_volunteer_miles)
        : null;
    const nearby_yard_sign_miles =
      nearestMiles(lat, lng, geoPoints, 'yard_sign', null) ?? sqlYard;
    const nearby_volunteer_miles =
      nearestMiles(lat, lng, geoPoints, 'volunteer', null) ?? sqlVol;

    return {
      ...row,
      lat,
      lng,
      supporter_tag,
      nearby_yard_sign_miles,
      nearby_volunteer_miles,
      is_campaign_volunteer: row.is_campaign_volunteer ?? false,
      has_map_coords: lat != null && lng != null,
      geocoded: Boolean(geocoded),
    };
  });
}

/** Embed tag metadata into filters jsonb (works without DB columns). */
export function withTagMeta(
  filters: Record<string, unknown>,
  tag: string | null | undefined,
  priority: number | null | undefined,
  source?: string | null,
): Record<string, unknown> {
  const out = { ...filters };
  const t = tag?.trim();
  if (t) {
    out._supporter_tag = t;
    out._tag_priority = Number.isFinite(Number(priority)) ? Number(priority) : 0;
  } else {
    delete out._supporter_tag;
    delete out._tag_priority;
  }
  const src = source?.trim();
  if (src) out._source = src;
  else delete out._source;
  return out;
}
