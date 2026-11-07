import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { BranchesService } from './branches.service.js';
import { CreateBranchDto, UpdateBranchDto } from './dto/branches.dto.js';

@ApiTags('branches')
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  list() {
    return this.branches.list();
  }

  @Post()
  @RequirePermission(PERMISSIONS.BRANCH_MANAGE)
  create(@Body() dto: CreateBranchDto) {
    return this.branches.create(dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.BRANCH_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateBranchDto) {
    return this.branches.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.BRANCH_MANAGE)
  deactivate(@Param('id') id: string) {
    return this.branches.deactivate(BigInt(id));
  }
}
