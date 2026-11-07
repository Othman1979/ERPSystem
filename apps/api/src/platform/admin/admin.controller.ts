import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PlatformAdmin, TenantOptional } from '../../common/decorators/auth.decorators.js';
import { AdminService } from './admin.service.js';
import {
  CreateSubscriptionDto,
  ExtendTrialDto,
  UpdateTenantStatusDto,
} from './dto/admin.dto.js';

@ApiTags('admin')
@Controller('admin/tenants')
@PlatformAdmin()
@TenantOptional()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.admin.listTenants({
      status,
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.admin.getTenant(BigInt(id));
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTenantStatusDto) {
    return this.admin.updateStatus(BigInt(id), dto);
  }

  @Post(':id/extend-trial')
  extendTrial(@Param('id') id: string, @Body() dto: ExtendTrialDto) {
    return this.admin.extendTrial(BigInt(id), dto);
  }

  @Post(':id/subscriptions')
  createSubscription(@Param('id') id: string, @Body() dto: CreateSubscriptionDto) {
    return this.admin.createSubscription(BigInt(id), dto);
  }
}
