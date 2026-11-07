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

/** Requires platform admin (User.isPlatformAdmin). */
export const IS_PLATFORM_ADMIN_KEY = 'isPlatformAdmin';
export const PlatformAdmin = () => SetMetadata(IS_PLATFORM_ADMIN_KEY, true);

/** Requires one or more permission codes (any-of). */
export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermission = (...codes: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, codes);

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
