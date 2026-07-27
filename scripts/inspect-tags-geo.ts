import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const v = createClient(
  process.env.VOTER_SUPABASE_URL!,
  process.env.VOTER_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const c = createClient(
  process.env.CAMPAIGN_SUPABASE_URL!,
  process.env.CAMPAIGN_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const uni = await v
    .from('saved_voter_universes')
    .select('id,name,supporter_tag,tag_priority,filters');
  console.log('universes_err', uni.error?.message);
  for (const u of uni.data ?? []) {
    const f = (u.filters ?? {}) as Record<string, unknown>;
    const anyOf = Array.isArray(f.any_of) ? f.any_of : [];
    console.log(
      JSON.stringify({
        id: u.id,
        name: u.name,
        supporter_tag: u.supporter_tag,
        tag_priority: u.tag_priority,
        meta_tag: f._supporter_tag,
        any_of_len: anyOf.length,
        any_of: anyOf,
      }),
    );
  }

  const tagged = await v
    .from('voters')
    .select('id', { count: 'exact', head: true })
    .not('supporter_tag', 'is', null);
  console.log('tagged_count', tagged.count, tagged.error?.message);

  const sample = await v
    .from('voters')
    .select('id,first_name,last_name,supporter_tag,yard_sign,alignment_label')
    .not('supporter_tag', 'is', null)
    .limit(5);
  console.log('sample_tagged', sample.data);

  const ys = await c
    .from('yard_signs')
    .select('id', { count: 'exact', head: true })
    .not('lat', 'is', null);
  const vol = await c
    .from('volunteers')
    .select('id', { count: 'exact', head: true })
    .not('lat', 'is', null);
  console.log('yard_signs_with_coords', ys.count, ys.error?.message);
  console.log('volunteers_with_coords', vol.count, vol.error?.message);

  // Simulate enrich on first search page
  const search = await v.rpc('voter_search', {
    filters: {},
    q: '',
    page: 1,
    page_size: 5,
  });
  const rows = (search.data as { rows?: Array<Record<string, unknown>> })?.rows ?? [];
  console.log(
    'search_sample',
    rows.map((r) => ({
      name: `${r.first_name} ${r.last_name}`,
      tag: r.supporter_tag,
      yard: r.nearby_yard_sign_miles,
      vol: r.nearby_volunteer_miles,
      lat: r.lat,
    })),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
