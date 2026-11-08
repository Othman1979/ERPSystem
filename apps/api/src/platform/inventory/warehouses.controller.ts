import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { CreateWarehouseDto, UpdateWarehouseDto } from './dto/inventory.dto.js';
import { WarehousesService } from './warehouses.service.js';

@ApiTags('warehouses')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  list() {
    return this.warehouses.list();
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  get(@Param('id') id: string) {
    return this.warehouses.get(BigInt(id));
  }

  @Post()
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  create(@Body() dto: CreateWarehouseDto) {
    return this.warehouses.create(dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateWarehouseDto) {
    return this.warehouses.update(BigInt(id), dto);
  }
}
