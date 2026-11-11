import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PlatformAdmin, TenantOptional } from '../../common/decorators/auth.decorators.js';
import { AdminService } from './admin.service.js';
import { UpdatePlanDto } from './dto/admin.dto.js';

/** Plan limits and prices — the platform owner's catalogue (ADR-009 §1). */
@ApiTags('admin')
@Controller('admin/plans')
@PlatformAdmin()
@TenantOptional()
export class AdminPlansController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  list() {
    return this.admin.listPlans();
  }

  @Patch(':code')
  update(@Param('code') code: string, @Body() dto: UpdatePlanDto) {
    return this.admin.updatePlan(code, dto);
  }
}
