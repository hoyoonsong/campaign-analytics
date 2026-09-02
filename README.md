# Voter Analytics

Separate module for voter data analytics. Reuses **campaign portal authentication** (same Supabase Auth project as `campaign-form-handler`) and stores all voter data in a **dedicated Supabase project**.

## Architecture

```text
Browser (this app)
  ├── Campaign Supabase  →  Auth session + profiles only
  └── /api/voter/* (Vercel)
          ├── validates campaign JWT + profiles row
          └── Voter Supabase (service role) → voters, RPCs, universes
```

- Same campaign Auth credentials (Google or email/password). Optional portal `return_to` handoff once the portal is deployed with that support.
- In Supabase Auth → URL configuration, allow redirect URLs like `http://localhost:5177/auth/bridge` and your production analytics `/auth/bridge`.
- Voter service-role key never appears in frontend env (`VITE_*`).

## Setup

### 1. Create a voter Supabase project

In the [Supabase dashboard](https://supabase.com/dashboard), create a **new** project (do not reuse the campaign DB).

Apply migrations from this repo:

```bash
npx supabase link --project-ref <VOTER_PROJECT_REF>
npx supabase db push
```

Migrations live in [`supabase/migrations/`](supabase/migrations/).

### 2. Configure the campaign portal handoff

In `CampaignFormHandler`, set:

```bash
VITE_ANALYTICS_URL=https://your-analytics-host.vercel.app
```

Localhost origins are allowlisted automatically. After login (password or Google), the portal redirects to `{analytics}/auth/bridge#access_token=…&refresh_token=…`.

### 3. Configure this app

```bash
cp .env.example .env.local
# Fill VITE_CAMPAIGN_*
```

On Vercel, also set **server** env vars (not `VITE_`):

| Variable | Purpose |
|----------|---------|
| `CAMPAIGN_SUPABASE_URL` | Campaign project URL |
| `CAMPAIGN_SUPABASE_ANON_KEY` | Validate user JWTs |
| `CAMPAIGN_SUPABASE_SERVICE_ROLE_KEY` | Optional profile lookup |
| `VOTER_SUPABASE_URL` | Voter project URL |
| `VOTER_SUPABASE_SERVICE_ROLE_KEY` | Privileged voter DB access |

### 4. Run locally

```bash
npm install
npm run dev          # Vite serves UI + /api in one process
```

`npm run dev` loads `.env.local` and mounts API handlers inside Vite (no separate `:3001` process). Check `/api/health` on the same port as the UI if requests fail. Optional: `npm run dev:api` still starts a standalone API for debugging.

### 5. Deploy

Deploy this repo to Vercel. Ensure SPA rewrites exclude `/api/*` (see `vercel.json`).

Add the production analytics URL to the portal’s `VITE_ANALYTICS_URL` and redeploy the portal.

## Features

| Route | Description |
|-------|-------------|
| `/` | Analytics dashboard (SQL aggregates) |
| `/search` | Paginated search + CSV export |
| `/import` | CSV map → preview → batched upsert on `voter_id` |
| `/universes` | Saved filter definitions (JSON, not voter copies) |
| `/usage` | Table / index / DB size stats |

Access: any authenticated campaign user with a `profiles` row.

## Important

- Do **not** put voter rows in the campaign Supabase database.
- Do **not** expose `VOTER_SUPABASE_SERVICE_ROLE_KEY` to the browser.
- Rows without `voter_id` are skipped on import (never silently duplicated by name).
