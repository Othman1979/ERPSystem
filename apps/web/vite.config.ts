import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { precompress } from './vite-precompress.js';

export default defineConfig({
  plugins: [react(), precompress()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // The framework every screen needs is one vendor chunk whose hash
          // survives app releases, so returning users re-download only app code.
          // antd is left to automatic splitting on purpose: one antd chunk put
          // every component any page uses (tables, date pickers…) on the sign-in
          // screen's critical path, 1.8 MB instead of 1.4 MB (WEB-10). Its
          // automatic chunks are content-hashed, so they change only when the
          // components they hold do. No catch-all node_modules group either:
          // page-only libraries (jsbarcode) stay in their page's chunk.
          // Matching the last `node_modules/<name>/` segment works for pnpm paths
          // and for both path separators.
          groups: [
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack|i18next|react-i18next)[\\/]/,
              priority: 2,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Pass the browser's address on, as a production proxy does (ADR-011).
        xfwd: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
  },
});
