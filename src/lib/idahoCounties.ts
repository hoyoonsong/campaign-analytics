// Idaho county boundaries + point-in-polygon lookup for the Volunteers map.
// The GeoJSON (44 counties, coordinates as [lng, lat]) is trimmed from the US
// Census county set and rounded to ~3 decimals — plenty for county display.

import raw from '../data/idahoCounties.json';

type Ring = number[][]; // [ [lng, lat], ... ]
type PolygonCoords = Ring[]; // [ outerRing, ...holes ]
type MultiPolygonCoords = PolygonCoords[];

interface CountyFeature {
  type: 'Feature';
  properties: { name: string };
  geometry:
    | { type: 'Polygon'; coordinates: PolygonCoords }
    | { type: 'MultiPolygon'; coordinates: MultiPolygonCoords };
}

interface CountyCollection {
  type: 'FeatureCollection';
  features: CountyFeature[];
}

export const IDAHO_COUNTIES = raw as CountyCollection;

export const COUNTY_NAMES: string[] = IDAHO_COUNTIES.features
  .map((f) => f.properties.name)
  .sort((a, b) => a.localeCompare(b));

const COUNTY_LOOKUP = new Map(COUNTY_NAMES.map((n) => [n.toLowerCase(), n]));

/** Longest-first so "Twin Falls" matches before a shorter accidental hit. */
const COUNTY_NAMES_BY_LENGTH = [...COUNTY_NAMES].sort((a, b) => b.length - a.length);

export function isIdahoCounty(name: string | null | undefined): boolean {
  if (!name) return false;
  return COUNTY_LOOKUP.has(name.trim().toLowerCase());
}

/**
 * Normalise a raw county string from a spreadsheet to a canonical Idaho county
 * name. Handles messy imports like "Ada/Boise", "Valley, McCall", "ADA COUNTY".
 * Returns null when blank or when no Idaho county can be identified (e.g.
 * "Walla Walla" — that's Washington).
 */
/**
 * Canonical, de-duped list of Idaho county names from a free-form array
 * (import / DB). Drops blanks and non-Idaho names.
 */
export function normalizeCaptainCounties(
  raw: string[] | null | undefined,
): string[] {
  if (!raw?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const name = normalizeCountyName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function normalizeCountyName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\bcounty\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  // Exact match.
  const exact = COUNTY_LOOKUP.get(cleaned.toLowerCase());
  if (exact) return exact;

  // Pieces split on common separators ("Ada/Boise", "Valley, McCall").
  const pieces = cleaned
    .split(/[/|,;]+|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const piece of pieces) {
    const hit = COUNTY_LOOKUP.get(piece.toLowerCase());
    if (hit) return hit;
  }

  // Substring match against known Idaho counties (word-boundary-ish).
  const lower = ` ${cleaned.toLowerCase()} `;
  for (const name of COUNTY_NAMES_BY_LENGTH) {
    if (lower.includes(` ${name.toLowerCase()} `)) return name;
  }

  return null;
}

/** Ray-casting: is (lng,lat) inside a single ring? */
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
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

/** Inside the outer ring but not inside any hole. */
function pointInPolygon(lng: number, lat: number, polygon: PolygonCoords): boolean {
  if (polygon.length === 0) return false;
  if (!pointInRing(lng, lat, polygon[0])) return false;
  for (let h = 1; h < polygon.length; h++) {
    if (pointInRing(lng, lat, polygon[h])) return false;
  }
  return true;
}

/** Which Idaho county contains this coordinate, if any. */
export function countyForPoint(lat: number, lng: number): string | null {
  for (const f of IDAHO_COUNTIES.features) {
    if (f.geometry.type === 'Polygon') {
      if (pointInPolygon(lng, lat, f.geometry.coordinates)) return f.properties.name;
    } else {
      for (const poly of f.geometry.coordinates) {
        if (pointInPolygon(lng, lat, poly)) return f.properties.name;
      }
    }
  }
  return null;
}

/** Rough centroid of a county (average of outer-ring vertices) for labels. */
function polygonCentroid(coords: PolygonCoords): [number, number] {
  const ring = coords[0] ?? [];
  let x = 0;
  let y = 0;
  for (const [lng, lat] of ring) {
    x += lng;
    y += lat;
  }
  const n = ring.length || 1;
  return [x / n, y / n];
}

/** County name -> [lat, lng] label anchor. */
export const COUNTY_CENTROIDS: Record<string, [number, number]> = Object.fromEntries(
  IDAHO_COUNTIES.features.map((f) => {
    let poly: PolygonCoords;
    if (f.geometry.type === 'Polygon') {
      poly = f.geometry.coordinates;
    } else {
      // Largest sub-polygon by outer-ring vertex count.
      poly = f.geometry.coordinates.reduce((a, b) =>
        (b[0]?.length ?? 0) > (a[0]?.length ?? 0) ? b : a,
      );
    }
    const [lng, lat] = polygonCentroid(poly);
    return [f.properties.name, [lat, lng] as [number, number]];
  }),
);
