# Testing notes

## API e2e suites (`apps/api/test/e2e`)

Each suite spawns the **built** API (`node dist/main.js`) on its own port against a real MariaDB,
so run `pnpm --filter api build` first.

### Which database

The suites use the same server and credentials as `DATABASE_URL` in `apps/api/.env`, but a
separate schema:

| Variable      | Default    | Meaning                                                   |
| ------------- | ---------- | --------------------------------------------------------- |
| `E2E_DB_NAME` | `erp_test` | Schema the e2e suites, their spawned API and jobs connect to |

The rule lives in `apps/api/test/e2e/support/test-db.ts` (`TEST_DB_NAME`, `testDatabaseUrl()`);
new suites import it instead of writing the name. The name must be letters, digits or `_`,
and must contain `test`: `E2E_DB_NAME=erp_dev` is refused, since the suites purge tenants and run
cross-tenant jobs.

A private schema helps when the shared `erp_test` is busy (several sessions, perf data of
hundreds of thousands of rows): counts in shared tables and slow lists stop leaking between runs.

```bash
# once: create, migrate and seed the schema (PowerShell: set the variables with $env:...)
cd apps/api
E2E_DB_NAME=erp_test_mine npx tsx scripts/mkdb.mts
DATABASE_URL="mysql://user:pass@localhost:3306/erp_test_mine" npx prisma migrate deploy
DATABASE_URL="mysql://user:pass@localhost:3306/erp_test_mine" npx prisma db seed

# every run
E2E_DB_NAME=erp_test_mine node --experimental-vm-modules ./node_modules/jest/bin/jest.js test/e2e/phase6.e2e.spec.ts
```

After a new migration lands, run `prisma migrate deploy` against your schema again.

### Running only what changed

Run the spec files that cover the change (`jest <file> [-t <name>]`), not the whole suite;
the full run is for shared infrastructure changes. On a nearly full `C:` drive point `TMP`,
`TEMP` and the jest cache (`--cacheDirectory`) at another drive.

`OPENAPI_RESPONSE_AUDIT=<file>` makes the spawned API compare every 2xx response with its
declared schema and append one line per mismatch to `<file>` (ADR-023); the file must stay empty.

## Web (`apps/web`)

Vitest, config in `apps/web/vite.config.ts`:

```bash
pnpm --filter web exec vitest run src/pages/purchases/returnPayload.spec.ts
```
