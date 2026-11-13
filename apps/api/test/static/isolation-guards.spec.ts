/**
 * Phase 10.4 — tenant isolation, static guards (ADR-010 §10.4, CLAUDE.md
 * «تعدد المستأجرين»). They read the source, so a change that weakens the
 * isolation fails here before any request is made:
 *  - every raw SQL on a tenant table filters on tenant_id;
 *  - the unrestricted client (systemPrisma) is used only in reviewed files,
 *    each with a comment saying why; a new use fails until it is reviewed;
 *  - no DTO or route parameter takes a tenantId, except choosing among the
 *    user's own memberships at sign-in.
 */
import { RAW_CALL, rawSql, read, sourceFiles, tenantTables, usesSystemPrisma } from './isolation-scan.js';

/**
 * Files allowed to use systemPrisma, and why (reviewed 2026-11-13). Adding a
 * file here is a review decision: say why the tenant-scoped client cannot do.
 */
const SYSTEM_PRISMA: Record<string, string> = {
  'src/common/audit/audit.service.ts': 'audit rows span tenants and platform events (tenant_id nullable)',
  'src/common/guards/auth.guard.ts': 'resolves the signed-in user before any tenant is known',
  'src/common/guards/tenant.guard.ts': "reads the user's membership and the tenant's status to set the tenant",
  'src/common/plan-limits/plan-limits.service.ts': "reads the tenant's plan (platform tables)",
  'src/health/health.controller.ts': 'SELECT 1 connectivity probe, no table',
  'src/jobs/backup/backup.service.ts': 'whole-database backup (migrations list, server version)',
  'src/jobs/error-digest.service.ts': 'platform error table across tenants',
  'src/jobs/platform-admin-grant.service.ts': 'users are platform-wide',
  'src/jobs/password-reset.service.ts': 'users and refresh tokens are platform-wide (CLI reset, ADR-012)',
  'src/jobs/preflight.service.ts': 'server checks: version, migrations, plans, admins, settings',
  'src/jobs/tenant-purge.service.ts': "deletes one tenant's rows; every statement filters on tenant_id",
  'src/jobs/tenant-status.service.ts': 'subscription lifecycle across tenants',
  'src/jobs/stock-verify.service.ts': 'lists tenants (platform table), then verifies each in its own tenant context',
  'src/platform/admin/admin.service.ts': 'platform console (platform admins only)',
  'src/platform/auth/auth.service.ts': 'sign-in and registration happen before a tenant is chosen',
  'src/platform/auth/token.service.ts': 'refresh tokens belong to users, not tenants',
  'src/platform/einvoice/einvoice-worker.service.ts': 'claims the outbox across tenants, then sends each in its tenant context',
  'src/platform/export/tenant-export.service.ts': "reads the CLS tenant's own row of the platform tenants table",
  'src/platform/monitoring/error-events.service.ts': 'platform error table across tenants',
  'src/platform/monitoring/monitoring.service.ts': 'platform error table (platform admins only)',
  'src/platform/users/users.service.ts': 'users and invitations are platform-wide; memberships are filtered by the tenant',
};

const JUSTIFIED = /systemPrisma|system client|unrestricted|cross-tenant|across tenants|platform-wide/i;

/** Files whose raw SQL on tenant tables is cross-tenant on purpose, and why (reviewed 2026-11-13). */
const CROSS_TENANT_SQL: Record<string, string> = {
  'src/platform/einvoice/einvoice-worker.service.ts':
    'outbox maintenance and the atomic claim span tenants; each claimed row is then sent inside its own tenant context',
};

/** DTO fields named tenantId that are allowed, and why. */
const TENANT_ID_FIELDS: Record<string, string> = {
  'src/platform/auth/dto/auth.dto.ts': "login / switch: one of the user's own memberships, checked by the service",
};

describe('Tenant isolation — static guards (ADR-010 §10.4)', () => {
  const files = sourceFiles();
  const tables = tenantTables();

  it('knows the tenant tables', () => {
    expect(tables.size).toBeGreaterThan(40);
    for (const t of ['journal_entries', 'journal_lines', 'stock_movements', 'sales_invoices', 'parties', 'attachments']) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it('every raw SQL on a tenant table filters on tenant_id', () => {
    const leaks: string[] = [];
    const unparsed: string[] = [];
    let checked = 0;
    for (const f of files) {
      const source = read(f);
      const queries = rawSql(source);
      // Every call is read: a query the scanner skipped would pass unchecked.
      if (queries.length !== (source.match(RAW_CALL) ?? []).length) unparsed.push(f);
      for (const q of queries) {
        if (!q.literal) {
          leaks.push(`${f}:${q.line} (SQL is not a literal: cannot be checked)`);
          continue;
        }
        const touched = [...tables].filter((t) => new RegExp(`\\b${t}\\b`).test(q.sql));
        if (touched.length === 0) continue;
        checked += 1;
        if (!/\btenant_id\b/.test(q.sql)) leaks.push(`${f}:${q.line} (${touched.join(', ')})`);
      }
    }
    expect(unparsed).toEqual([]);
    expect(checked).toBeGreaterThan(15); // the scanner still finds the queries
    expect(leaks.filter((l) => !(l.split(':')[0] in CROSS_TENANT_SQL))).toEqual([]);
    // An exception that no longer needs it is removed from the list.
    expect(Object.keys(CROSS_TENANT_SQL).filter((f) => !leaks.some((l) => l.startsWith(`${f}:`)))).toEqual([]);
  });

  it('finds the unrestricted client under any name', () => {
    const svc = (body: string) => `class X { constructor(private readonly db: PrismaService) {} m() { ${body} } }`;
    expect(usesSystemPrisma(svc('return this.db.client.party.findMany();'))).toBe(true);
    expect(usesSystemPrisma(svc('const { client } = this.db; return client;'))).toBe(true);
    expect(usesSystemPrisma(svc("return this.db['client'];"))).toBe(true);
    expect(usesSystemPrisma(svc('return this.db.forTenant(t).party.findMany();'))).toBe(false);
  });

  it('systemPrisma only in reviewed files, each saying why', () => {
    const using = files.filter((f) => usesSystemPrisma(read(f)));
    expect(using.filter((f) => !(f in SYSTEM_PRISMA))).toEqual([]); // new: review and list it
    expect(Object.keys(SYSTEM_PRISMA).filter((f) => !using.includes(f))).toEqual([]); // stale entries
    expect(using.filter((f) => !JUSTIFIED.test(read(f)))).toEqual([]);
  });

  it('no DTO takes a tenantId, but sign-in among the user\'s own memberships', () => {
    const fields = files
      .filter((f) => /\/dto\//.test(f) && /^\s+tenantId[?!]?:/m.test(read(f)))
      .filter((f) => !(f in TENANT_ID_FIELDS));
    expect(fields).toEqual([]);
  });

  it('no route reads tenantId from the path, query or body', () => {
    const params = files.filter((f) => /@(Param|Query|Body)\(\s*['"]tenantId['"]/.test(read(f)));
    expect(params).toEqual([]);
  });
});
