import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import {
  WarehouseDetailDto,
  WarehouseDto,
  WarehouseListItemDto,
} from './dto/inventory-response.dto.js';
import { CreateWarehouseDto, UpdateWarehouseDto } from './dto/inventory.dto.js';
import { WarehousesService } from './warehouses.service.js';

@ApiTags('warehouses')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: WarehouseListItemDto, isArray: true })
  list() {
    return this.warehouses.list();
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: WarehouseDetailDto })
  get(@Param('id') id: string) {
    return this.warehouses.get(BigInt(id));
  }

  @Post()
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  @ApiCreatedResponse({ type: WarehouseDto })
  create(@Body() dto: CreateWarehouseDto) {
    return this.warehouses.create(dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  @ApiOkResponse({ type: WarehouseDto })
  update(@Param('id') id: string, @Body() dto: UpdateWarehouseDto) {
    return this.warehouses.update(BigInt(id), dto);
  }
}
