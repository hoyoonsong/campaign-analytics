/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CAMPAIGN_SUPABASE_URL: string;
  readonly VITE_CAMPAIGN_SUPABASE_ANON_KEY: string;
  readonly VITE_PORTAL_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
