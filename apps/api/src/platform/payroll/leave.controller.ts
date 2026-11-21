import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireAllBranches, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import {
  CreateLeaveAdjustmentDto,
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  CreatePublicHolidayDto,
  LeaveAdjustmentsQueryDto,
  LeaveBalanceQueryDto,
  LeaveRequestsQueryDto,
  PublicHolidayQueryDto,
  UpdateLeaveTypeDto,
} from './dto/leave.dto.js';
import {
  LeaveAdjustmentResponseDto,
  LeaveBalanceResponseDto,
  LeaveRequestResponseDto,
  LeaveTypeResponseDto,
  PublicHolidayResponseDto,
} from './dto/leave-response.dto.js';
import { PayrollDeletedDto } from './dto/payroll-response.dto.js';
import { LeaveService } from './leave.service.js';

@ApiTags('payroll')
@Controller('payroll')
@RequireAllBranches()
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get('leave-types')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: LeaveTypeResponseDto, isArray: true })
  listTypes() {
    return this.leave.listTypes();
  }

  @Post('leave-types')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiCreatedResponse({ type: LeaveTypeResponseDto })
  createType(@Body() dto: CreateLeaveTypeDto) {
    return this.leave.createType(dto);
  }

  @Patch('leave-types/:id')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiOkResponse({ type: LeaveTypeResponseDto })
  updateType(@Param('id') id: string, @Body() dto: UpdateLeaveTypeDto) {
    return this.leave.updateType(BigInt(id), dto);
  }

  @Get('holidays')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: PublicHolidayResponseDto, isArray: true })
  listHolidays(@Query() query: PublicHolidayQueryDto) {
    return this.leave.listHolidays(query);
  }

  @Post('holidays')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiCreatedResponse({ type: PublicHolidayResponseDto })
  createHoliday(@Body() dto: CreatePublicHolidayDto) {
    return this.leave.createHoliday(dto);
  }

  @Delete('holidays/:id')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiOkResponse({ type: PayrollDeletedDto })
  deleteHoliday(@Param('id') id: string) {
    return this.leave.deleteHoliday(BigInt(id));
  }

  @Get('leave-requests')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: LeaveRequestResponseDto, isArray: true })
  listRequests(@Query() query: LeaveRequestsQueryDto) {
    return this.leave.listRequests(query);
  }

  @Post('leave-requests')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiCreatedResponse({ type: LeaveRequestResponseDto })
  createRequest(@Body() dto: CreateLeaveRequestDto) {
    return this.leave.createRequest(dto);
  }

  @Post('leave-requests/:id/approve')
  @RequirePermission(PERMISSIONS.PAYROLL_LEAVE_APPROVE)
  @RequiresIdempotencyKey()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: LeaveRequestResponseDto })
  approve(@Param('id') id: string) {
    return this.leave.approve(BigInt(id));
  }

  @Post('leave-requests/:id/reject')
  @RequirePermission(PERMISSIONS.PAYROLL_LEAVE_APPROVE)
  @RequiresIdempotencyKey()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: LeaveRequestResponseDto })
  reject(@Param('id') id: string) {
    return this.leave.reject(BigInt(id));
  }

  @Post('leave-requests/:id/cancel')
  @RequirePermission(PERMISSIONS.PAYROLL_LEAVE_APPROVE)
  @RequiresIdempotencyKey()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: LeaveRequestResponseDto })
  cancel(@Param('id') id: string) {
    return this.leave.cancel(BigInt(id));
  }

  @Get('leave-balances')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: LeaveBalanceResponseDto, isArray: true })
  balances(@Query() query: LeaveBalanceQueryDto) {
    return this.leave.listBalances(query);
  }

  @Get('leave-adjustments')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: LeaveAdjustmentResponseDto, isArray: true })
  adjustments(@Query() query: LeaveAdjustmentsQueryDto) {
    return this.leave.listAdjustments(query);
  }

  @Post('leave-adjustments')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiCreatedResponse({ type: LeaveAdjustmentResponseDto })
  createAdjustment(@Body() dto: CreateLeaveAdjustmentDto) {
    return this.leave.createAdjustment(dto);
  }
}
