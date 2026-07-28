import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, requireCampaignUser } from '../../_lib/auth.js';
import { buildLeanSyncPayload, campaignAdminClient } from '../../_lib/campaign.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const { data, error } = await ctx.voter
      .from('campaign_sync_state')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) return json(res, 500, { error: error.message });
    return json(res, 200, { state: data });
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const recomputeTags = (() => {
    const body = (req.body ?? {}) as { recompute_tags?: boolean };
    return body.recompute_tags !== false;
  })();

  try {
    const campaign = campaignAdminClient();
    const payload = await buildLeanSyncPayload(campaign);

    const { data: syncResult, error: syncErr } = await ctx.voter.rpc(
      'apply_campaign_lean_sync',
      {
        p_contacts: payload.contacts,
        p_geo: payload.geo,
        p_volunteer_count: payload.volunteer_count,
        p_yard_sign_count: payload.yard_sign_count,
      },
    );

    if (syncErr) {
      // Lean sync can fail under pg_safeupdate (unqualified UPDATE). Still refresh
      // map pins with contact fields so Analytics popups stay populated.
      const { data: geoOnly, error: geoErr } = await ctx.voter.rpc(
        'replace_campaign_geo',
        { p_geo: payload.geo },
      );
      await ctx.voter
        .from('campaign_sync_state')
        .update({
          last_error: syncErr.message,
          volunteer_count: payload.volunteer_count,
          yard_sign_count: payload.yard_sign_count,
          geo_point_count:
            typeof (geoOnly as { geo_count?: number } | null)?.geo_count === 'number'
              ? (geoOnly as { geo_count: number }).geo_count
              : payload.geo.length,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1);
      return json(res, 500, {
        error: syncErr.message,
        geo: geoErr ? { error: geoErr.message } : geoOnly,
      });
    }

    let tagsResult: unknown = null;
    if (recomputeTags) {
      const { data, error } = await ctx.voter.rpc('recompute_supporter_tags');
      if (error) {
        return json(res, 500, {
          error: `Indexes synced but tag recompute failed: ${error.message}`,
          sync: syncResult,
        });
      }
      tagsResult = data;
    }

    let presenceCache: unknown = null;
    {
      const { data, error } = await ctx.voter.rpc('refresh_presence_cache');
      if (error) {
        console.warn('[sync-campaign] presence cache failed', error.message);
      } else {
        presenceCache = data;
      }
    }

    const { data: state } = await ctx.voter
      .from('campaign_sync_state')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    return json(res, 200, {
      ok: true,
      sync: syncResult,
      tags: tagsResult,
      presence: presenceCache,
      state,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    try {
      await ctx.voter
        .from('campaign_sync_state')
        .update({ last_error: message, updated_at: new Date().toISOString() })
        .eq('id', 1);
    } catch {
      /* ignore secondary write failure */
    }
    return json(res, 500, { error: message });
  }
}
