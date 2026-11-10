import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { SetAccountOpeningDto, SetPartyOpeningDto } from './dto/opening.dto.js';
import { OpeningBalancesService } from './opening-balances.service.js';

/** Opening balances on the account and customer/supplier forms (ADR-007). */
@ApiTags('opening-balances')
@Controller('opening-balances')
export class OpeningBalancesController {
  constructor(private readonly opening: OpeningBalancesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  summary() {
    return this.opening.summary();
  }

  @Get('accounts/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  account(@Param('id') id: string) {
    return this.opening.account(BigInt(id));
  }

  /** Sets the account's opening balance; posts only the change. */
  @Put('accounts/:id')
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  setAccount(@Param('id') id: string, @Body() dto: SetAccountOpeningDto) {
    return this.opening.setAccount(BigInt(id), dto);
  }

  @Get('parties/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  party(@Param('id') id: string) {
    return this.opening.party(BigInt(id));
  }

  /** Sets a customer's or supplier's opening balance; posts only the change. */
  @Put('parties/:id')
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  setParty(@Param('id') id: string, @Body() dto: SetPartyOpeningDto) {
    return this.opening.setParty(BigInt(id), dto);
  }
}
