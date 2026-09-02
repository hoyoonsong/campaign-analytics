/** Cloudflare 522/524 HTML (or aborted fetch) from the voter Supabase origin. */
export function isVoterOriginTimeout(message: string | null | undefined): boolean {
  const m = String(message ?? '');
  return (
    /522: Connection timed out/i.test(m) ||
    /Error code 522/i.test(m) ||
    /cf-error-details/i.test(m) ||
    /<!DOCTYPE html/i.test(m) ||
    /524: A timeout occurred/i.test(m) ||
    /\baborted\b/i.test(m)
  );
}

export const VOTER_ORIGIN_TIMEOUT_MESSAGE =
  'Voter database timed out. Wait a minute and refresh — this is Supabase, not a local crash.';

function requestUrl(input: string | URL | Request | { url?: string }): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  try {
    return 'url' in input && input.url ? input.url : '';
  } catch {
    return '';
  }
}

/** Full-file / map-dump RPCs. Tiny table reads must never be blocked by these. */
export function isExpensiveVoterRequest(
  input: string | URL | Request | { url?: string },
): boolean {
  const url = requestUrl(input);
  return /\/rpc\/(voter_analytics_summary|voter_map_points|voter_map_county_snapshot|voter_export_page|recompute_supporter_tags|contact_suggestions|voter_filter_options|apply_campaign_lean_sync|replace_campaign_geo|ensure_possible_duplicates|tracking_poll_dashboard|refresh_presence_cache|lookup_voters_for_poll)/i.test(
    url,
  );
}

export function isCloudflareOriginDeath(preview: string, status?: number): boolean {
  return (
    status === 522 ||
    status === 524 ||
    /522: Connection timed out/i.test(preview) ||
    /Error code 522/i.test(preview) ||
    /cf-error-details/i.test(preview) ||
    /524: A timeout occurred/i.test(preview)
  );
}

/** After a Cloudflare 522, skip expensive RPCs briefly. Cheap reads still go through. */
let originDownUntil = 0;

export function markVoterOriginDown() {
  originDownUntil = Date.now() + 30_000;
}

export function markVoterOriginUp() {
  originDownUntil = 0;
}

export function isVoterOriginDown() {
  return Date.now() < originDownUntil;
}
