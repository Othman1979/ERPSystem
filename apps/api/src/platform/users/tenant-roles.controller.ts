import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { PermissionCatalogDto, SaveTenantRoleDto, TenantRoleDto } from './dto/tenant-roles.dto.js';
import { TenantRolesService } from './tenant-roles.service.js';

class TenantRoleDeletedDto {
  @ApiProperty({ type: 'string' })
  id!: string;
}

/** A company's own roles (ADR-038); team management is owner only (PLAT-28). */
@ApiTags('users')
@Controller('roles')
export class TenantRolesController {
  constructor(private readonly roles: TenantRolesService) {}

  @Get('catalog')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOkResponse({ type: PermissionCatalogDto })
  catalog() {
    return this.roles.catalog();
  }

  @Get('custom')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOkResponse({ type: TenantRoleDto, isArray: true })
  list() {
    return this.roles.list();
  }

  @Post('custom')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiCreatedResponse({ type: TenantRoleDto })
  create(@Body() dto: SaveTenantRoleDto) {
    return this.roles.create(dto);
  }

  @Put('custom/:id')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOkResponse({ type: TenantRoleDto })
  update(@Param('id', ParseIdPipe) id: bigint, @Body() dto: SaveTenantRoleDto) {
    return this.roles.update(id, dto);
  }

  @Delete('custom/:id')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOkResponse({ type: TenantRoleDeletedDto })
  remove(@Param('id', ParseIdPipe) id: bigint) {
    return this.roles.remove(id);
  }
}
