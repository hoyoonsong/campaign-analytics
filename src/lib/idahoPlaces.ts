import idahoCitiesRaw from '../data/idahoCities.json';
import { COUNTY_NAMES, normalizeCountyName } from './idahoCounties';

export { COUNTY_NAMES };

/** Canonical Idaho city names (from ID-state voters + title-case). */
export const IDAHO_CITIES: string[] = idahoCitiesRaw as string[];

const CITY_LOOKUP = new Map(
  IDAHO_CITIES.map((c) => [c.toLowerCase(), c]),
);

export function normalizeIdahoCity(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const hit = CITY_LOOKUP.get(raw.trim().toLowerCase());
  if (hit) return hit;
  // Soft match: "Boise City" → Boise
  const cleaned = raw.trim().replace(/\s+city$/i, '').trim();
  return CITY_LOOKUP.get(cleaned.toLowerCase()) ?? null;
}

/** Prefer Idaho counties; fall back to normalizing API values. */
export function idahoCountyOptions(apiCounties?: string[] | null): string[] {
  const fromApi = (apiCounties ?? [])
    .map((c) => normalizeCountyName(c))
    .filter((c): c is string => !!c);
  const set = new Set([...COUNTY_NAMES, ...fromApi]);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Idaho cities for the filter UI.
 * Prefer canonical list; intersect with API cities when available so we
 * only show places that exist in the import.
 */
export function idahoCityOptions(apiCities?: string[] | null): string[] {
  if (!apiCities?.length) return IDAHO_CITIES;
  const apiNorm = new Set(
    apiCities
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  );
  const matched = IDAHO_CITIES.filter((c) => {
    const low = c.toLowerCase();
    return (
      apiNorm.has(low) ||
      apiNorm.has(`${low} city`) ||
      [...apiNorm].some((a) => a === low || a.startsWith(low + ' '))
    );
  });
  // Also include API cities that normalize to an Idaho city
  for (const raw of apiCities) {
    const n = normalizeIdahoCity(raw);
    if (n && !matched.includes(n)) matched.push(n);
  }
  return matched.sort((a, b) => a.localeCompare(b));
}
