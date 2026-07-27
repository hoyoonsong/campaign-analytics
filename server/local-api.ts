/**
 * Local API for Vite middleware and optional standalone `dev:api`.
 * Same handlers as Vercel `/api/*` — no separate proxy port required when
 * mounted inside Vite.
 */
import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Request, Response, Express, NextFunction } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..');

export function loadEnv() {
  dotenv.config({ path: path.join(projectRoot, '.env.local') });
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

type VercelHandler = (req: Request, res: Response) => unknown | Promise<unknown>;

export type ModuleLoader = (absolutePath: string) => Promise<{ default: VercelHandler }>;

async function defaultLoadModule(absolutePath: string) {
  // Works under `tsx` (npm run dev:api). Vite uses ssrLoadModule instead.
  const mod = await import(`${pathToFileURL(absolutePath).href}?t=${Date.now()}`);
  return mod as { default: VercelHandler };
}

function wrap(load: () => Promise<VercelHandler>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const handler = await load();
      await handler(req, res);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[local-api]', req.method, req.path, err);
      if (!res.headersSent) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Server error',
        });
      } else {
        next(err);
      }
    }
  };
}

const ROUTES: [string, string][] = [
  ['/api/voter/analytics', 'voter/analytics.ts'],
  ['/api/voter/search', 'voter/search.ts'],
  ['/api/voter/export', 'voter/export.ts'],
  ['/api/voter/import', 'voter/import.ts'],
  ['/api/voter/import-batches', 'voter/import-batches.ts'],
  ['/api/voter/undo-import', 'voter/undo-import.ts'],
  ['/api/voter/delete', 'voter/delete.ts'],
  ['/api/voter/usage', 'voter/usage.ts'],
  ['/api/voter/filter-options', 'voter/filter-options.ts'],
  ['/api/voter/map-points', 'voter/map-points.ts'],
  ['/api/voter/universes', 'voter/universes.ts'],
  ['/api/voter/profile', 'voter/profile.ts'],
  ['/api/voter/nearby', 'voter/nearby.ts'],
  ['/api/voter/yard-sign-suggestions', 'voter/yard-sign-suggestions.ts'],
  ['/api/voter/activity', 'voter/activity.ts'],
  ['/api/voter/sync-campaign', 'voter/sync-campaign.ts'],
];

/** Express app with /api routes — mount in Vite or listen standalone. */
export function createLocalApiApp(opts?: { loadModule?: ModuleLoader }): Express {
  loadEnv();
  const loadModule = opts?.loadModule ?? defaultLoadModule;
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      voter: Boolean(process.env.VOTER_SUPABASE_URL),
      campaign: Boolean(process.env.CAMPAIGN_SUPABASE_URL),
    });
  });

  for (const [route, file] of ROUTES) {
    const abs = path.join(projectRoot, 'api', file);
    app.all(
      route,
      wrap(async () => {
        const mod = await loadModule(abs);
        return mod.default;
      }),
    );
  }

  return app;
}
