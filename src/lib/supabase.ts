import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_CAMPAIGN_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_CAMPAIGN_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.error(
    'Missing VITE_CAMPAIGN_SUPABASE_URL or VITE_CAMPAIGN_SUPABASE_ANON_KEY. Copy .env.example to .env.local.',
  );
}

/** Campaign Supabase client — auth + profiles only. Never points at the voter project. */
export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Needed when Google OAuth returns directly to /auth/bridge.
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});

/** Live FormHandler — never localhost, even if an old env var is set. */
export const PORTAL_URL = 'https://forms.achillesforidaho.com';
export const PORTAL_DASHBOARD_URL = `${PORTAL_URL}/dashboard`;
