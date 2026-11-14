/**
 * Response shapes of the auth and session routes (PLAT-15). They describe what
 * AuthService and AuthController return today. The refresh token and family id
 * never appear in a body: they travel only in the HttpOnly refresh cookie.
 */
import { ApiProperty } from '@nestjs/swagger';
import { TenantStatus } from '../../../generated/prisma/enums.js';

/** `{ accessToken }`: the body of register and switch-tenant (AuthService.issueSession, minus the refresh token). */
export class AuthAccessTokenDto {
  @ApiProperty({ type: 'string' })
  accessToken!: string;
}

/** A tenant with an ACTIVE membership, as login lists it (AuthService.login). */
export class AuthLoginTenantDto {
  @ApiProperty({ type: 'string' })
  tenantId!: string;

  @ApiProperty({ type: 'string' })
  name!: string;

  @ApiProperty({ enum: TenantStatus, enumName: 'TenantStatus' })
  status!: TenantStatus;
}

/** Body of login: the access token, the tenants to pick from, and the pending invitation count (AuthService.login). */
export class AuthLoginResponseDto extends AuthAccessTokenDto {
  @ApiProperty({ type: () => AuthLoginTenantDto, isArray: true })
  tenants!: AuthLoginTenantDto[];

  @ApiProperty({ type: 'integer', minimum: 0 })
  pendingInvitations!: number;
}

/** The user the refreshed session belongs to (AuthService.refresh). */
export class AuthRefreshUserDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  email!: string;
}

/** Body of refresh: a new access token and the user (AuthService.refresh). */
export class AuthRefreshResponseDto extends AuthAccessTokenDto {
  @ApiProperty({ type: () => AuthRefreshUserDto })
  user!: AuthRefreshUserDto;
}

/** The signed-in user's own profile, as GET /me shows it (AuthService.me). */
export class MeUserDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  email!: string;

  @ApiProperty({ type: 'string' })
  fullName!: string;

  @ApiProperty({ type: 'string', description: 'UI language; a free code, "ar" by default.' })
  locale!: string;

  @ApiProperty({ type: 'boolean' })
  isPlatformAdmin!: boolean;

  @ApiProperty({ type: 'boolean' })
  mustChangePassword!: boolean;
}

/** One of the user's tenants in GET /me, marked when it is the token's own (AuthService.me). */
export class MeTenantListItemDto {
  @ApiProperty({ type: 'string' })
  tenantId!: string;

  @ApiProperty({ type: 'string' })
  tenantName!: string;

  @ApiProperty({ enum: TenantStatus, enumName: 'TenantStatus' })
  status!: TenantStatus;

  @ApiProperty({ type: 'string' })
  roleCode!: string;

  @ApiProperty({ type: 'string' })
  roleNameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  roleNameEn!: string | null;

  @ApiProperty({ type: 'boolean' })
  isCurrent!: boolean;
}

/** The plan of the current tenant, when it has one (Tenant.planId is optional). */
export class MePlanRefDto {
  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;
}

/** The tenant the token is scoped to (AuthService.me). */
export class MeCurrentTenantDto {
  @ApiProperty({ type: 'string' })
  tenantId!: string;

  @ApiProperty({ type: 'string' })
  name!: string;

  @ApiProperty({ enum: TenantStatus, enumName: 'TenantStatus' })
  status!: TenantStatus;

  @ApiProperty({ type: () => MePlanRefDto, nullable: true })
  plan!: MePlanRefDto | null;
}

/** A branch the user may work in, inside the current membership. */
export class MeBranchDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;
}

/** The user's membership in the current tenant: role, permission codes and branches (AuthService.me). */
export class MeCurrentMembershipDto {
  @ApiProperty({ type: 'string' })
  membershipId!: string;

  @ApiProperty({ type: 'string' })
  roleCode!: string;

  @ApiProperty({ type: 'string', isArray: true, description: 'Permission codes of the role in this tenant, sorted.' })
  permissions!: string[];

  @ApiProperty({ type: 'string', nullable: true })
  defaultBranchId!: string | null;

  @ApiProperty({ type: () => MeBranchDto, isArray: true })
  branches!: MeBranchDto[];

  @ApiProperty({ type: 'boolean', description: 'True when no branch is assigned: company-wide access.' })
  allBranches!: boolean;
}

/** Body of GET /me (AuthService.me). */
export class MeResponseDto {
  @ApiProperty({ type: () => MeUserDto })
  user!: MeUserDto;

  @ApiProperty({ type: 'integer', minimum: 0 })
  pendingInvitations!: number;

  @ApiProperty({ type: () => MeTenantListItemDto, isArray: true })
  tenants!: MeTenantListItemDto[];

  @ApiProperty({ type: () => MeCurrentTenantDto, nullable: true })
  currentTenant!: MeCurrentTenantDto | null;

  @ApiProperty({ type: () => MeCurrentMembershipDto, nullable: true })
  currentMembership!: MeCurrentMembershipDto | null;
}

/** An ACTIVE tenant of the user, as GET /me/tenants lists it (AuthService.myTenants). */
export class MyTenantDto {
  @ApiProperty({ type: 'string' })
  tenantId!: string;

  @ApiProperty({ type: 'string' })
  name!: string;

  @ApiProperty({ enum: TenantStatus, enumName: 'TenantStatus' })
  status!: TenantStatus;

  @ApiProperty({ type: 'string' })
  roleCode!: string;
}
