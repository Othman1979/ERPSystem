import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { ApiFileResponse, ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ExportQueryDto } from '../printing/dto/export.dto.js';
import { PrintingService } from '../printing/printing.service.js';
import { CreateProductionVoucherDto, ListProductionVouchersQueryDto, UpdateProductionVoucherDto } from './dto/production-voucher.dto.js';
import { ProductionVoucherDetailDto, ProductionVoucherListItemDto } from './dto/production-voucher-response.dto.js';
import { productionVoucherPrint } from './production-voucher.print.js';
import { ProductionVouchersService } from './production-vouchers.service.js';

/**
 * Production vouchers (ADR-031 §7-§8, §11). Vouchers and their posting or reversal
 * take the stock permission; reads need tenant access.
 */
@ApiTags('manufacturing')
@Controller('production-vouchers')
export class ProductionVouchersController {
  constructor(
    private readonly vouchers: ProductionVouchersService,
    private readonly printing: PrintingService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(ProductionVoucherListItemDto)
  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  list(@Query() q: ListProductionVouchersQueryDto) {
    return this.vouchers.list(q);
  }

  @Post()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: ProductionVoucherDetailDto })
  create(@Body() dto: CreateProductionVoucherDto) {
    return this.vouchers.create(dto);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: ProductionVoucherDetailDto })
  get(@Param('id', ParseIdPipe) id: string) {
    return this.vouchers.get(BigInt(id));
  }

  @Put(':id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiOkResponse({ type: ProductionVoucherDetailDto })
  update(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateProductionVoucherDto) {
    return this.vouchers.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiOkResponse({ type: DeletedDto })
  deleteDraft(@Param('id', ParseIdPipe) id: string) {
    return this.vouchers.deleteDraft(BigInt(id));
  }

  @Post(':id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: ProductionVoucherDetailDto })
  post(@Param('id', ParseIdPipe) id: string) {
    return this.vouchers.post(BigInt(id));
  }

  @Post(':id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: ProductionVoucherDetailDto })
  reverse(@Param('id', ParseIdPipe) id: string) {
    return this.vouchers.reverse(BigInt(id));
  }

  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async pdf(@Param('id', ParseIdPipe) id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(productionVoucherPrint(await this.vouchers.get(BigInt(id)), lang), lang);
  }
}
