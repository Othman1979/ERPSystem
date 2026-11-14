import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { CatalogService } from './catalog.service.js';
import {
  BarcodeDto,
  CreateItemDto,
  CreateItemGroupDto,
  SetItemUnitsDto,
  UpdateItemDto,
  UpdateItemGroupDto,
} from './dto/inventory.dto.js';
import { ListItemsQueryDto } from './dto/list-queries.dto.js';

@ApiTags('inventory-catalog')
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ------------------------------------------------------------- groups

  @Get('item-groups')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listGroups() {
    return this.catalog.listGroups();
  }

  @Post('item-groups')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  createGroup(@Body() dto: CreateItemGroupDto) {
    return this.catalog.createGroup(dto);
  }

  @Patch('item-groups/:id')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  updateGroup(@Param('id') id: string, @Body() dto: UpdateItemGroupDto) {
    return this.catalog.updateGroup(BigInt(id), dto);
  }

  // --------------------------------------------------------------- items

  @Get('items')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  /** Numbered page `{ items, page, pageSize, total }` (ADR-022); `q` replaces the old `search`. */
  listItems(@Query() q: ListItemsQueryDto) {
    return this.catalog.listItems(q);
  }

  @Get('items/barcode/:code')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  findByBarcode(@Param('code') code: string) {
    return this.catalog.findByBarcode(code);
  }

  @Get('items/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getItem(@Param('id') id: string) {
    return this.catalog.getItem(BigInt(id));
  }

  @Post('items')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  createItem(@Body() dto: CreateItemDto) {
    return this.catalog.createItem(dto);
  }

  @Patch('items/:id')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  updateItem(@Param('id') id: string, @Body() dto: UpdateItemDto) {
    return this.catalog.updateItem(BigInt(id), dto);
  }

  @Put('items/:id/units')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  setItemUnits(@Param('id') id: string, @Body() dto: SetItemUnitsDto) {
    return this.catalog.setItemUnits(BigInt(id), dto.units);
  }

  @Post('items/:id/barcodes')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  addBarcode(@Param('id') id: string, @Body() dto: BarcodeDto) {
    return this.catalog.addBarcode(BigInt(id), dto);
  }

  @Delete('item-barcodes/:id')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  removeBarcode(@Param('id') id: string) {
    return this.catalog.removeBarcode(BigInt(id));
  }
}
