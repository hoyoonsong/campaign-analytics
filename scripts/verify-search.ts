import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const v = createClient(
  process.env.VOTER_SUPABASE_URL!,
  process.env.VOTER_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const cases: Record<string, unknown>[] = [
  {},
  { city: ['Boise'] },
  { any_of: [{ field: 'yard_sign', values: ['yes', 'delivered'] }] },
];

for (const filters of cases) {
  const t0 = Date.now();
  const { data, error } = await v.rpc('voter_search', {
    filters,
    q: '',
    page: 1,
    page_size: 50,
  });
  const payload = data as { total?: number; rows?: unknown[] } | null;
  console.log(
    JSON.stringify({
      filters,
      ms: Date.now() - t0,
      err: error?.message ?? null,
      total: payload?.total,
      rows: payload?.rows?.length,
    }),
  );
}
