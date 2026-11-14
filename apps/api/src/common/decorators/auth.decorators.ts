import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';

/** Marks a route as reachable without an authenticated user. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Marks a route that must not require tenant context (e.g. /me, /auth, /admin). */
export const TENANT_OPTIONAL_KEY = 'tenantOptional';
export const TenantOptional = () => SetMetadata(TENANT_OPTIONAL_KEY, true);

/**
 * Lets a user whose password is temporary (User.mustChangePassword) reach this
 * route. Everything else answers PASSWORD_CHANGE_REQUIRED until they change it.
 */
export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'allowPendingPasswordChange';
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);

/** Requires platform admin (User.isPlatformAdmin). */
export const IS_PLATFORM_ADMIN_KEY = 'isPlatformAdmin';
export const PlatformAdmin = () => SetMetadata(IS_PLATFORM_ADMIN_KEY, true);

/** Requires one or more permission codes (any-of). */
export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermission = (...codes: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, codes);

/**
 * Company-wide report: only a member with every branch (no assigned branch)
 * may read it; others get 403 ALL_BRANCHES_REQUIRED from BranchGuard (ADR-003 §13).
 */
export const REQUIRE_ALL_BRANCHES_KEY = 'requireAllBranches';
export const RequireAllBranches = () => SetMetadata(REQUIRE_ALL_BRANCHES_KEY, true);

function ctx(): RequestContext {
  return ClsServiceManager.getClsService<RequestContext>().get() ?? {};
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext) => ctx().userId,
);

export const CurrentTenant = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext) => ctx().tenantId,
);

export const CurrentMembership = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext) => ctx().membershipId,
);

export const RequestContextData = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext) => ctx(),
);
