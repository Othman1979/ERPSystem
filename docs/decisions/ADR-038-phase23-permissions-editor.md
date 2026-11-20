# ADR-038: Phase 23 — flexible permissions editor (custom roles)

- **Status:** accepted (owner asked to continue without approval, 2026-11-20)
- **Roadmap:** BUILD_PLAN §20 item 13

## Context

Permissions are a static catalog (`common/permissions/permissions.ts`), bound to five global
system roles by the seed (`roles`, `role_permissions`, no `tenant_id`). An owner can only pick one
of the five roles per member, plus the three purchase permissions per member (ADR-024 §3).
Companies need roles of their own, e.g. "sales clerk without returns".

## Decision

1. **Tenant roles beside system roles.** New tenant tables `tenant_roles` (code, nameAr, nameEn,
   description) and `tenant_role_permissions` (permission code). System roles stay global and read-only.
2. **Assignment.** `tenant_memberships.custom_role_id` (nullable, composite FK). When set, the
   member's permissions are the custom role's codes **instead of** the system role's; `role_id`
   stays the base role (for `roleCode` rules such as OWNER). A custom role can't be given to an
   owner, and the last active owner can't lose OWNER.
3. **What a custom role may hold:** any tenant permission in the catalog except `platform.admin`,
   `user.manage` (team management stays owner-only, PLAT-28) and the three per-member purchase
   permissions (they stay in `member_permissions`). `tenant.read` is always included.
4. **Enforcement** is the same union in `TenantGuard` and `/me`: custom-or-system role codes plus
   member purchase permissions. Changes apply on the member's next request.
5. **Editing rules.** Owner only (`user.manage`). A role in use can be edited (takes effect at once) but
   not deleted. Every create, edit, delete and assignment is audited.
6. **Web:** a "Roles" tab under Users, with a permission matrix grouped by module (i18n labels),
   and the member dialog offers system roles plus custom roles.

## Deferred

Per-branch roles, field-level permissions, and copying roles between tenants.
