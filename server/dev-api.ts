/**
 * Optional standalone API (port 3001). Prefer `npm run dev` — Vite serves
 * /api itself via middleware, so this is usually unnecessary.
 */
import { createLocalApiApp, loadEnv } from './local-api';

loadEnv();

const PORT = Number(process.env.DEV_API_PORT || 3001);
const app = createLocalApiApp();

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[dev-api] listening on http://127.0.0.1:${PORT} (optional; Vite embeds /api)`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `[dev-api] Port ${PORT} is already in use.\n` +
        `  You usually do not need this process — run only \`npm run dev\`.\n` +
        `  To free the port: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.error('[dev-api] listen failed:', err);
  }
  process.exit(1);
});
