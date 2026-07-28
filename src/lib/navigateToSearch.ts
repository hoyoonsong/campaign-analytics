import type { NavigateFunction } from 'react-router-dom';
import { emptyFilters } from './filters';
import type { VoterFilters } from './types';

/** One-shot handoff from Analytics / Universes → Search. */
export const SEARCH_FILTERS_HANDOFF_KEY = 'voter_universe_filters';

/** Persisted Search filters across visits. */
export const SEARCH_FILTERS_STORAGE_KEY = 'voter_search_filters_v1';

export function loadPersistedSearchFilters(): VoterFilters | null {
  try {
    const raw = localStorage.getItem(SEARCH_FILTERS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VoterFilters>;
    return { ...emptyFilters(), ...parsed };
  } catch {
    return null;
  }
}

export function persistSearchFilters(filters: VoterFilters) {
  try {
    localStorage.setItem(SEARCH_FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    /* ignore */
  }
}

export function clearPersistedSearchFilters() {
  try {
    localStorage.removeItem(SEARCH_FILTERS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Stash filters and open Search with that universe. */
export function navigateToSearch(
  navigate: NavigateFunction,
  patch: Partial<VoterFilters>,
) {
  const filters: VoterFilters = { ...emptyFilters(), ...patch };
  try {
    sessionStorage.setItem(SEARCH_FILTERS_HANDOFF_KEY, JSON.stringify(filters));
    persistSearchFilters(filters);
  } catch {
    /* ignore */
  }
  navigate('/search');
}

/** Age chart bucket → inclusive age_min / age_max (null max = no upper bound). */
export function ageBandToRange(
  band: string,
): { age_min: number | null; age_max: number | null } | null {
  switch (band) {
    case 'Under 18':
      return { age_min: 0, age_max: 17 };
    case '18–24':
    case '18-24':
      return { age_min: 18, age_max: 24 };
    case '25–34':
    case '25-34':
      return { age_min: 25, age_max: 34 };
    case '35–44':
    case '35-44':
      return { age_min: 35, age_max: 44 };
    case '45–54':
    case '45-54':
      return { age_min: 45, age_max: 54 };
    case '55–64':
    case '55-64':
      return { age_min: 55, age_max: 64 };
    case '65+':
      return { age_min: 65, age_max: null };
    default:
      return null; // Unknown — skip
  }
}
