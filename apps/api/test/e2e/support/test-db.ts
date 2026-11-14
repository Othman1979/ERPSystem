/**
 * The e2e test database: the same server and credentials as DATABASE_URL, a separate schema.
 * Default `erp_test`; set E2E_DB_NAME to run against another local schema (for example a
 * private copy when the shared erp_test is busy). See docs/runbooks/testing.md.
 */

/**
 * The test schema's name, checked: letters, digits or "_" (it is spliced into URLs and SQL
 * text), and it must contain "test". The suites purge tenants and run cross-tenant jobs, so a
 * slip such as E2E_DB_NAME=erp_dev must stop here rather than run them on a real schema.
 */
export function testDbName(raw: string | undefined = process.env.E2E_DB_NAME): string {
  const name = raw?.trim() || 'erp_test';
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`E2E_DB_NAME must be letters, digits or "_" (got "${name}")`);
  }
  if (!/test/i.test(name)) {
    throw new Error(`E2E_DB_NAME must name a test schema: its name must contain "test" (got "${name}")`);
  }
  return name;
}

export const TEST_DB_NAME = testDbName();

/** `source` (default DATABASE_URL) with its database path replaced by the test schema. */
export function testDatabaseUrl(source: string = process.env.DATABASE_URL ?? ''): string {
  if (!source) throw new Error('DATABASE_URL is not set (apps/api/.env)');
  return source.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB_NAME}$1`);
}
