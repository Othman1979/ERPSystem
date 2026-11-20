import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ApiFileResponse } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PrintingService } from '../printing/printing.service.js';
import { chequesTable } from './cheques.table.js';
import { ChequesService } from './cheques.service.js';
import { ChequeFilterDto, ChequeMoveDto, DepositChequeDto, ListChequesQueryDto, UndoChequeDto } from './dto/cheques.dto.js';
import { ChequeDetailDto, ChequeOutstandingDto, ChequePageDto } from './dto/cheques-response.dto.js';
import { REPORT_FILE_TYPES } from './dto/treasury-response.dto.js';

/** Incoming and outgoing cheques and their movements (ADR-037). */
@ApiTags('treasury')
@Controller('cheques')
export class ChequesController {
  constructor(
    private readonly cheques: ChequesService,
    private readonly printing: PrintingService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: ChequePageDto })
  list(@Query() q: ListChequesQueryDto) {
    return this.cheques.list(q, q.page ?? 1, q.pageSize ?? 50);
  }

  /** Outstanding cheques by due date: JSON, or a PDF or xlsx file (ADR-037 §7). */
  @Get('outstanding')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(REPORT_FILE_TYPES, ChequeOutstandingDto)
  async outstanding(@Query() q: ChequeFilterDto) {
    const { format, lang, ...filter } = q;
    return this.printing.respond(await this.cheques.outstanding(filter), { format, lang }, chequesTable);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: ChequeDetailDto })
  detail(@Param('id') id: string) {
    return this.cheques.detail(BigInt(id));
  }

  @Post(':id/deposit')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: ChequeDetailDto })
  deposit(@Param('id') id: string, @Body() dto: DepositChequeDto) {
    return this.cheques.move(BigInt(id), 'deposit', dto);
  }

  @Post(':id/collect')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: ChequeDetailDto })
  collect(@Param('id') id: string, @Body() dto: ChequeMoveDto) {
    return this.cheques.move(BigInt(id), 'collect', dto);
  }

  @Post(':id/clear')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: ChequeDetailDto })
  clear(@Param('id') id: string, @Body() dto: ChequeMoveDto) {
    return this.cheques.move(BigInt(id), 'clear', dto);
  }

  @Post(':id/return')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: ChequeDetailDto })
  returnCheque(@Param('id') id: string, @Body() dto: ChequeMoveDto) {
    return this.cheques.move(BigInt(id), 'return', dto);
  }

  @Post(':id/undo')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: ChequeDetailDto })
  undo(@Param('id') id: string, @Body() dto: UndoChequeDto) {
    return this.cheques.undo(BigInt(id), dto);
  }
}
