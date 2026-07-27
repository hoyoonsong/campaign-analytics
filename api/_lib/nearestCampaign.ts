import type { SupabaseClient } from '@supabase/supabase-js';
import { campaignAdminClient } from './campaign.js';
import { geocodeVoterAddress, milesBetween } from './geo.js';

export type NearbyKind = 'yard_sign' | 'volunteer';

export type NearestCampaignPin = {
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

export type VoterMapPoint = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  address_line_1: string | null;
  city: string | null;
  zip: string | null;
  state: string | null;
  lat: number;
  lng: number;
  geocoded?: boolean;
};

async function fetchPins(kind: NearbyKind): Promise<
  Array<{
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
  }>
> {
  const campaign = campaignAdminClient();
  const table = kind === 'yard_sign' ? 'yard_signs' : 'volunteers';
  const columns =
    kind === 'yard_sign'
      ? 'id, person_id, name, email, phone, address, lat, lng, status, quantity, is_big'
      : 'id, person_id, name, email, phone, address, city, zip, lat, lng';

  const pageSize = 1000;
  const out: Array<{
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
  }> = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await campaign
      .from(table)
      .select(columns)
      .not('lat', 'is', null)
      .not('lng', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of batch) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      out.push({
        id: String(row.id),
        person_id: (row.person_id as string | null) ?? null,
        name: (row.name as string | null) ?? null,
        email: (row.email as string | null) ?? null,
        phone: (row.phone as string | null) ?? null,
        address: (row.address as string | null) ?? null,
        city: ('city' in row ? (row.city as string | null) : null) ?? null,
        zip: ('zip' in row ? (row.zip as string | null) : null) ?? null,
        status: ('status' in row ? (row.status as string | null) : null) ?? null,
        quantity:
          ('quantity' in row ? (row.quantity as number | null) : null) ?? null,
        is_big: ('is_big' in row ? (row.is_big as boolean | null) : null) ?? null,
        lat,
        lng,
      });
    }
    if (batch.length < pageSize) break;
  }
  return out;
}

export async function findNearestCampaignPin(
  lat: number,
  lng: number,
  kind: NearbyKind,
): Promise<NearestCampaignPin | null> {
  const pins = await fetchPins(kind);
  let best: NearestCampaignPin | null = null;
  for (const p of pins) {
    const miles = milesBetween(lat, lng, p.lat, p.lng);
    if (!best || miles < best.miles) {
      best = { kind, ...p, miles };
    }
  }
  return best;
}

/**
 * Load voter map point. If lat/lng missing but any address exists, geocode
 * from whatever fields we have and persist.
 */
export async function loadVoterCoords(
  voter: SupabaseClient,
  voterId: number,
  opts?: { geocodeIfMissing?: boolean; persistGeocode?: boolean },
): Promise<VoterMapPoint | null> {
  const geocodeIfMissing = opts?.geocodeIfMissing !== false;
  const persistGeocode = opts?.persistGeocode !== false;

  const { data, error } = await voter
    .from('voters')
    .select(
      'id, first_name, last_name, address_line_1, city, zip, state, county, lat, lng',
    )
    .eq('id', voterId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  let lat =
    data.lat != null && Number.isFinite(Number(data.lat))
      ? Number(data.lat)
      : null;
  let lng =
    data.lng != null && Number.isFinite(Number(data.lng))
      ? Number(data.lng)
      : null;
  let geocoded = false;

  if ((lat == null || lng == null) && geocodeIfMissing) {
    const hit = await geocodeVoterAddress({
      address_line_1: data.address_line_1,
      city: data.city,
      zip: data.zip,
      state: data.state,
      county: data.county,
    });
    if (hit) {
      lat = hit.lat;
      lng = hit.lng;
      geocoded = true;
      if (persistGeocode) {
        await voter
          .from('voters')
          .update({ lat, lng })
          .eq('id', voterId)
          .is('lat', null);
      }
    }
  }

  if (lat == null || lng == null) return null;

  return {
    id: Number(data.id),
    first_name: data.first_name ?? null,
    last_name: data.last_name ?? null,
    address_line_1: data.address_line_1 ?? null,
    city: data.city ?? null,
    zip: data.zip ?? null,
    state: data.state ?? null,
    lat,
    lng,
    geocoded,
  };
}
