import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, requireCampaignUser } from '../../_lib/auth.js';
import { isVoterOriginDown } from '../../_lib/originError.js';
import { recallFilterOptions, rememberFilterOptions } from '../../_lib/voterMemCache.js';

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

  const mem = recallFilterOptions();
  if (isVoterOriginDown() && mem) {
    return json(res, 200, { ...shapeOptions(mem), from_cache: true });
  }

  const { data: cache, error: cacheErr } = await ctx.voter
    .from('campaign_sync_state')
    .select('filter_options_cache, filter_options_cached_at')
    .eq('id', 1)
    .maybeSingle();

  if (cacheErr) {
    if (mem) return json(res, 200, { ...shapeOptions(mem), from_cache: true });
    return json(res, 200, { ...shapeOptions({}), from_cache: true });
  }

  const cached = cache?.filter_options_cache;
  if (
    cached &&
    typeof cached === 'object' &&
    !citiesLookTruncated((cached as Record<string, unknown>).cities)
  ) {
    const obj = cached as Record<string, unknown>;
    rememberFilterOptions(obj);
    return json(res, 200, {
      ...shapeOptions(obj),
      from_cache: true,
      cached_at: cache?.filter_options_cached_at ?? null,
    });
  }

  if (isVoterOriginDown()) {
    if (mem) return json(res, 200, { ...shapeOptions(mem), from_cache: true });
    return json(res, 200, { ...shapeOptions({}), from_cache: true });
  }

  const { data, error } = await ctx.voter.rpc('voter_filter_options');
  if (error) {
    if (mem) return json(res, 200, { ...shapeOptions(mem), from_cache: true });
    return json(res, 200, { ...shapeOptions({}), from_cache: true });
  }

  const d = { ...((data ?? {}) as Record<string, unknown>) };
  // Never scan voters A–Z here — 26 parallel queries take the origin down.
  rememberFilterOptions(d);

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
