# Phase 29 — Database per tenant

**Reference:** [ADR-045](../decisions/ADR-045-database-per-tenant.md).
**Scope of this delivery:** 29A request-path routing, 29B tenant mirrors/provisioning, and 29C per-tenant jobs, backup/restore/purge, and platform-admin aggregation.

## Completed

- Shared mode remains the default; isolated mode routes tenant requests to per-tenant databases.
- Added the control-plane tenant database pool and create/pool provisioners. Tenant passwords are sealed at rest.
- Isolated sign-up is resumable after partial provisioning. Invitations synchronize the user mirror and membership across control and tenant databases, with compensation on failure.
- Added schema-version gating and `migrate-all`; operational commands include `db-pool-add`, `db-pool-fill`, `db-pool-status`, and `provision-resume`.
- Operational migration failures retain a bounded stdout/stderr tail after URL and credential redaction. Sign-up failures remain `REGISTRATION_PENDING` without exposing diagnostics to clients.
- Login synchronizes the user mirror only to the selected tenant; invitations use tenant-qualified membership IDs where needed.
- Isolated scheduled jobs run against tenant databases. Unavailable databases are reported without stopping healthy tenants.
- Isolated backups write V3 manifests with control and per-tenant dumps; tenant restore keeps the database in maintenance on failure.
- Tenant purge handles create and pool provisioners and supports safe resume after retirement.
- Platform-admin counts and companies are read from tenant databases; unavailable databases report null counts and a non-active database state.

## Schema and migrations

- `20261122172110_phase29a_tenant_databases` — control-plane `tenant_databases` and `user_tenants`.
- `20261123120000_phase29b_tenant_db_pool` — `tenant_db_pool`, including host, port, database name, DB user, sealed password, schema version, claim, and creation metadata.
- No tenant database is seeded independently; reference data uses the control database IDs and user mirrors store the unusable password hash `!`.

## API and operational commands

- Existing registration, invitation, acceptance, decline, and switch paths now work across isolated tenant databases. Shared-mode registration and invitations retain their existing behavior.
- Added CLI commands `db-pool-add`, `db-pool-fill`, `db-pool-status`, `migrate-all`, and `provision-resume`.
- In isolated deployments, deploy code, run `migrate-all`, then restart the API.
- No user-facing screens were added.

## Acceptance and verification

- [x] Provisioning E2E: **5/5 tests passed**, covering separate databases, isolated items, invitations, migration recovery, provisioning resume, and pool behavior.
- [x] Isolated-routing E2E: passed; maintenance gating and cross-tenant isolation exercised.
- [x] Auth, users, and invitation E2E suites passed, including tenant-qualified invitation acceptance.
- [x] Static isolation specs passed.
- [x] Full shared-mode API suite on fresh `erp_test_phase29b_full_1795377881`: **165 suites passed, 1 skipped; 1,906 tests passed, 7 skipped**. `erp_test` was not used.
- [x] API typecheck, lint, and build passed. Web typecheck, lint, build, and locale tests passed; no web source was changed in the final fixes.
- [x] Prisma generation, OpenAPI model generation, CLI `db-pool-status` from `dist`, and `git diff --check` passed.

## Phase 29C verification

- [x] `tenancy-jobs.e2e`: **7/7 tests passed**, covering stock fan-out/unavailable databases, expired locks in both databases, e-invoice worker claim/dispatch, tenant admin counts and status mirrors, V3 backup/verify/restore, and create/pool purge recovery. The e-invoice sender is stubbed in this suite.
- [x] `tenancy-isolated.e2e`: **1/1**; `tenancy-provisioning.e2e`: **5/5**.
- [x] Full API suite on fresh `erp_t_test29c_full_1795382218`: **168 suites passed, 1 skipped; 1,926 tests passed, 7 skipped**.
- [x] Changed API unit suites: **6 suites, 59 tests**; static isolation guard: **7/7**.
- [x] API typecheck, lint, and build passed. Web typecheck, lint, build, and locale spec passed. OpenAPI was generated from the built API and the API client regenerated.
- [x] Built `dist/jobs/cli.js db-pool-status` resolved the schema version from `dist` in the isolated jobs E2E. `git diff --check` passed before delivery.

## Known limits and next phase

- `DB_PROVISIONER=create` requires an administrator URL with database/user/grant privileges; `pool` mode requires owner-added databases.
- Tenant-facing audit-log reads are not present; control fallback audit rows remain in control and are documented for any future merged read.
