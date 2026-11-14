import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccountsService } from './accounts.service.js';
import { ChartProvisioningService } from './chart-provisioning.service.js';
import {
  BulkMappingsDto,
  CreateAccountDto,
  UpdateAccountDto,
  UpsertMappingDto,
} from './dto/accounting.dto.js';
import {
  AccountDto,
  AccountMappingDto,
  AccountMappingSlotDto,
  ChartProvisionResultDto,
} from './dto/accounting-response.dto.js';
import { MappingsService } from './mappings.service.js';

@ApiTags('accounts')
@Controller()
export class AccountingController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly mappings: MappingsService,
    private readonly provisioning: ChartProvisioningService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('accounts')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: AccountDto, isArray: true })
  listAccounts() {
    return this.accounts.list();
  }

  @Post('accounts')
  @RequirePermission(PERMISSIONS.ACCOUNT_MANAGE)
  @ApiCreatedResponse({ type: AccountDto })
  createAccount(@Body() dto: CreateAccountDto) {
    return this.accounts.create(dto);
  }

  @Patch('accounts/:id')
  @RequirePermission(PERMISSIONS.ACCOUNT_MANAGE)
  @ApiOkResponse({ type: AccountDto })
  updateAccount(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateAccountDto) {
    return this.accounts.update(BigInt(id), dto);
  }

  @Get('account-mappings')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: AccountMappingSlotDto, isArray: true })
  listMappings() {
    return this.mappings.list();
  }

  @Post('account-mappings')
  @RequirePermission(PERMISSIONS.ACCOUNT_MANAGE)
  @ApiCreatedResponse({ type: AccountMappingDto })
  upsertMapping(@Body() dto: UpsertMappingDto) {
    return this.mappings.upsert(dto);
  }

  @Post('account-mappings/bulk')
  @RequirePermission(PERMISSIONS.ACCOUNT_MANAGE)
  @ApiCreatedResponse({ type: AccountMappingDto, isArray: true })
  bulkMappings(@Body() dto: BulkMappingsDto) {
    return this.mappings.bulk(dto);
  }

  /**
   * Provisions the default chart + mappings + lookups for the tenant's
   * company. Idempotent — safe to re-run (e.g. for companies created before
   * Phase 2 or after manual cleanup).
   */
  @Post('accounting/setup/provision')
  @RequirePermission(PERMISSIONS.ONBOARDING_MANAGE)
  @ApiCreatedResponse({ type: ChartProvisionResultDto })
  async provision() {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    const userId = cls.get('userId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    const db = this.prisma.forTenant(tenantId);
    const company = await db.company.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');

    const result = await db.$transaction((tx) =>
      this.provisioning.provision(tx, tenantId, company.id, userId),
    );
    await this.audit.log({
      action: 'accounting.provision',
      entityType: 'company',
      entityId: company.id,
      after: result,
    });
    return result;
  }
}
