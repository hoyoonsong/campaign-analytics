/** Shared geo helpers for nearby distances + geocoding. */

export function milesBetween(
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

export type AddressParts = {
  address_line_1?: string | null;
  city?: string | null;
  zip?: string | null;
  state?: string | null;
  county?: string | null;
};

/** Pull street / city / state / ZIP out of messy voter-file address fields. */
export function normalizeAddressParts(parts: AddressParts): {
  street: string;
  city: string;
  state: string;
  zip: string;
  queries: string[];
} {
  const rawStreet = (parts.address_line_1 ?? '').trim();
  let street = rawStreet;
  let city = (parts.city ?? '').trim();
  let zip = (parts.zip ?? '').trim().replace(/^(\d{5}).*$/, '$1');
  let state = (parts.state ?? '').trim().toUpperCase();
  const county = (parts.county ?? '').trim();

  // "1201 N 22ND ST, BOISE, ID, 83702"
  const full = rawStreet.match(
    /^(.+?),\s*([^,]+),\s*([A-Za-z]{2})\s*,\s*(\d{5})(?:-\d{4})?\s*$/,
  );
  if (full) {
    street = full[1].trim();
    city = city || full[2].trim();
    state = full[3].trim().toUpperCase();
    zip = zip || full[4].trim();
  } else {
    // "52 E SEDGEWICK DR, MERIDIAN, 83646"
    const noState = rawStreet.match(/^(.+?),\s*([^,]+),\s*(\d{5})(?:-\d{4})?\s*$/);
    if (noState) {
      street = noState[1].trim();
      city = city || noState[2].trim();
      zip = zip || noState[3].trim();
    }
  }

  if (!zip) {
    const z = `${rawStreet} ${city}`.match(/\b(\d{5})(?:-\d{4})?\b/);
    if (z) zip = z[1];
  }
  if (!state) state = 'ID';

  const queries: string[] = [];
  const push = (q: string) => {
    const t = q.replace(/\s+/g, ' ').trim();
    if (t && !queries.includes(t)) queries.push(t);
  };

  push([street, city, state, zip, 'USA'].filter(Boolean).join(', '));
  push([street, city, state, 'USA'].filter(Boolean).join(', '));
  push([street, zip, state, 'USA'].filter(Boolean).join(', '));
  if (street && zip) push(`${street}, ${zip}`);
  if (zip) push(`${zip}, ${state}, USA`);
  if (street && county) {
    push([street, `${county} County`, state, 'USA'].filter(Boolean).join(', '));
  }
  if (street) push(`${street}, Idaho, USA`);
  // Last resort: whatever raw string we had
  if (rawStreet) push(`${rawStreet}, Idaho, USA`);

  return { street, city, state, zip, queries };
}

async function geocodeCensus(
  oneline: string,
): Promise<{ lat: number; lng: number } | null> {
  const url = new URL(
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress',
  );
  url.searchParams.set('address', oneline);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');
  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      result?: {
        addressMatches?: Array<{
          coordinates?: { x?: number; y?: number };
        }>;
      };
    };
    const hit = body.result?.addressMatches?.[0]?.coordinates;
    if (hit?.y == null || hit?.x == null) return null;
    const lat = Number(hit.y);
    const lng = Number(hit.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

async function geocodeNominatim(
  q: string,
): Promise<{ lat: number; lng: number } | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('q', q);
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'campaign-analytics/1.0 (voter geocode)',
      },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    const hit = rows[0];
    if (!hit?.lat || !hit?.lon) return null;
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/** Geocode from whatever address pieces we have (street, city, ZIP, county…). */
export async function geocodeVoterAddress(
  parts: AddressParts,
): Promise<{ lat: number; lng: number } | null> {
  const { queries } = normalizeAddressParts(parts);
  if (!queries.length) return null;

  for (const q of queries.slice(0, 4)) {
    const census = await geocodeCensus(q);
    if (census) return census;
  }
  for (const q of queries.slice(0, 2)) {
    const nom = await geocodeNominatim(q);
    if (nom) return nom;
  }
  return null;
}
