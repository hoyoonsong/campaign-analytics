import type { SupabaseClient } from '@supabase/supabase-js';
import { campaignAdminClient } from './campaign';
import { milesBetween } from './geo';

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
  county: string;
};

type LeanPt = { id: number; lat: number; lng: number };

function truthyYes(v: string | null | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'yes' || s === 'y' || s === 'delivered' || s === 'true' || s === '1';
}

function cellKey(lat: number, lng: number, cellMiles: number): string {
  const latStep = cellMiles / 69;
  const lngStep =
    cellMiles / (69 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2));
  return `${Math.floor(lat / latStep)}:${Math.floor(lng / lngStep)}`;
}

function neighborKeys(
  lat: number,
  lng: number,
  cellMiles: number,
  ring = 2,
): string[] {
  const latStep = cellMiles / 69;
  const lngStep =
    cellMiles / (69 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2));
  const i0 = Math.floor(lat / latStep);
  const j0 = Math.floor(lng / lngStep);
  const keys: string[] = [];
  for (let di = -ring; di <= ring; di++) {
    for (let dj = -ring; dj <= ring; dj++) {
      keys.push(`${i0 + di}:${j0 + dj}`);
    }
  }
  return keys;
}

async function loadYardSignPins(): Promise<LeanPt[]> {
  const campaign = campaignAdminClient();
  const out: LeanPt[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await campaign
      .from('yard_signs')
      .select('id,lat,lng')
      .not('lat', 'is', null)
      .not('lng', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    for (const row of batch) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        out.push({ id: 0, lat, lng });
      }
    }
    if (batch.length < pageSize) break;
  }
  return out;
}

/** Parallel lean fetch — county required so we don't pull 100k+ statewide rows. */
async function loadLeanVoters(
  voter: SupabaseClient,
  county: string,
): Promise<LeanPt[]> {
  const pageSize = 1000;
  const concurrency = 8;

  // Probe first page + estimate via count
  const first = await voter
    .from('voters')
    .select('id,lat,lng', { count: 'exact' })
    .ilike('county', county)
    .not('lat', 'is', null)
    .not('lng', 'is', null)
    .order('id', { ascending: true })
    .range(0, pageSize - 1);

  if (first.error) throw new Error(first.error.message);
  const total = first.count ?? first.data?.length ?? 0;
  const out: LeanPt[] = [];
  const pushBatch = (batch: Array<{ id: number; lat: number | null; lng: number | null }>) => {
    for (const row of batch) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        out.push({ id: Number(row.id), lat, lng });
      }
    }
  };
  pushBatch((first.data ?? []) as Array<{ id: number; lat: number | null; lng: number | null }>);

  if (total <= pageSize) return out;

  const starts: number[] = [];
  for (let from = pageSize; from < total; from += pageSize) starts.push(from);

  for (let i = 0; i < starts.length; i += concurrency) {
    const chunk = starts.slice(i, i + concurrency);
    const pages = await Promise.all(
      chunk.map((from) =>
        voter
          .from('voters')
          .select('id,lat,lng')
          .ilike('county', county)
          .not('lat', 'is', null)
          .not('lng', 'is', null)
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1),
      ),
    );
    for (const page of pages) {
      if (page.error) throw new Error(page.error.message);
      pushBatch(
        (page.data ?? []) as Array<{
          id: number;
          lat: number | null;
          lng: number | null;
        }>,
      );
    }
  }
  return out;
}

async function hydrateVoters(
  voter: SupabaseClient,
  ids: number[],
): Promise<
  Map<
    number,
    {
      id: number;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      address_line_1: string | null;
      city: string | null;
      zip: string | null;
      county: string | null;
      party: string | null;
      yard_sign: string | null;
      supporter_tag: string | null;
    }
  >
> {
  const map = new Map<
    number,
    {
      id: number;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      address_line_1: string | null;
      city: string | null;
      zip: string | null;
      county: string | null;
      party: string | null;
      yard_sign: string | null;
      supporter_tag: string | null;
    }
  >();
  if (!ids.length) return map;

  // Prefer contactable people when multiple IDs land in same cell.
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data, error } = await voter
      .from('voters')
      .select(
        'id, first_name, last_name, email, phone, address_line_1, city, zip, county, party, yard_sign, supporter_tag',
      )
      .in('id', slice);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      map.set(Number(row.id), {
        id: Number(row.id),
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        address_line_1: row.address_line_1 ?? null,
        city: row.city ?? null,
        zip: row.zip ?? null,
        county: row.county ?? null,
        party: row.party ?? null,
        yard_sign: row.yard_sign ?? null,
        supporter_tag: row.supporter_tag ?? null,
      });
    }
  }
  return map;
}

/**
 * Fast grid greedy: county-scoped lean coords → densest uncovered cells →
 * hydrate only the ~N suggested contact rows.
 */
export async function computeYardSignSuggestions(
  voter: SupabaseClient,
  opts?: {
    radius_miles?: number;
    max_suggestions?: number;
    county?: string[];
  },
): Promise<YardSignSuggestionsResult> {
  const county = (opts?.county?.[0] ?? '').trim();
  if (!county) {
    throw new Error('Pick a county — statewide suggestions are too slow.');
  }

  const radius = Math.max(0.1, Number(opts?.radius_miles) || 0.5);
  const maxSuggestions = Math.min(
    100,
    Math.max(1, Number(opts?.max_suggestions) || 40),
  );

  const [signs, voters] = await Promise.all([
    loadYardSignPins(),
    loadLeanVoters(voter, county),
  ]);

  const cellMiles = Math.max(0.12, radius / 2);
  const signCells = new Map<string, LeanPt[]>();
  for (const s of signs) {
    const k = cellKey(s.lat, s.lng, cellMiles);
    const list = signCells.get(k);
    if (list) list.push(s);
    else signCells.set(k, [s]);
  }

  const isCoveredBySign = (v: LeanPt): boolean => {
    for (const k of neighborKeys(v.lat, v.lng, cellMiles, 3)) {
      for (const s of signCells.get(k) ?? []) {
        if (milesBetween(v.lat, v.lng, s.lat, s.lng) <= radius) return true;
      }
    }
    return false;
  };

  const uncovered: LeanPt[] = [];
  let alreadyCovered = 0;
  for (const v of voters) {
    if (isCoveredBySign(v)) alreadyCovered++;
    else uncovered.push(v);
  }

  const byCell = new Map<string, LeanPt[]>();
  for (const v of uncovered) {
    const k = cellKey(v.lat, v.lng, cellMiles);
    const list = byCell.get(k);
    if (list) list.push(v);
    else byCell.set(k, [v]);
  }

  const remaining = new Set(uncovered.map((v) => v.id));
  const pickedIds: Array<{ id: number; lat: number; lng: number; covers: number }> =
    [];

  while (pickedIds.length < maxSuggestions && remaining.size > 0) {
    // Densest remaining cells
    const ranked = [...byCell.entries()]
      .map(([k, list]) => ({
        k,
        pts: list.filter((v) => remaining.has(v.id)),
      }))
      .filter((c) => c.pts.length > 0)
      .sort((a, b) => b.pts.length - a.pts.length);

    if (!ranked.length) break;

    // Among top cells, pick the voter that covers the most remaining neighbors
    let best: LeanPt | null = null;
    let bestCovers = 0;
    const topCells = ranked.slice(0, 25);
    for (const cell of topCells) {
      // Sample up to 5 points per dense cell
      const sample = cell.pts.slice(0, 5);
      for (const center of sample) {
        let covers = 0;
        for (const k of neighborKeys(center.lat, center.lng, cellMiles, 3)) {
          for (const o of byCell.get(k) ?? []) {
            if (!remaining.has(o.id)) continue;
            if (milesBetween(center.lat, center.lng, o.lat, o.lng) <= radius) {
              covers++;
            }
          }
        }
        if (covers > bestCovers) {
          bestCovers = covers;
          best = center;
        }
      }
    }

    if (!best || bestCovers <= 0) break;

    const coveredNow: number[] = [];
    for (const k of neighborKeys(best.lat, best.lng, cellMiles, 3)) {
      for (const o of byCell.get(k) ?? []) {
        if (!remaining.has(o.id)) continue;
        if (milesBetween(best.lat, best.lng, o.lat, o.lng) <= radius) {
          coveredNow.push(o.id);
        }
      }
    }
    for (const id of coveredNow) remaining.delete(id);

    pickedIds.push({
      id: best.id,
      lat: best.lat,
      lng: best.lng,
      covers: coveredNow.length,
    });
  }

  // For each pick, also consider nearby contactable voters — hydrate a small
  // candidate set around each pick and prefer email/phone.
  const candidateIds = new Set(pickedIds.map((p) => p.id));
  for (const p of pickedIds) {
    for (const k of neighborKeys(p.lat, p.lng, cellMiles, 1)) {
      for (const o of (byCell.get(k) ?? []).slice(0, 12)) {
        candidateIds.add(o.id);
      }
    }
  }

  const details = await hydrateVoters(voter, [...candidateIds]);

  const suggestions: YardSignSuggestion[] = [];
  const used = new Set<number>();

  for (const p of pickedIds) {
    // Prefer a contactable neighbor in the same coverage area
    const local: Array<{ id: number; score: number }> = [];
    for (const k of neighborKeys(p.lat, p.lng, cellMiles, 1)) {
      for (const o of byCell.get(k) ?? []) {
        if (used.has(o.id)) continue;
        if (milesBetween(p.lat, p.lng, o.lat, o.lng) > radius) continue;
        const d = details.get(o.id);
        if (!d) continue;
        let score = 0;
        if ((d.email ?? '').trim() || (d.phone ?? '').trim()) score += 10;
        if (!truthyYes(d.yard_sign)) score += 3;
        if ((d.supporter_tag ?? '').toLowerCase() === 'supporter') score += 2;
        // Prefer closer to the geometric pick
        score += Math.max(0, 5 - milesBetween(p.lat, p.lng, o.lat, o.lng) * 4);
        local.push({ id: o.id, score });
      }
    }
    local.sort((a, b) => b.score - a.score);
    const chosenId = local[0]?.id ?? p.id;
    const d = details.get(chosenId);
    const pt =
      uncovered.find((u) => u.id === chosenId) ??
      voters.find((u) => u.id === chosenId);
    if (!d || !pt) continue;
    used.add(chosenId);

    suggestions.push({
      rank: suggestions.length + 1,
      voter_id: chosenId,
      first_name: d.first_name,
      last_name: d.last_name,
      email: d.email,
      phone: d.phone,
      address_line_1: d.address_line_1,
      city: d.city,
      zip: d.zip,
      county: d.county,
      party: d.party,
      lat: pt.lat,
      lng: pt.lng,
      yard_sign: d.yard_sign,
      supporter_tag: d.supporter_tag,
      covers: p.covers,
      already_has_sign: truthyYes(d.yard_sign),
      has_contact: Boolean((d.email ?? '').trim() || (d.phone ?? '').trim()),
    });
  }

  return {
    radius_miles: radius,
    existing_signs: signs.length,
    voters_with_coords: voters.length,
    already_covered: alreadyCovered,
    uncovered: uncovered.length,
    suggestions,
    county,
  };
}
