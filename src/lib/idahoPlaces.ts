import { COUNTY_NAMES, normalizeCountyName } from './idahoCounties';

export { COUNTY_NAMES };

/** Prefer Idaho counties; fall back to normalizing API values. */
export function idahoCountyOptions(apiCounties?: string[] | null): string[] {
  const fromApi = (apiCounties ?? [])
    .map((c) => normalizeCountyName(c))
    .filter((c): c is string => !!c);
  const set = new Set([...COUNTY_NAMES, ...fromApi]);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * City filter options from the DB (via filter-options API).
 * Case-insensitive unique; keeps a readable casing from the import.
 */
export function idahoCityOptions(apiCities?: string[] | null): string[] {
  if (!apiCities?.length) return [];
  const map = new Map<string, string>();
  for (const raw of apiCities) {
    const t = raw?.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    // Prefer Title-ish casing when the stored value is ALL CAPS.
    const display =
      t === t.toUpperCase() && t.length > 1
        ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
        : t;
    const existing = map.get(k);
    if (!existing) {
      map.set(k, display);
    } else if (
      existing === existing.toUpperCase() &&
      display !== display.toUpperCase()
    ) {
      map.set(k, display);
    }
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b));
}
