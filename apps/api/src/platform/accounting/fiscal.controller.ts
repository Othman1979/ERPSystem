import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { ID_PATTERN, ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { CreateFiscalYearDto } from './dto/accounting.dto.js';
import {
  DocumentSequenceDto,
  FiscalPeriodDto,
  FiscalYearDetailDto,
  FiscalYearListItemDto,
  YearClosingPreviewDto,
} from './dto/accounting-response.dto.js';
import { FiscalService } from './fiscal.service.js';
import { YearClosingService } from './year-closing.service.js';

@ApiTags('fiscal')
@Controller()
export class FiscalController {
  constructor(
    private readonly fiscal: FiscalService,
    private readonly yearClosing: YearClosingService,
  ) {}

  @Get('fiscal-years')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: FiscalYearListItemDto, isArray: true })
  listYears() {
    return this.fiscal.listYears();
  }

  @Post('fiscal-years')
  @RequirePermission(PERMISSIONS.FISCAL_MANAGE)
  @ApiCreatedResponse({ type: FiscalYearDetailDto })
  createYear(@Body() dto: CreateFiscalYearDto) {
    return this.fiscal.createYear(dto);
  }

  @Get('fiscal-years/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: FiscalYearDetailDto })
  getYear(@Param('id', ParseIdPipe) id: string) {
    return this.fiscal.getYear(BigInt(id));
  }

  @Get('fiscal-years/:id/closing-preview')
  @RequirePermission(PERMISSIONS.FISCAL_CLOSE)
  @ApiOkResponse({ type: YearClosingPreviewDto })
  closingPreview(@Param('id', ParseIdPipe) id: string) {
    return this.yearClosing.preview(BigInt(id));
  }

  /** Closes the year with a posted year-end entry. */
  @Post('fiscal-years/:id/close')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.FISCAL_CLOSE)
  @ApiCreatedResponse({ type: FiscalYearDetailDto })
  closeYear(@Param('id', ParseIdPipe) id: string) {
    return this.yearClosing.close(BigInt(id));
  }

  /** Reverses the year-end entry and reopens every period. */
  @Post('fiscal-years/:id/open')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.FISCAL_CLOSE)
  @ApiCreatedResponse({ type: FiscalYearDetailDto })
  openYear(@Param('id', ParseIdPipe) id: string) {
    return this.yearClosing.reopen(BigInt(id));
  }

  @Post('fiscal-periods/:id/close')
  @RequirePermission(PERMISSIONS.FISCAL_CLOSE)
  @ApiCreatedResponse({ type: FiscalPeriodDto })
  closePeriod(@Param('id', ParseIdPipe) id: string) {
    return this.fiscal.setPeriodStatus(BigInt(id), 'CLOSED');
  }

  @Post('fiscal-periods/:id/open')
  @RequirePermission(PERMISSIONS.FISCAL_CLOSE)
  @ApiCreatedResponse({ type: FiscalPeriodDto })
  openPeriod(@Param('id', ParseIdPipe) id: string) {
    return this.fiscal.setPeriodStatus(BigInt(id), 'OPEN');
  }

  @Get('document-sequences')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: DocumentSequenceDto, isArray: true })
  listSequences(@Query('fiscalYearId') fiscalYearId?: string) {
    if (fiscalYearId !== undefined && !ID_PATTERN.test(fiscalYearId)) {
      throw new DomainError(ErrorCode.VALIDATION, 'fiscalYearId must be a positive integer id');
    }
    return this.fiscal.listSequences(fiscalYearId ? BigInt(fiscalYearId) : undefined);
  }
}
