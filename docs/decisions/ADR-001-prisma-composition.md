# ADR-001: PrismaService uses composition, not inheritance

**الحالة:** مقبول — Phase 1
**التاريخ:** 2026-11-07

## السياق
Prisma 7's generated client (`provider = "prisma-client"`) exposes a generic
constructor. Under NodeNext ESM + strict TypeScript, `class PrismaService
extends PrismaClient` loses `$queryRaw`, `$disconnect`, and model accessors on
the inferred instance type.

## القرار
`PrismaService` **composes** a `PrismaClient` (`readonly client`) built with
the MariaDB driver adapter, and exposes `forTenant(tenantId?)` which returns a
`$extends`-wrapped client that injects `tenant_id` into every operation on
tenant models (BUILD_PLAN §5.3).

- `client` = system/unrestricted client — platform module, auth, scheduled
  jobs only; every direct use carries a justification comment.
- `forTenant()` = business modules; throws without tenant context.

## العواقب
- Full type safety retained; no `any` leakage beyond the extension's dynamic
  `args` (documented in `tenant-prisma.ts`).
- All call sites use `prisma.client.*` (system) or `prisma.forTenant().*` —
  enforced by review + isolation tests.
