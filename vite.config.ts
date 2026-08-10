import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { localApiPlugin } from './vite-plugin-local-api';

export default defineConfig({
  plugins: [react(), localApiPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5177,
    strictPort: true,
  },
  preview: {
    port: 5177,
    strictPort: true,
  },
});
