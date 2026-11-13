import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { CreateFiscalYearDto } from './dto/accounting.dto.js';
import { FiscalService } from './fiscal.service.js';

@ApiTags('fiscal')
@Controller()
export class FiscalController {
  constructor(private readonly fiscal: FiscalService) {}

  @Get('fiscal-years')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listYears() {
    return this.fiscal.listYears();
  }

  @Post('fiscal-years')
  @RequirePermission(PERMISSIONS.FISCAL_MANAGE)
  createYear(@Body() dto: CreateFiscalYearDto) {
    return this.fiscal.createYear(dto);
  }

  @Get('fiscal-years/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getYear(@Param('id') id: string) {
    return this.fiscal.getYear(BigInt(id));
  }

  /** Closes every period of the year at once (ADR-008 §7). */
  @Post('fiscal-years/:id/close')
  @RequirePermission(PERMISSIONS.FISCAL_CLOSE)
  closeYear(@Param('id') id: string) {
    return this.fiscal.setYearStatus(BigInt(id), 'CLOSED');
  }

  /** Reopens every period of the year. */
  @Post('fiscal-years/:id/open')
  @RequirePermission(PERMISSIONS.FISCAL_CLOSE)
  openYear(@Param('id') id: string) {
    return this.fiscal.setYearStatus(BigInt(id), 'OPEN');
  }

  @Post('fiscal-periods/:id/close')
  @RequirePermission(PERMISSIONS.FISCAL_CLOSE)
  closePeriod(@Param('id') id: string) {
    return this.fiscal.setPeriodStatus(BigInt(id), 'CLOSED');
  }

  @Post('fiscal-periods/:id/open')
  @RequirePermission(PERMISSIONS.FISCAL_CLOSE)
  openPeriod(@Param('id') id: string) {
    return this.fiscal.setPeriodStatus(BigInt(id), 'OPEN');
  }

  @Get('document-sequences')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listSequences(@Query('fiscalYearId') fiscalYearId?: string) {
    return this.fiscal.listSequences(fiscalYearId ? BigInt(fiscalYearId) : undefined);
  }
}
