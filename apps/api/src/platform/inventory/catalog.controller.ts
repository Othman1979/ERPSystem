import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
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
import {
  ItemByBarcodeDto,
  ItemBarcodeDto,
  ItemDetailDto,
  ItemDto,
  ItemGroupDto,
  ItemListItemDto,
} from './dto/inventory-response.dto.js';

@ApiTags('inventory-catalog')
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ------------------------------------------------------------- groups

  @Get('item-groups')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: ItemGroupDto, isArray: true })
  listGroups() {
    return this.catalog.listGroups();
  }

  @Post('item-groups')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({ type: ItemGroupDto })
  createGroup(@Body() dto: CreateItemGroupDto) {
    return this.catalog.createGroup(dto);
  }

  @Patch('item-groups/:id')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({ type: ItemGroupDto })
  updateGroup(@Param('id') id: string, @Body() dto: UpdateItemGroupDto) {
    return this.catalog.updateGroup(BigInt(id), dto);
  }

  // --------------------------------------------------------------- items

  @Get('items')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(ItemListItemDto)
  /** Numbered page `{ items, page, pageSize, total }` (ADR-022); `q` replaces the old `search`. */
  listItems(@Query() q: ListItemsQueryDto) {
    return this.catalog.listItems(q);
  }

  @Get('items/barcode/:code')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: ItemByBarcodeDto })
  findByBarcode(@Param('code') code: string) {
    return this.catalog.findByBarcode(code);
  }

  @Get('items/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: ItemDetailDto })
  getItem(@Param('id') id: string) {
    return this.catalog.getItem(BigInt(id));
  }

  @Post('items')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({ type: ItemDetailDto })
  createItem(@Body() dto: CreateItemDto) {
    return this.catalog.createItem(dto);
  }

  @Patch('items/:id')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({ type: ItemDto })
  updateItem(@Param('id') id: string, @Body() dto: UpdateItemDto) {
    return this.catalog.updateItem(BigInt(id), dto);
  }

  @Put('items/:id/units')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({ type: ItemDetailDto })
  setItemUnits(@Param('id') id: string, @Body() dto: SetItemUnitsDto) {
    return this.catalog.setItemUnits(BigInt(id), dto.units);
  }

  @Post('items/:id/barcodes')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({ type: ItemBarcodeDto })
  addBarcode(@Param('id') id: string, @Body() dto: BarcodeDto) {
    return this.catalog.addBarcode(BigInt(id), dto);
  }

  @Delete('item-barcodes/:id')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  removeBarcode(@Param('id') id: string) {
    return this.catalog.removeBarcode(BigInt(id));
  }
}
