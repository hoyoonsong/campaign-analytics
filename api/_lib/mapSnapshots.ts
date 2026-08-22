import type { SupabaseClient } from '@supabase/supabase-js';

/** Drop cached county coords after the voter file changes. Ignore if migration is pending. */
export async function invalidateMapSnapshots(voter: SupabaseClient) {
  const { error } = await voter.rpc('invalidate_voter_map_snapshots');
  if (error && !/could not find the function|schema cache/i.test(error.message)) {
    // eslint-disable-next-line no-console
    console.warn('[map-snapshots] invalidate failed', error.message);
  }
}
