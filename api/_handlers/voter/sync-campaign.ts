import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, requireCampaignUser } from '../../_lib/auth.js';
import { buildLeanSyncPayload, campaignAdminClient } from '../../_lib/campaign.js';
import {
  applyLeanSyncFallback,
  refreshPresenceBestEffort,
} from '../../_lib/leanSyncFallback.js';
import { isVoterOriginDown, isVoterOriginTimeout } from '../../_lib/originError.js';
import { recallSyncState, rememberCampaignGeo, rememberSyncState } from '../../_lib/voterMemCache.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const cached = recallSyncState();
    if (isVoterOriginDown() && cached) {
      return json(res, 200, { state: cached });
    }
    const { data, error } = await ctx.voter
      .from('campaign_sync_state')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      if (cached) return json(res, 200, { state: cached });
      return json(res, 200, { state: null });
    }
    if (data) rememberSyncState(data as Record<string, unknown>);
    return json(res, 200, { state: data });
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  if (isVoterOriginDown()) {
    return json(res, 503, {
      error:
        'Voter database is recovering. Skip FormHandler sync until it is back — do not retry immediately.',
    });
  }

  const recomputeTags = (() => {
    const body = (req.body ?? {}) as { recompute_tags?: boolean };
    return body.recompute_tags !== false;
  })();

  try {
    const campaign = campaignAdminClient();
    const payload = await buildLeanSyncPayload(campaign);

    let syncResult: unknown = null;
    let usedFallback = false;

    const { data: leanData, error: syncErr } = await ctx.voter.rpc(
      'apply_campaign_lean_sync',
      {
        p_contacts: payload.contacts,
        p_geo: payload.geo,
        p_volunteer_count: payload.volunteer_count,
        p_yard_sign_count: payload.yard_sign_count,
      },
    );

    if (syncErr) {
      if (isVoterOriginTimeout(syncErr.message)) {
        return json(res, 503, {
          error:
            'Voter database timed out during FormHandler sync. Skip sync until Supabase is back — do not retry immediately.',
        });
      }
      // Pre-0036 SQL still has an unqualified UPDATE; PostgREST safeupdate
      // rejects it. Fall back to a WHERE-safe path so sync keeps working.
      // eslint-disable-next-line no-console
      console.warn(
        '[sync-campaign] lean RPC failed, using fallback:',
        syncErr.message,
      );
      syncResult = await applyLeanSyncFallback(ctx.voter, payload);
      usedFallback = true;
    } else {
      syncResult = leanData;
    }

    rememberCampaignGeo(payload.geo);

    let tagsResult: unknown = null;
    if (recomputeTags) {
      const { data, error } = await ctx.voter.rpc('recompute_supporter_tags');
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[sync-campaign] tag recompute failed', error.message);
        tagsResult = { error: error.message };
      } else {
        tagsResult = data;
      }
    }

    const presenceCache = isVoterOriginDown()
      ? { skipped: true }
      : await refreshPresenceBestEffort(ctx.voter);

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
      fallback: usedFallback || undefined,
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
