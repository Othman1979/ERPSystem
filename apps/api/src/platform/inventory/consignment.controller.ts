import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import {
  ConsignmentAgingQueryDto,
  ConsignmentOpenSalesQueryDto,
  ConsignmentStatementQueryDto,
} from './dto/consignment.dto.js';
import {
  ConsignmentAgingResponseDto,
  ConsignmentOpenSaleResponseDto,
  ConsignmentStatementResponseDto,
} from './dto/consignment-response.dto.js';
import { ConsignmentService } from './consignment.service.js';

@ApiTags('consignment')
@Controller()
export class ConsignmentController {
  constructor(private readonly consignment: ConsignmentService) {}

  @Get('consignment/open-sales')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiOkResponse({ type: ConsignmentOpenSaleResponseDto, isArray: true, description: 'Open consignment sales available for settlement.' })
  openSales(@Query() query: ConsignmentOpenSalesQueryDto) {
    return this.consignment.openSales(query);
  }

  @Get('reports/consignment-statement')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiOkResponse({ type: ConsignmentStatementResponseDto, isArray: true, description: 'Consignment supplier statement, bounded to 500 item rows.' })
  statement(@Query() query: ConsignmentStatementQueryDto) {
    return this.consignment.statement(query);
  }

  @Get('reports/consignment-aging')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiOkResponse({ type: ConsignmentAgingResponseDto, isArray: true, description: 'Sold-not-invoiced consignment aging, bounded to 500 rows.' })
  aging(@Query() query: ConsignmentAgingQueryDto) {
    return this.consignment.aging(query);
  }
}
