import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireAllBranches, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import {
  CreatePayrollSettlementDto,
  ListPayrollSettlementsQueryDto,
  PayrollSettlementPaymentDto,
  ReversePayrollSettlementDto,
} from './dto/payroll-settlement.dto.js';
import { PayrollSettlementDeletedDto, PayrollSettlementDto } from './dto/payroll-settlement-response.dto.js';
import { PayrollSettlementService } from './payroll-settlement.service.js';

@ApiTags('payroll')
@Controller('payroll/settlements')
@RequireAllBranches()
export class PayrollSettlementController {
  constructor(private readonly settlements: PayrollSettlementService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: PayrollSettlementDto, isArray: true })
  list(@Query() query: ListPayrollSettlementsQueryDto) {
    return this.settlements.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiCreatedResponse({ type: PayrollSettlementDto })
  create(@Body() dto: CreatePayrollSettlementDto) {
    return this.settlements.create(dto);
  }

  @Post(':id/recompute')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: PayrollSettlementDto })
  recompute(@Param('id') id: string) {
    return this.settlements.recompute(BigInt(id));
  }

  @Post(':id/post')
  @RequirePermission(PERMISSIONS.PAYROLL_POST)
  @RequiresIdempotencyKey()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: PayrollSettlementDto })
  post(@Param('id') id: string) {
    return this.settlements.post(BigInt(id));
  }

  @Post(':id/pay')
  @RequirePermission(PERMISSIONS.PAYROLL_POST)
  @RequiresIdempotencyKey()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: PayrollSettlementDto })
  pay(@Param('id') id: string, @Body() dto: PayrollSettlementPaymentDto) {
    return this.settlements.pay(BigInt(id), dto);
  }

  @Post(':id/reverse')
  @RequirePermission(PERMISSIONS.PAYROLL_POST)
  @RequiresIdempotencyKey()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: PayrollSettlementDto })
  reverse(@Param('id') id: string, @Body() dto: ReversePayrollSettlementDto) {
    return this.settlements.reverse(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiOkResponse({ type: PayrollSettlementDeletedDto })
  delete(@Param('id') id: string) {
    return this.settlements.delete(BigInt(id));
  }
}
