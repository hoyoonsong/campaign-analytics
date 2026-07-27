import type { Plugin } from 'vite';
import { createLocalApiApp } from './server/local-api';
import { pathToFileURL } from 'node:url';

/** Serve /api from the same Vite process — no second terminal / proxy. */
export function localApiPlugin(): Plugin {
  return {
    name: 'campaign-local-api',
    configureServer(server) {
      const app = createLocalApiApp({
        loadModule: async (absolutePath) => {
          // Vite transforms TypeScript API handlers for Node.
          const url = `${pathToFileURL(absolutePath).href}?t=${Date.now()}`;
          return server.ssrLoadModule(url) as Promise<{
            default: (
              req: unknown,
              res: unknown,
            ) => unknown | Promise<unknown>;
          }>;
        },
      });
      server.middlewares.use(app);
      // eslint-disable-next-line no-console
      console.log('[vite] /api handlers mounted in-process (no :3001 proxy needed)');
    },
  };
}
