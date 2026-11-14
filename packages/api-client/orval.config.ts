import { defineConfig } from 'orval';

// Generates the typed API client from the API's OpenAPI document.
// Default input: the dev API (`pnpm --filter api dev`) on port 3001. Set
// OPENAPI_INPUT to another URL or to a saved JSON file to generate from that.
export default defineConfig({
  erp: {
    input: {
      target: process.env.OPENAPI_INPUT ?? 'http://localhost:3001/api/docs-json',
    },
    output: {
      target: './src/generated/api.ts',
      client: 'fetch',
      override: {
        // apiFetch throws ApiError on any non-2xx answer, so a call resolves only
        // with a success response; the error envelope is documented, not returned.
        fetch: { forceSuccessResponse: true },
        // Report routes answer JSON, or a file with ?format=pdf|xlsx. Files are fetched
        // with apiFetchBlob, so the generated functions type the JSON answer only
        // (the OpenAPI document still declares the file types).
        contentType: {
          exclude: ['application/pdf', 'application/zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        },
        mutator: {
          path: './src/runtime.ts',
          name: 'apiFetch',
        },
      },
    },
  },
});
