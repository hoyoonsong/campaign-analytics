import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** Read-only Campaign (FormHandler) client. Prefer service role for sync/profile enrichment. */
export function campaignAdminClient(): SupabaseClient {
  const url = env('CAMPAIGN_SUPABASE_URL');
  const key = process.env.CAMPAIGN_SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error('CAMPAIGN_SUPABASE_SERVICE_ROLE_KEY is required for campaign sync');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function phoneDigits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  return d || null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return e || null;
}

type ContactRow = {
  person_id: string;
  email: string | null;
  phone_digits: string | null;
  is_volunteer: boolean;
};

type GeoRow = {
  source_id: string;
  kind: 'volunteer' | 'yard_sign';
  lat: number;
  lng: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
};

async function fetchAllRows<T extends Record<string, unknown>>(
  client: SupabaseClient,
  table: string,
  columns: string,
): Promise<T[]> {
  const pageSize = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

function pushContact(
  contacts: ContactRow[],
  personId: string | null | undefined,
  email: string | null | undefined,
  emails: string[] | null | undefined,
  phone: string | null | undefined,
  phones: string[] | null | undefined,
  isVolunteer: boolean,
) {
  if (!personId) return;
  const emailSet = new Set<string>();
  const e0 = normalizeEmail(email);
  if (e0) emailSet.add(e0);
  for (const e of emails ?? []) {
    const n = normalizeEmail(e);
    if (n) emailSet.add(n);
  }
  const phoneSet = new Set<string>();
  const p0 = phoneDigits(phone);
  if (p0) phoneSet.add(p0);
  for (const p of phones ?? []) {
    const n = phoneDigits(p);
    if (n) phoneSet.add(n);
  }
  if (emailSet.size === 0 && phoneSet.size === 0) {
    contacts.push({
      person_id: personId,
      email: null,
      phone_digits: null,
      is_volunteer: isVolunteer,
    });
    return;
  }
  if (emailSet.size === 0) {
    for (const ph of phoneSet) {
      contacts.push({
        person_id: personId,
        email: null,
        phone_digits: ph,
        is_volunteer: isVolunteer,
      });
    }
    return;
  }
  if (phoneSet.size === 0) {
    for (const em of emailSet) {
      contacts.push({
        person_id: personId,
        email: em,
        phone_digits: null,
        is_volunteer: isVolunteer,
      });
    }
    return;
  }
  for (const em of emailSet) {
    for (const ph of phoneSet) {
      contacts.push({
        person_id: personId,
        email: em,
        phone_digits: ph,
        is_volunteer: isVolunteer,
      });
    }
  }
}

export async function buildLeanSyncPayload(client: SupabaseClient): Promise<{
  contacts: ContactRow[];
  geo: GeoRow[];
  volunteer_count: number;
  yard_sign_count: number;
}> {
  const volunteers = await fetchAllRows<{
    id: string;
    person_id: string | null;
    name: string | null;
    email: string | null;
    emails: string[] | null;
    phone: string | null;
    phones: string[] | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
  }>(
    client,
    'volunteers',
    'id, person_id, name, email, emails, phone, phones, address, lat, lng',
  );

  const yardSigns = await fetchAllRows<{
    id: string;
    person_id: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
  }>(client, 'yard_signs', 'id, person_id, name, email, phone, address, lat, lng');

  const contacts: ContactRow[] = [];
  const geo: GeoRow[] = [];

  for (const v of volunteers) {
    pushContact(
      contacts,
      v.person_id,
      v.email,
      v.emails,
      v.phone,
      v.phones,
      true,
    );
    if (v.lat != null && v.lng != null && Number.isFinite(v.lat) && Number.isFinite(v.lng)) {
      geo.push({
        source_id: v.id,
        kind: 'volunteer',
        lat: v.lat,
        lng: v.lng,
        name: v.name,
        email: v.email,
        phone: v.phone,
        address: v.address,
      });
    }
  }

  for (const y of yardSigns) {
    pushContact(contacts, y.person_id, y.email, null, y.phone, null, false);
    if (y.lat != null && y.lng != null && Number.isFinite(y.lat) && Number.isFinite(y.lng)) {
      geo.push({
        source_id: y.id,
        kind: 'yard_sign',
        lat: y.lat,
        lng: y.lng,
        name: y.name,
        email: y.email,
        phone: y.phone,
        address: y.address,
      });
    }
  }

  return {
    contacts,
    geo,
    volunteer_count: volunteers.length,
    yard_sign_count: yardSigns.length,
  };
}

export async function fetchCampaignPersonDetail(
  client: SupabaseClient,
  personId: string,
) {
  const [volunteerRes, yardRes, attendanceRes] = await Promise.all([
    client
      .from('volunteers')
      .select(
        'id, person_id, name, email, phone, address, city, zip, county, lat, lng, interests, tags, orientation_done, orientation_date, phone_bank_orientation_done, phone_bank_orientation_date, doorknock_orientation_done, doorknock_orientation_date, county_captain, captain_counties, notes, source, created_at, updated_at',
      )
      .eq('person_id', personId)
      .maybeSingle(),
    client
      .from('yard_signs')
      .select(
        'id, person_id, name, email, phone, address, lat, lng, quantity, is_big, status, notes, source, created_at, updated_at',
      )
      .eq('person_id', personId)
      .order('created_at', { ascending: false }),
    client
      .from('event_attendances')
      .select(
        'id, event_id, name, email, phone, guests, attended, notes, created_at, events(id, title, starts_at, ends_at, location, status)',
      )
      .eq('person_id', personId)
      .order('created_at', { ascending: false }),
  ]);

  if (volunteerRes.error) throw new Error(volunteerRes.error.message);
  if (yardRes.error) throw new Error(yardRes.error.message);
  if (attendanceRes.error) throw new Error(attendanceRes.error.message);

  const attendances = (attendanceRes.data ?? []).map((row) => {
    const events = row.events as
      | {
          id: string;
          title: string | null;
          starts_at: string | null;
          ends_at: string | null;
          location: string | null;
          status: string | null;
        }
      | {
          id: string;
          title: string | null;
          starts_at: string | null;
          ends_at: string | null;
          location: string | null;
          status: string | null;
        }[]
      | null;
    const event = Array.isArray(events) ? events[0] ?? null : events;
    return {
      id: row.id as string,
      event_id: row.event_id as string,
      guests: row.guests as number,
      attended: row.attended as boolean,
      notes: row.notes as string | null,
      created_at: row.created_at as string,
      event_title: event?.title ?? null,
      event_starts_at: event?.starts_at ?? null,
      event_ends_at: event?.ends_at ?? null,
      event_location: event?.location ?? null,
      event_status: event?.status ?? null,
    };
  });

  return {
    volunteer: volunteerRes.data ?? null,
    yard_signs: yardRes.data ?? [],
    event_attendances: attendances,
  };
}
