/**
 * Writes the API's OpenAPI document to a file, from the built app (`pnpm build`
 * first), without starting a server or connecting to the database:
 *
 *   pnpm --filter api openapi:document <out.json>
 *
 * CI regenerates packages/api-client from it and fails if the committed client
 * differs (PLAT-15, ADR-023). Run it with NODE_ENV unset or development: the
 * test-only routes (NODE_ENV=test) are not part of the client.
 */
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { API_GLOBAL_PREFIX, buildApiDocument } from '../dist/common/openapi/document.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: openapi-document.mjs <out.json>');
  process.exit(2);
}
if (process.env.NODE_ENV === 'test') {
  console.error('openapi-document: NODE_ENV=test adds test-only routes; unset it');
  process.exit(2);
}
// The same setup as main.ts that the document depends on: the global prefix.
const app = await NestFactory.create(AppModule, { logger: ['error'], bodyParser: false });
app.setGlobalPrefix(API_GLOBAL_PREFIX);
writeFileSync(out, `${JSON.stringify(buildApiDocument(app), null, 2)}\n`);
await app.close();
console.log(`wrote ${out}`);
