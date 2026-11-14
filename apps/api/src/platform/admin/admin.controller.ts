import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiPagedResponse } from '../../common/openapi/responses.js';
import { PlatformAdmin, TenantOptional } from '../../common/decorators/auth.decorators.js';
import { AdminService } from './admin.service.js';
import {
  CreateSubscriptionDto,
  ExtendTrialDto,
  ListTenantsQueryDto,
  UpdateTenantStatusDto,
} from './dto/admin.dto.js';
import {
  AdminSubscriptionCreatedDto,
  AdminTenantDetailDto,
  AdminTenantListItemDto,
  AdminTenantStatusDto,
  AdminTrialExtendedDto,
} from './dto/admin-response.dto.js';

@ApiTags('admin')
@Controller('admin/tenants')
@PlatformAdmin()
@TenantOptional()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @ApiPagedResponse(AdminTenantListItemDto)
  /** Numbered page `{ items, page, pageSize, total }` (ADR-022); `q` searches the tenant name. */
  list(@Query() q: ListTenantsQueryDto) {
    return this.admin.listTenants(q);
  }

  @Get(':id')
  @ApiOkResponse({ type: AdminTenantDetailDto })
  get(@Param('id') id: string) {
    return this.admin.getTenant(BigInt(id));
  }

  @Patch(':id/status')
  @ApiOkResponse({ type: AdminTenantStatusDto })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTenantStatusDto) {
    return this.admin.updateStatus(BigInt(id), dto);
  }

  @Post(':id/extend-trial')
  @ApiCreatedResponse({ type: AdminTrialExtendedDto })
  extendTrial(@Param('id') id: string, @Body() dto: ExtendTrialDto) {
    return this.admin.extendTrial(BigInt(id), dto);
  }

  @Post(':id/subscriptions')
  @ApiCreatedResponse({ type: AdminSubscriptionCreatedDto })
  createSubscription(@Param('id') id: string, @Body() dto: CreateSubscriptionDto) {
    return this.admin.createSubscription(BigInt(id), dto);
  }
}
