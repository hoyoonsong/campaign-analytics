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

/** After a 522, fail fast for a minute so refresh does not keep the origin down. */
let originDownUntil = 0;

export function markVoterOriginDown() {
  originDownUntil = Date.now() + 60_000;
}

export function markVoterOriginUp() {
  originDownUntil = 0;
}

export function isVoterOriginDown() {
  return Date.now() < originDownUntil;
}
