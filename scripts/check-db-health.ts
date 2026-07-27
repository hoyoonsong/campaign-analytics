import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const v = createClient(
  process.env.VOTER_SUPABASE_URL!,
  process.env.VOTER_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  for (const table of [
    'campaign_geo_points',
    'campaign_sync_state',
    'campaign_person_contacts',
  ]) {
    const r = await v.from(table).select('*', { count: 'exact', head: true });
    console.log(table, r.error?.message ?? `ok count=${r.count}`);
  }

  const cols = await v.from('voters').select('*').limit(1);
  const keys = cols.data?.[0] ? Object.keys(cols.data[0]).sort() : [];
  console.log(
    'has_supporter_tag',
    keys.includes('supporter_tag'),
    'has_volunteer_linked',
    keys.includes('volunteer_linked'),
  );

  const t0 = Date.now();
  const simple = await v
    .from('voters')
    .select('id,first_name,last_name')
    .order('last_name')
    .range(0, 49);
  console.log(
    'simple_select_ms',
    Date.now() - t0,
    simple.error?.message ?? `rows=${simple.data?.length}`,
  );

  const t1 = Date.now();
  const cnt = await v.from('voters').select('*', { count: 'exact', head: true });
  console.log(
    'count_ms',
    Date.now() - t1,
    cnt.error?.message ?? `count=${cnt.count}`,
  );

  // Probe RPC definition via a filtered search that used to be fast
  const t2 = Date.now();
  const rpc = await v.rpc('voter_search', {
    q: '',
    filters: { city: ['Boise'] },
    page: 1,
    page_size: 5,
  });
  console.log(
    'city_filter_ms',
    Date.now() - t2,
    rpc.error?.message ?? `rows=${rpc.data?.length} keys=${rpc.data?.[0] ? Object.keys(rpc.data[0]).join(',') : ''}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
