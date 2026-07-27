import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, requireCampaignUser } from '../_lib/auth.js';

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
  if (cached && typeof cached === 'object') {
    return json(res, 200, {
      ...shapeOptions(cached as Record<string, unknown>),
      from_cache: true,
      cached_at: cache?.filter_options_cached_at ?? null,
    });
  }

  const { data, error } = await ctx.voter.rpc('voter_filter_options');
  if (error) return json(res, 500, { error: error.message });

  const d = (data ?? {}) as Record<string, unknown>;
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
