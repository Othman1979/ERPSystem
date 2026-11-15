// Runs after `prisma generate` (postinstall and `pnpm prisma:generate`): writes the
// sha256 of prisma/schema.prisma into the generated client folder, so preflight can
// tell a client generated from an older schema (src/prisma/schema-stamp.ts). Plain
// node, no dependencies: it runs in every install.
//   node scripts/prisma-stamp.mjs [schema file] [generated folder]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const api = path.resolve(import.meta.dirname, '..');
const schemaFile = path.resolve(process.argv[2] ?? path.join(api, 'prisma', 'schema.prisma'));
const outDir = path.resolve(process.argv[3] ?? path.join(api, 'src', 'generated', 'prisma'));

// The same as schemaHash() in src/prisma/schema-stamp.ts: line endings normalised.
const schema = readFileSync(schemaFile, 'utf8').replace(/\r\n/g, '\n');
const hash = createHash('sha256').update(schema, 'utf8').digest('hex');
writeFileSync(path.join(outDir, 'schema.sha256'), `${hash}\n`);
console.log(`prisma-stamp: ${hash.slice(0, 12)} written to ${path.relative(api, outDir) || '.'}`);
