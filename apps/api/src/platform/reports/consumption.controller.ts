import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PrintingService } from '../printing/printing.service.js';
import { ConsumptionQueryDto, ConsumptionReportDto, RecipeSalesWithoutBomQueryDto, RecipeSalesWithoutBomRowDto } from './dto/consumption.dto.js';
import { consumptionTable } from './consumption.table.js';
import { ConsumptionReportService } from './consumption-report.service.js';

/** Stock reports that need the recipes (ADR-032 §6): consumption between two counts, recipe sales without a version. */
@ApiTags('stock-reports')
@Controller('stock-reports')
export class ConsumptionController {
  constructor(
    private readonly consumption: ConsumptionReportService,
    private readonly printing: PrintingService,
  ) {}

  @Get('consumption')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiFileResponse(
    ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ConsumptionReportDto,
    'Consumption between two posted counts as JSON; a PDF or xlsx file with format=pdf|xlsx.',
  )
  async consumptionReport(@Query() q: ConsumptionQueryDto) {
    const data = await this.consumption.consumption(q.warehouseId, q.fromCountId, q.toCountId);
    return this.printing.respond(data, q, (d, lang) => consumptionTable(d, lang));
  }

  /** ADR-032 §1: recipe lines of posted invoices sold without an ACTIVE bill of materials, in a date range. */
  @Get('recipe-sales-without-bom')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiOkResponse({ type: RecipeSalesWithoutBomRowDto, isArray: true })
  recipeSalesWithoutBom(@Query() q: RecipeSalesWithoutBomQueryDto) {
    return this.consumption.recipeSalesWithoutBom(q.from, q.to);
  }
}
