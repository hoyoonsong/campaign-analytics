import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import { json, requireCampaignUser } from '../../_lib/auth.js';

function shapeOptions(d: Record<string, unknown>) {
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : [];
  return {
    counties: asStrings(d.counties),
    parties: asStrings(d.parties),
    statuses: asStrings(d.statuses),
    states: asStrings(d.states),
    cities: asStrings(d.cities),
    alignment_labels: asStrings(d.alignment_labels),
    yard_signs: asStrings(d.yard_signs),
    volunteer_interests: asStrings(d.volunteer_interests),
    newsletters: asStrings(d.newsletters),
    donated: asStrings(d.donated),
    attended_events: asStrings(d.attended_events),
    top_main_topics: asStrings(d.top_main_topics),
    convos_candidate_support: asStrings(d.convos_candidate_support),
    convos_contact_status: asStrings(d.convos_contact_status),
  };
}

/**
 * Distinct Idaho cities from voters (state = ID).
 * Letter-prefix pages avoid the old RPC `limit 500` that dropped Preston, etc.
 */
async function fetchIdahoCities(voter: SupabaseClient): Promise<string[]> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const map = new Map<string, string>();

  await Promise.all(
    letters.map(async (letter) => {
      const { data, error } = await voter
        .from('voters')
        .select('city')
        .ilike('state', 'id')
        .ilike('city', `${letter}%`)
        .limit(4000);
      if (error) {
        console.warn('[filter-options] city page', letter, error.message);
        return;
      }
      for (const row of data ?? []) {
        const t = String(row.city ?? '').trim();
        if (!t) continue;
        const k = t.toLowerCase();
        const display =
          t === t.toUpperCase() && t.length > 1
            ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
            : t;
        const existing = map.get(k);
        if (!existing) map.set(k, display);
        else if (
          existing === existing.toUpperCase() &&
          display !== display.toUpperCase()
        ) {
          map.set(k, display);
        }
      }
    }),
  );

  return [...map.values()].sort((a, b) => a.localeCompare(b));
}

function citiesLookTruncated(cities: unknown): boolean {
  if (!Array.isArray(cities)) return true;
  // Legacy RPC capped at 500 and mixed in out-of-state names (Abilene, Akron…).
  if (cities.length === 0 || cities.length === 500) return true;
  const sample = cities.slice(0, 30).map((c) => String(c).toLowerCase());
  if (sample.some((c) => c === 'abilene' || c === 'akron' || c === 'albany')) {
    return true;
  }
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const { data: cache } = await ctx.voter
    .from('campaign_sync_state')
    .select('filter_options_cache, filter_options_cached_at')
    .eq('id', 1)
    .maybeSingle();

  const cached = cache?.filter_options_cache;
  if (
    cached &&
    typeof cached === 'object' &&
    !citiesLookTruncated((cached as Record<string, unknown>).cities)
  ) {
    return json(res, 200, {
      ...shapeOptions(cached as Record<string, unknown>),
      from_cache: true,
      cached_at: cache?.filter_options_cached_at ?? null,
    });
  }

  const { data, error } = await ctx.voter.rpc('voter_filter_options');
  if (error) return json(res, 500, { error: error.message });

  const d = { ...((data ?? {}) as Record<string, unknown>) };
  try {
    d.cities = await fetchIdahoCities(ctx.voter);
  } catch (err) {
    console.warn(
      '[filter-options] idaho cities fallback failed',
      err instanceof Error ? err.message : err,
    );
  }

  await ctx.voter
    .from('campaign_sync_state')
    .update({
      filter_options_cache: d,
      filter_options_cached_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  return json(res, 200, { ...shapeOptions(d), from_cache: false });
}
