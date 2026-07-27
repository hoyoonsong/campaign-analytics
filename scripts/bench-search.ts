import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const v = createClient(
    process.env.VOTER_SUPABASE_URL!,
    process.env.VOTER_SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  for (const filters of [{}, { any_of: [{ field: 'alignment_label', values: ['Positive'] }] }]) {
    const t0 = Date.now();
    const r = await v.rpc('voter_search', {
      filters,
      q: '',
      page: 1,
      page_size: 50,
    });
    console.log(JSON.stringify({
      filters,
      ms: Date.now() - t0,
      err: r.error?.message ?? null,
      total: r.data?.total,
      keys: r.data?.rows?.[0] ? Object.keys(r.data.rows[0]) : [],
    }));
  }
}

void main();
