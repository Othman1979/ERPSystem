import { defineConfig, type InputTransformerFn } from 'orval';

/** The file types the API sends (PDF printouts, xlsx exports, the zip export). */
const FILE_TYPES = ['application/pdf', 'application/zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

/**
 * Report routes answer JSON, or a file with ?format=pdf|xlsx. A generated call
 * parses JSON (apiFetch), and files are fetched with apiFetchBlob, so where a
 * response has both, the client types the JSON one only. A file-only response
 * (a printout, the export) keeps its binary type, so its function says Blob.
 * The OpenAPI document itself is left as the API publishes it.
 */
const jsonWhereBoth: InputTransformerFn = (spec) => {
  for (const item of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(item ?? {})) {
      const responses = (operation as { responses?: Record<string, { content?: Record<string, unknown> }> } | undefined)?.responses;
      for (const response of Object.values(responses ?? {})) {
        const content = response.content;
        if (content?.['application/json']) for (const type of FILE_TYPES) delete content[type];
      }
    }
  }
  return spec;
};

// Generates the typed API client from the API's OpenAPI document.
// Default input: the dev API (`pnpm --filter api dev`) on port 3001. Set
// OPENAPI_INPUT to another URL or to a saved JSON file to generate from that.
export default defineConfig({
  erp: {
    input: {
      target: process.env.OPENAPI_INPUT ?? 'http://localhost:3001/api/docs-json',
      override: { transformer: jsonWhereBoth },
    },
    output: {
      target: './src/generated/api.ts',
      client: 'fetch',
      override: {
        // apiFetch throws ApiError on any non-2xx answer, so a call resolves only
        // with a success response; the error envelope is documented, not returned.
        fetch: { forceSuccessResponse: true },
        mutator: {
          path: './src/runtime.ts',
          name: 'apiFetch',
        },
      },
    },
  },
});
