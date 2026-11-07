import { defineConfig } from 'orval';

// Generates typed API client from the running API's OpenAPI spec.
// Requires `pnpm --filter api dev` (or a deployed API) before running `pnpm api-client:generate`.
export default defineConfig({
  erp: {
    input: {
      target: 'http://localhost:3001/api/docs-json',
    },
    output: {
      target: './src/generated/api.ts',
      client: 'fetch',
      override: {
        mutator: {
          path: './src/runtime.ts',
          name: 'apiFetch',
        },
      },
    },
  },
});
