# ADR-040: Phase 25 — several companies in one tenant

**Status:** accepted (owner, 2026-11-20)

## Context

Every operational table already carries `company_id` (§5: one tenant = one company in the MVP,
schema ready for more). The code resolved "the first active company" in about twenty places, and
nothing let an owner add a company or a user switch between companies.

## Decision

1. **Company of a request.** `CompanyGuard` runs after `TenantGuard` and before `BranchGuard`.
   The `X-Company-Id` header picks the company; it must be an active company of the tenant that
   the member may use. Without the header: the first allowed active company (by id), so existing
   clients behave as before. The result goes to CLS (`companyId`); every service reads it there
   (`DocumentSupportService.companyId` and the other resolvers), never from the body or query.
2. **Data is separate per company** (owner's choice): chart of accounts, mappings, fiscal years,
   sequences, branches, warehouses, items, parties, cash boxes, bank accounts, e-invoice settings,
   documents and reports. Tenant-wide: users, roles, units, tax categories, payment methods.
3. **Member access.** New table `membership_companies` (member ↔ company), like
   `membership_branches`: no row means every company; rows restrict the member to them. The owner
   always has every company. Branches assigned to a member count only in their own company.
4. **Managing companies** (owner only, `user.manage`): `GET /companies` lists the caller's
   companies; `POST /companies` creates one with the default chart, mappings and a MAIN branch,
   as at sign-up; `PATCH /companies/:id` renames or deactivates (the last active company cannot be
   deactivated).
5. **Web.** A company switcher in the top bar (shown with two or more companies); the choice is
   kept per browser and sent as `X-Company-Id`; switching clears the query cache.

## Deferred

Consolidated reports across companies, inter-company transactions, per-plan company limits.
Restaurant point of sale is removed from the roadmap (owner, 2026-11-20).
