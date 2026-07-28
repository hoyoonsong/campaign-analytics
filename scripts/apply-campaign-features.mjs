/**
 * Apply campaign migrations (0015–0018) to the voter Supabase project.
 *
 * Usage:
 *   SUPABASE_DB_PASSWORD='your-db-password' node scripts/apply-campaign-features.mjs
 *
 * Password: Supabase Dashboard → Project Settings → Database → Database password
 * Project ref: tnwsjmavwceciovixeey (from VOTER_SUPABASE_URL)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(root, '.env.local') });

const password = process.env.SUPABASE_DB_PASSWORD || process.env.VOTER_DB_PASSWORD;
const ref =
  process.env.VOTER_PROJECT_REF ||
  (process.env.VOTER_SUPABASE_URL || '').match(/https:\/\/([^.]+)\./)?.[1];

if (!password) {
  console.error('Missing SUPABASE_DB_PASSWORD (voter project database password).');
  process.exit(1);
}
if (!ref) {
  console.error('Could not determine project ref from VOTER_SUPABASE_URL.');
  process.exit(1);
}

const files = [
  'supabase/migrations/0015_campaign_lean_indexes.sql',
  'supabase/migrations/0016_any_of_filters.sql',
  'supabase/migrations/0017_fix_search_timeout.sql',
  'supabase/migrations/0018_fix_analytics_timeout.sql',
  'supabase/migrations/0019_pii_import_without_ids.sql',
  'supabase/migrations/0020_import_perf_delete_tags.sql',
  'supabase/migrations/0021_fix_import_voter_id_and_geo.sql',
  'supabase/migrations/0022_fast_supporter_tags.sql',
  'supabase/migrations/0023_fix_replace_campaign_geo.sql',
  'supabase/migrations/0024_undo_import_map_state_range.sql',
  'supabase/migrations/0025_nearby_blank_max_statewide.sql',
  'supabase/migrations/0026_exclude_state.sql',
  'supabase/migrations/0027_blank_state_avg_nearby.sql',
  'supabase/migrations/0028_fix_analytics_avg_nearby.sql',
  'supabase/migrations/0029_supporter_tags_formhandler_analytics.sql',
  'supabase/migrations/0030_presence_cache.sql',
  'supabase/migrations/0031_analytics_cache_geo_contacts.sql',
  'supabase/migrations/0032_search_speed.sql',
  'supabase/migrations/0033_exclude_supporter_tag.sql',
  'supabase/migrations/0034_petition_venn.sql',
];

const sql = files
  .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
  .join('\n\n');

const connectionString = `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-1-us-west-2.pooler.supabase.com:6543/postgres`;

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
console.log('Connected. Applying 0015–0032…');
try {
  await client.query(sql);
  console.log('OK — campaign features through 0032 applied.');
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
