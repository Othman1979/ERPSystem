import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PlatformAdmin, TenantOptional } from '../../common/decorators/auth.decorators.js';
import { AdminService } from './admin.service.js';
import { UpdatePlanDto } from './dto/admin.dto.js';
import { AdminPlanDto, AdminPlanListItemDto } from './dto/admin-response.dto.js';

/** Plan limits and prices — the platform owner's catalogue (ADR-009 §1). */
@ApiTags('admin')
@Controller('admin/plans')
@PlatformAdmin()
@TenantOptional()
export class AdminPlansController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @ApiOkResponse({ type: AdminPlanListItemDto, isArray: true })
  list() {
    return this.admin.listPlans();
  }

  @Patch(':code')
  @ApiOkResponse({ type: AdminPlanDto })
  update(@Param('code') code: string, @Body() dto: UpdatePlanDto) {
    return this.admin.updatePlan(code, dto);
  }
}
