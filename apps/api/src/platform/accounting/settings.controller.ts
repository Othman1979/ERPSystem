import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import {
  CreateTaxCategoryDto,
  CreateUnitDto,
  UpdateLookupDto,
  UpdateTaxCategoryDto,
} from './dto/accounting.dto.js';
import { SettingsService } from './settings.service.js';

@ApiTags('settings')
@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // ---- units ----
  @Get('units')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  listUnits() {
    return this.settings.list('unit');
  }

  @Post('units')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  createUnit(@Body() dto: CreateUnitDto) {
    return this.settings.create('unit', dto);
  }

  @Patch('units/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  updateUnit(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateLookupDto) {
    return this.settings.update('unit', BigInt(id), dto);
  }

  // ---- tax categories ----
  @Get('tax-categories')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  listTaxCategories() {
    return this.settings.list('taxCategory');
  }

  @Post('tax-categories')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  createTaxCategory(@Body() dto: CreateTaxCategoryDto) {
    return this.settings.create('taxCategory', dto);
  }

  @Patch('tax-categories/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  updateTaxCategory(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateTaxCategoryDto) {
    return this.settings.update('taxCategory', BigInt(id), dto);
  }

  // ---- payment methods ----
  @Get('payment-methods')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  listPaymentMethods() {
    return this.settings.list('paymentMethod');
  }

  @Post('payment-methods')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  createPaymentMethod(@Body() dto: CreateUnitDto) {
    return this.settings.create('paymentMethod', dto);
  }

  @Patch('payment-methods/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  updatePaymentMethod(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateLookupDto) {
    return this.settings.update('paymentMethod', BigInt(id), dto);
  }
}
