import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '../generated/prisma/client.js';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../prisma/migrations');
let cachedExpectedVersion: string | undefined;

export function lastMigrationName(directory: string): string {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const latest = names.at(-1);
  if (!latest) throw new Error(`No Prisma migrations found in ${directory}`);
  return latest;
}

export function expectedSchemaVersion(): string {
  cachedExpectedVersion ??= lastMigrationName(MIGRATIONS_DIR);
  return cachedExpectedVersion;
}

export function isSchemaBehind(version: string | null, expected = expectedSchemaVersion()): boolean {
  return version === null || version < expected;
}

export async function readSchemaVersion(client: Pick<PrismaClient, '$queryRaw'>): Promise<string | null> {
  const rows = (await client.$queryRaw`
    SELECT MAX(migration_name) AS migrationName
    FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `) as Array<{ migrationName: string | null }>;
  return rows[0]?.migrationName ?? null;
}
