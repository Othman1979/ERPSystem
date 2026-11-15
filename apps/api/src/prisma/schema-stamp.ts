import { createHash } from 'node:crypto';

/**
 * The stamp `prisma:generate` (scripts/prisma-stamp.mjs) writes next to the
 * generated client: the sha256 of prisma/schema.prisma it was generated from.
 * The build copies it into dist (nest-cli.json assets), and preflight compares
 * it with the schema on disk: a client generated from an older schema (the
 * generated folder is git-ignored, so `git pull` never refreshes it) fails there.
 */
export const SCHEMA_STAMP_FILE = 'schema.sha256';

/**
 * sha256 of the schema text with line endings normalised, so a Windows
 * checkout (CRLF) and the server (LF) agree. scripts/prisma-stamp.mjs
 * computes the same (schema-stamp.spec.ts runs it).
 */
export function schemaHash(schema: string): string {
  return createHash('sha256').update(schema.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}
