import type { SupabaseClient } from '@supabase/supabase-js';

type ContactRow = {
  person_id: string;
  email: string | null;
  phone_digits: string | null;
  is_volunteer: boolean;
};

type GeoRow = {
  source_id: string;
  kind: 'volunteer' | 'yard_sign';
  lat: number;
  lng: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
};

export type LeanSyncPayload = {
  contacts: ContactRow[];
  geo: GeoRow[];
  volunteer_count: number;
  yard_sign_count: number;
};

type VoterClient = SupabaseClient;

/**
 * Safe fallback when apply_campaign_lean_sync fails under pg_safeupdate
 * ("UPDATE requires a WHERE clause" — migration 0036 not applied yet).
 *
 * Refreshes map pins + sync state. Full email/phone voter matching still needs
 * 0036 applied via `npm run db:apply-campaign`.
 */
export async function applyLeanSyncFallback(
  voter: VoterClient,
  payload: LeanSyncPayload,
): Promise<{
  geo_point_count: number;
  matched_voter_count: number;
  contact_rows: number;
  mode: 'geo_only';
}> {
  const { data: geoOnly, error: geoErr } = await voter.rpc('replace_campaign_geo', {
    p_geo: payload.geo,
  });
  if (geoErr) throw new Error(geoErr.message);

  const geoCount =
    typeof (geoOnly as { geo_count?: number } | null)?.geo_count === 'number'
      ? (geoOnly as { geo_count: number }).geo_count
      : payload.geo.length;

  // Preserve prior matched count if we can't recompute without the fixed RPC.
  const { data: prev } = await voter
    .from('campaign_sync_state')
    .select('matched_voter_count')
    .eq('id', 1)
    .maybeSingle();

  await voter
    .from('campaign_sync_state')
    .update({
      last_success_at: new Date().toISOString(),
      volunteer_count: payload.volunteer_count,
      yard_sign_count: payload.yard_sign_count,
      matched_voter_count: prev?.matched_voter_count ?? 0,
      geo_point_count: geoCount,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  return {
    geo_point_count: geoCount,
    matched_voter_count: prev?.matched_voter_count ?? 0,
    contact_rows: payload.contacts.length,
    mode: 'geo_only',
  };
}

/** Best-effort avg-distance + analytics cache refresh (never throws). */
export async function refreshPresenceBestEffort(
  voter: VoterClient,
): Promise<unknown> {
  const { data, error } = await voter.rpc('refresh_presence_cache');
  if (!error) return data;

  // eslint-disable-next-line no-console
  console.warn('[sync-campaign] refresh_presence_cache failed', error.message);

  // Fallback: just recompute avg nearby into sync state.
  try {
    const { data: avg, error: avgErr } = await voter.rpc('voter_avg_nearby', {
      filters: { state: ['ID'] },
      sample_n: 800,
    });
    if (avgErr || !avg) {
      return { error: error.message, avg_error: avgErr?.message };
    }

    const row = avg as Record<string, unknown>;
    await voter
      .from('campaign_sync_state')
      .update({
        avg_nearby_yard_sign_miles:
          row.avg_nearby_yard_sign_miles != null
            ? Number(row.avg_nearby_yard_sign_miles)
            : null,
        avg_nearby_volunteer_miles:
          row.avg_nearby_volunteer_miles != null
            ? Number(row.avg_nearby_volunteer_miles)
            : null,
        avg_nearby_sample_size:
          row.avg_nearby_sample_size != null
            ? Number(row.avg_nearby_sample_size)
            : 0,
        avg_nearby_scope: 'state:ID',
        avg_nearby_computed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1);
    return { avg, fallback: true, presence_error: error.message };
  } catch (err) {
    return {
      error: error.message,
      fallback_error: err instanceof Error ? err.message : String(err),
    };
  }
}
