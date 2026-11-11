// Runs the built API serving the built web app on one origin, as in
// production (ADR-010 §2), for a local check before deploying:
//   pnpm --filter web build && pnpm --filter api build && pnpm --filter api start:web
// Variables already set (or in .env for the others) win over these defaults;
// an empty one (NAME=) counts as unset, as in the API's own validation.
import path from 'node:path';

const here = import.meta.dirname;
process.env.WEB_DIST_DIR ||= path.resolve(here, '..', '..', 'web', 'dist');
process.env.API_PORT ||= '3002';

await import('../dist/main.js');
