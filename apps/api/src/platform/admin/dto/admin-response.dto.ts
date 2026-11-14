/**
 * Response shapes of the platform console routes: tenants and plans (PLAT-15).
 * They describe what AdminService returns today; nothing here changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import { PlanRow, SubscriptionRow } from '../../../common/openapi/prisma-models.js';
import { SubscriptionStatus, TenantStatus } from '../../../generated/prisma/enums.js';

/** The plan of a tenant in the tenant list: code and names only (AdminService.listTenants). */
export class AdminTenantPlanRefDto extends PickType(PlanRow, ['code', 'nameAr', 'nameEn'] as const) {}

/** One tenant in the platform's paged tenant list (AdminService.listTenants). */
export class AdminTenantListItemDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  name!: string;

  @ApiProperty({ enum: TenantStatus, enumName: 'TenantStatus' })
  status!: TenantStatus;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  trialEndsAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  statusChangedAt!: string | null;

  @ApiProperty({ type: () => AdminTenantPlanRefDto, nullable: true })
  plan!: AdminTenantPlanRefDto | null;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Memberships of the tenant (all statuses).' })
  members!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  branches!: number;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt!: string;
}

/** A plan: every column of the plan catalogue (AdminService.getTenant, updatePlan). */
export class AdminPlanDto extends PlanRow {}

/** A plan in the catalogue list, with the number of tenants on it (AdminService.listPlans). */
export class AdminPlanListItemDto extends AdminPlanDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  tenants!: number;
}

/** A subscription row of a tenant: every column (AdminService.getTenant, last 12). */
export class AdminSubscriptionDto extends SubscriptionRow {}

/** A company of the tenant, shown on the tenant detail screen. */
export class AdminTenantCompanyDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  legalNameAr!: string;

  @ApiProperty({ type: 'boolean' })
  isActive!: boolean;
}

/** One tenant with its plan, companies and latest subscriptions (AdminService.getTenant). */
export class AdminTenantDetailDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  name!: string;

  @ApiProperty({ enum: TenantStatus, enumName: 'TenantStatus' })
  status!: TenantStatus;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  trialEndsAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  statusChangedAt!: string | null;

  @ApiProperty({ type: () => AdminPlanDto, nullable: true })
  plan!: AdminPlanDto | null;

  @ApiProperty({ type: () => AdminTenantCompanyDto, isArray: true })
  companies!: AdminTenantCompanyDto[];

  @ApiProperty({ type: 'integer', minimum: 0 })
  members!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  branches!: number;

  @ApiProperty({ type: () => AdminSubscriptionDto, isArray: true, description: 'Up to 12, newest first.' })
  subscriptions!: AdminSubscriptionDto[];

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt!: string;
}

/** Body of PATCH /admin/tenants/:id/status (AdminService.updateStatus). */
export class AdminTenantStatusDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ enum: TenantStatus, enumName: 'TenantStatus' })
  status!: TenantStatus;
}

/** Body of POST /admin/tenants/:id/extend-trial (AdminService.extendTrial). */
export class AdminTrialExtendedDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  trialEndsAt!: string;
}

/** Body of POST /admin/tenants/:id/subscriptions (AdminService.createSubscription). */
export class AdminSubscriptionCreatedDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ enum: SubscriptionStatus, enumName: 'SubscriptionStatus' })
  status!: SubscriptionStatus;
}
