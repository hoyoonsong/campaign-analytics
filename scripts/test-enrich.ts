import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { enrichSearchRows } from '../api/_lib/enrichSearch';

dotenv.config({ path: '.env.local' });

const v = createClient(
  process.env.VOTER_SUPABASE_URL!,
  process.env.VOTER_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data, error } = await v.rpc('voter_search', {
    filters: {},
    q: '',
    page: 1,
    page_size: 10,
  });
  if (error) throw error;
  const rows = (data as { rows: Array<Record<string, unknown>> }).rows;
  const enriched = await enrichSearchRows(v, rows);
  for (const r of enriched) {
    console.log({
      name: `${r.first_name} ${r.last_name}`,
      tag: r.supporter_tag,
      yard: r.nearby_yard_sign_miles,
      vol: r.nearby_volunteer_miles,
      lat: r.lat,
    });
  }

  // Someone who should be a supporter
  const { data: ys } = await v
    .from('voters')
    .select(
      'id,first_name,last_name,yard_sign,alignment_label,support_score,lat,lng,supporter_tag',
    )
    .or('yard_sign.ilike.yes,yard_sign.ilike.delivered,alignment_label.ilike.positive')
    .not('lat', 'is', null)
    .limit(5);
  const tagged = await enrichSearchRows(v, (ys ?? []) as Array<Record<string, unknown>>);
  console.log('--- expected supporters ---');
  for (const r of tagged) {
    console.log({
      name: `${r.first_name} ${r.last_name}`,
      tag: r.supporter_tag,
      yard_sign: r.yard_sign,
      alignment: r.alignment_label,
      yard_mi: r.nearby_yard_sign_miles,
      vol_mi: r.nearby_volunteer_miles,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
