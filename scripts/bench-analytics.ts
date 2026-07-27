import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const v = createClient(
  process.env.VOTER_SUPABASE_URL!,
  process.env.VOTER_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const t0 = Date.now();
const { data, error } = await v.rpc('voter_analytics_summary', { filters: {} });
const payload = data as { total?: number; with_coords?: number } | null;
console.log(
  JSON.stringify({
    ms: Date.now() - t0,
    err: error?.message ?? null,
    total: payload?.total,
    with_coords: payload?.with_coords,
  }),
);
