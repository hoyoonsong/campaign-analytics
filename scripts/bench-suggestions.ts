import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { computeYardSignSuggestions } from '../api/_lib/yardSignSuggestions';

dotenv.config({ path: '.env.local' });

const v = createClient(
  process.env.VOTER_SUPABASE_URL!,
  process.env.VOTER_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const t0 = Date.now();
const result = await computeYardSignSuggestions(v, {
  county: ['ADA'],
  radius_miles: 0.5,
  max_suggestions: 40,
});
console.log(
  JSON.stringify({
    ms: Date.now() - t0,
    ...result,
    suggestions: result.suggestions.slice(0, 3),
    suggestion_count: result.suggestions.length,
  }),
);
