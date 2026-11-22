# ADR-045: Database per tenant (physical isolation)

**Status:** accepted (owner, 2026-11-22)

## Context

Today every tenant shares one MariaDB database (BUILD_PLAN §5.1: shared database, shared schema,
`tenant_id`). Isolation is logical: `tenantScopedPrisma`, composite foreign keys
`[tenantId, …]`, `tenant_id` in 234 raw queries, and isolation e2e tests. The schema has 107
models, 100 of them with `tenant_id`.

The owner wants physical isolation between subscribers:
- each tenant, new and existing, gets its own database;
- the companies of one tenant stay together in that database, separated by `company_id` as today
  (ADR-040);
- the design runs on both Hostinger Cloud and a VPS.

Hostinger Cloud limits (official limits page, plan v6):
- 300 databases;
- 500 MySQL connections globally, and 100–175 per database user;
- databases are created in hPanel, with one user per database. An API to create databases is
  documented only for the Agency plan.

## Decision

### 1. One schema, two roles

Every database uses the **same Prisma schema and the same migration history**: one generated
client and one `prisma migrate deploy` per database. Each database plays one of two roles:

- **Control database** (`DATABASE_URL`) is authoritative for:
  - users (with `password_hash`) and refresh tokens;
  - tenants, plans and subscriptions;
  - platform admin, the error console (`error_events`), and global reference data;
  - two new tables:
    - `tenant_databases`: tenant → host, database, user, encrypted password, `schema_version`,
      `state` (`PROVISIONING`, `ACTIVE`, `MIGRATING`, `MOVING`, `RETIRED`);
    - `user_tenants`: user → tenant index, used at login and for the tenant switcher.
- **Tenant database** (one per tenant) is authoritative for everything that carries `tenant_id`:
  - companies and branches;
  - memberships, with their branches, companies and permissions;
  - roles, documents, ledgers, stock, payroll;
  - audit, attachments metadata, idempotency keys, locks.
- **Mirror rows inside each tenant database** keep every existing FK valid:
  - the tenant's own `tenants` row;
  - the `users` rows of its members, with `password_hash` set to an unusable marker and never
    read;
  - the reference tables (plans, currencies, countries, roles and role permissions), seeded by
    migrations.
  - Mirrors are synced from the control database by the services that change them. The sync is
    idempotent and retried, and it covers display data only.
- `tenant_id` stays on every row and the Prisma extension stays as defence in depth. Ids stay
  globally unique because tenants and users are created in the control database, and moved
  tenants keep their ids.

### 2. Tenancy mode

`TENANCY_MODE=shared|isolated`:
- **`shared`** is today's behaviour: the control database is also every tenant's database. It is
  the default for local and Windows installs and for the unit tests.
- **`isolated`** routes each tenant to its own database. The owner wants it for every SaaS
  tenant.

The application code is identical in both modes; only the router differs.

### 3. Routing

`PrismaService` becomes:
- `control()` — the unrestricted client of the control database;
- `forTenant(tenantId?)` — the scoped client of that tenant's database.

`TenantDbRouter` reads `tenant_databases` and keeps pools as follows:
- one small pool per tenant database (`TENANT_DB_POOL_SIZE`, default 3);
- pools are created lazily and closed after `TENANT_DB_IDLE_MS`;
- the number of open pools is capped by LRU (`TENANT_DB_MAX_POOLS`), which keeps the process
  under the Hostinger connection budget.

`TenantGuard` resolves the route and rejects a tenant whose database is `MIGRATING`, `MOVING`,
or behind the application `schema_version`, with `TENANT_MAINTENANCE` (HTTP 503, translated).

The current `prisma.client` users (28 files) are classified:
- control: auth, tokens, platform admin, tenant status, password reset;
- tenant: users and invitations (membership side), document locks, e-invoice worker, monitoring
  counts, export, stock verification, integrity checks.

### 4. Provisioning (`DB_PROVISIONER=create|pool`)

- **`create`** (VPS): a provisioning account creates `erp_t_<tenantId>` and grants it to the app
  user. Its credential is used only by this step.
- **`pool`** (Hostinger): the owner creates empty databases in hPanel and registers them with
  `job:db-pool-add <db> <user> <password>`.
  - Sign-up claims one database atomically.
  - When none is left, sign-up returns `REGISTRATION_UNAVAILABLE` and an alert goes to
    `ALERT_WEBHOOK_URL`. The alert also fires when the pool drops below `DB_POOL_LOW_WATER`.
  - On Cloud the practical ceiling is about 299 tenants.

Database passwords are encrypted at rest with the existing backup crypto key scheme. They are
never logged.

### 5. Cross-database writes (no distributed transactions)

Sign-up and invitations now write to two databases. They run as idempotent steps, with state
kept in the control database:
1. In the control database, create the user and the tenant with `state = PROVISIONING`, plus
   `tenant_databases`.
2. Claim or create the database, migrate it, then write the mirrors and the tenant data (company,
   default chart, mappings, MAIN branch, owner membership) in one tenant transaction.
3. In the control database, set `ACTIVE` and write `user_tenants`.

A failed step leaves `PROVISIONING`. `job:provision-resume` retries it, and the tenant stays
unusable until it is `ACTIVE`.

Invitations follow the same pattern:
- the membership lives in the tenant database;
- the user and `user_tenants` live in the control database;
- the invite code hash stays with the membership.

### 6. Migrations

`job:migrate-all` works as follows:
- it migrates the control database first, then each tenant database one at a time;
- before each tenant database it sets `MIGRATING`, and afterwards it records `schema_version`;
- it is resumable, and it reports which databases failed;
- `job:preflight` lists the databases that are behind.

From now on, migrations must follow **expand/contract**. A deploy may run while some databases
are still on the previous version, and the app refuses to serve them until they are migrated.

### 7. Jobs, backup and purge

**Per-tenant jobs** loop over the active `tenant_databases` with bounded concurrency:
- `stock-verify`, `integrity-check`, `purge-expired`, `einvoice-send`;
- `einvoice-send` visits only tenants that have e-invoicing enabled.

**Backup:**
- `job:backup` dumps the control database and each tenant database separately, with one manifest
  entry per database;
- `job:backup-verify` restores any one of them;
- a new `job:tenant-restore <tenantId> <folder>` restores a single tenant.

**Purge:** `job:purge-tenant` drops the database in `create` mode. In `pool` mode it empties the
database and returns it to the pool. It then deletes the control rows.

**Platform admin** counts and lists are aggregated per database and cached for a short time.

### 8. Existing data

All current data is test data (owner, 2026-11-22). It stays in `shared` mode for trials and is not
moved; every tenant created in `isolated` mode starts with its own empty database. No extraction
tool is built.

## Consequences

**Users:**
- nothing changes: login, company switcher and permissions work as before;
- a tenant is briefly unavailable (`TENANT_MAINTENANCE`) while its database migrates.

**Development:**
- every migration runs on N databases, and the deploy time grows with N;
- expand/contract becomes mandatory;
- the e2e setup creates one control database and two tenant databases, and the isolation tests
  also assert that tenant B's database holds no rows of A;
- the CI suite runs in `isolated` mode, plus a smoke run in `shared` mode.

**Operations:**
- per-tenant backup, restore and deletion;
- one large tenant no longer slows the others;
- more connections overall;
- on Hostinger, the owner refills the database pool by hand.

**Not done:** moving existing tenants out of the shared database, consolidated reports across tenants, and moving one company out of a tenant.

## Phases

| Phase | Content |
|---|---|
| 29A | `TENANCY_MODE`, `TenantDbRouter`, the `tenant_databases` and `user_tenants` tables, and the routing of request paths (login, `TenantGuard`, the `prisma.client` users on request paths). Default `shared`, with no behaviour change. |
| 29B | Mirror sync, provisioners (`create` and `pool`), the sign-up and invitation steps with `provision-resume`, `migrate-all`, version gating and `TENANT_MAINTENANCE`. |
| 29C | Per-tenant jobs, backup, restore, purge, platform-admin aggregation, and e2e in `isolated` mode. |

## 29B amendments

- Both `create` and `pool` provisioning use the control database's `tenant_db_pool`; pool passwords are supplied to `db-pool-add` only through `TENANT_DB_PASSWORD`, never argv.
- A tenant schema version is the last successfully applied migration name. Only schemas behind the control migration set are gated; null or behind versions enter maintenance, while ahead versions remain usable.
- In isolated deployments the migration order is: deploy code, run `migrate-all`, then restart the API.
