/**
 * Apply campaign migrations to the voter Supabase project, one file at a time.
 *
 * Usage:
 *   SUPABASE_DB_PASSWORD='your-db-password' node scripts/apply-campaign-features.mjs
 *   APPLY_FROM=0039 node scripts/apply-campaign-features.mjs
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
dotenv.config({
  path: path.resolve(root, '../CampaignFormHandler/.env.local'),
});

const password = process.env.SUPABASE_DB_PASSWORD || process.env.VOTER_DB_PASSWORD;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const ref =
  process.env.VOTER_PROJECT_REF ||
  (process.env.VOTER_SUPABASE_URL || '').match(/https:\/\/([^.]+)\./)?.[1];

if (!ref) {
  console.error('Could not determine project ref from VOTER_SUPABASE_URL.');
  process.exit(1);
}
if (!password && !accessToken) {
  console.error(
    'Missing SUPABASE_DB_PASSWORD (or SUPABASE_ACCESS_TOKEN for Management API).',
  );
  process.exit(1);
}

const allFiles = [
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
  'supabase/migrations/0035_filter_options_idaho_cities.sql',
  'supabase/migrations/0036_fix_lean_sync_safeupdate.sql',
  'supabase/migrations/0037_fix_export_timeout.sql',
  'supabase/migrations/0038_map_geo_sample.sql',
  'supabase/migrations/0039_petition_registry.sql',
  'supabase/migrations/0040_petition_dynamic_rpcs.sql',
  'supabase/migrations/0041_import_signatures.sql',
  'supabase/migrations/0042_analytics_speed.sql',
  'supabase/migrations/0043_possible_duplicates.sql',
  'supabase/migrations/0044_map_and_analytics_fast.sql',
  'supabase/migrations/0045_petition_groups_delete.sql',
  'supabase/migrations/0046_delete_petition_no_replica.sql',
];

const applyFrom = process.env.APPLY_FROM || process.argv[2] || '0015';
const files = allFiles.filter((f) => path.basename(f).slice(0, 4) >= applyFrom);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  const code = err?.code;
  const msg = String(err?.message || '');
  return (
    code === '40P01' || // deadlock
    code === '55P03' || // lock_timeout
    code === '40001' || // serialization_failure
    /deadlock detected/i.test(msg) ||
    /canceling statement due to lock timeout/i.test(msg) ||
    /524: A timeout occurred/i.test(msg) ||
    /Error code 524/i.test(msg)
  );
}

function connectionConfigs() {
  const encoded = encodeURIComponent(password);
  return [
    {
      label: 'session-pooler :5432',
      connectionString: `postgresql://postgres.${ref}:${encoded}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
    },
    {
      label: 'direct :5432',
      connectionString: `postgresql://postgres:${encoded}@db.${ref}.supabase.co:5432/postgres`,
    },
    {
      label: 'transaction-pooler :6543',
      connectionString: `postgresql://postgres.${ref}:${encoded}@aws-1-us-west-2.pooler.supabase.com:6543/postgres`,
    },
  ];
}

async function connectPg() {
  let lastErr;
  for (const cfg of connectionConfigs()) {
    const client = new pg.Client({
      connectionString: cfg.connectionString,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 300_000,
    });
    try {
      await client.connect();
      console.log(`Connected via ${cfg.label}`);
      return client;
    } catch (err) {
      lastErr = err;
      console.warn(`Could not connect via ${cfg.label}: ${err.message}`);
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }
  throw lastErr ?? new Error('No database connection configs succeeded');
}

function errorFromBody(body, httpStatus) {
  let msg =
    body?.message ||
    body?.error?.message ||
    body?.error ||
    (typeof body === 'string' ? body : JSON.stringify(body));
  msg = String(msg || `HTTP ${httpStatus}`);
  if (/524: A timeout occurred/i.test(msg) || httpStatus === 524) {
    msg = '524: A timeout occurred';
  } else if (msg.length > 500) {
    msg = msg.slice(0, 500);
  }
  const err = new Error(msg);
  err.code = body?.code || body?.error_code || (httpStatus === 524 ? '524' : undefined);
  err.httpStatus = httpStatus;
  return err;
}

async function runManagementSql(sql) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw errorFromBody(body, res.status);
  }
  return body;
}

async function applySqlWithRetry(name, sql, run, retries = 10) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await run(sql);
      console.log(`OK  ${name}`);
      return;
    } catch (err) {
      if (isRetryable(err) && attempt < retries) {
        const wait = 2000 * attempt + Math.floor(Math.random() * 1000);
        console.warn(
          `RETRY ${name} (${attempt}/${retries}) ${err.code || ''} ${err.message} — waiting ${wait}ms`,
        );
        await sleep(wait);
        continue;
      }
      console.error(`FAILED ${name}:`, err.message);
      throw err;
    }
  }
}

async function applyViaPg() {
  const client = await connectPg();
  const run = async (sql) => {
    await client.query('BEGIN');
    try {
      await client.query("set local lock_timeout = '15s'");
      await client.query("set local deadlock_timeout = '1s'");
      await client.query("set local statement_timeout = '300s'");
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  };
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(root, file), 'utf8');
      await applySqlWithRetry(path.basename(file), sql, run);
    }
    if (files.some((f) => f.includes('0040') || f.includes('0042'))) {
      console.log('Refreshing presence cache…');
      await client.query("set statement_timeout = '300s'");
      await client.query('select public.refresh_presence_cache()');
      console.log('OK  refresh_presence_cache()');
    }
  } finally {
    await client.end();
  }
}

async function applyViaManagementApi() {
  console.log(`Connected via Management API (${ref})`);
  for (const file of files) {
    const sql = fs.readFileSync(path.join(root, file), 'utf8');
    await applySqlWithRetry(path.basename(file), sql, runManagementSql);
  }
  if (files.some((f) => f.includes('0040') || f.includes('0042'))) {
    console.log('Refreshing presence cache…');
    await applySqlWithRetry(
      'refresh_presence_cache()',
      'select public.refresh_presence_cache()',
      runManagementSql,
    );
  }
}

console.log(`Applying ${files.length} migration(s) from ${applyFrom}…`);
try {
  if (password) {
    await applyViaPg();
  } else {
    await applyViaManagementApi();
  }
  console.log(`Done — applied through ${path.basename(files.at(-1))}.`);
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
}
