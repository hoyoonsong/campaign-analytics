import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const c = createClient(
  process.env.CAMPAIGN_SUPABASE_URL!,
  process.env.CAMPAIGN_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const ys = await c
  .from('yard_signs')
  .select(
    'id,name,person_id,email,phone,address,lat,lng,status,quantity,is_big',
  )
  .not('lat', 'is', null)
  .limit(2);
const vol = await c
  .from('volunteers')
  .select('id,name,person_id,email,phone,address,city,zip,lat,lng')
  .not('lat', 'is', null)
  .limit(2);
console.log('yard', ys.error?.message ?? ys.data);
console.log('vol', vol.error?.message ?? vol.data);

if (ys.data?.[0]?.person_id) {
  const p = await c
    .from('people')
    .select('id,full_name,first_name,last_name,email,phone')
    .eq('id', ys.data[0].person_id)
    .maybeSingle();
  console.log('people', p.error?.message ?? p.data);
}
