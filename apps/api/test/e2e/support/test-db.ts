/**
 * The e2e test database: the same server and credentials as DATABASE_URL, a separate schema.
 * Default `erp_test`; set E2E_DB_NAME to run against another local schema (for example a
 * private copy when the shared erp_test is busy). See docs/runbooks/testing.md.
 */
const name = process.env.E2E_DB_NAME?.trim() || 'erp_test';
// The name is spliced into URLs and SQL text, so only plain identifiers are accepted.
if (!/^[A-Za-z0-9_]+$/.test(name)) {
  throw new Error(`E2E_DB_NAME must be letters, digits or "_" (got "${name}")`);
}

export const TEST_DB_NAME = name;

/** `source` (default DATABASE_URL) with its database path replaced by the test schema. */
export function testDatabaseUrl(source: string = process.env.DATABASE_URL ?? ''): string {
  if (!source) throw new Error('DATABASE_URL is not set (apps/api/.env)');
  return source.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB_NAME}$1`);
}
