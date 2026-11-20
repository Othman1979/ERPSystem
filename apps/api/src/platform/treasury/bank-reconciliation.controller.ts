import { Body, Controller, Delete, Get, Param, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ApiFileResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { SHEET_IMPORT_MAX_BYTES, type UploadedSheet } from '../inventory/count-sheet-import.js';
import { PrintingService } from '../printing/printing.service.js';
import { bankReconciliationTable } from './bank-reconciliation.table.js';
import { BankReconciliationService } from './bank-reconciliation.service.js';
import {
  BankReconciliationReportQueryDto,
  BankStatementHeaderDto,
  BankStatementLineInputDto,
  CreateBankStatementDto,
  ListBankStatementsQueryDto,
  MatchBankStatementLineDto,
} from './dto/bank-reconciliation.dto.js';
import {
  BankAutoMatchResultDto,
  BankBookLineDto,
  BankStatementDetailDto,
  BankStatementListItemDto,
} from './dto/bank-reconciliation-response.dto.js';
import { REPORT_FILE_TYPES } from './dto/treasury-response.dto.js';

/** Bank statements and their reconciliation (ADR-035). */
@ApiTags('treasury')
@Controller('bank-statements')
export class BankReconciliationController {
  constructor(
    private readonly reconciliation: BankReconciliationService,
    private readonly printing: PrintingService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: BankStatementListItemDto, isArray: true })
  list(@Query() q: ListBankStatementsQueryDto) {
    return this.reconciliation.list(q.bankAccountId ? BigInt(q.bankAccountId) : undefined);
  }

  @Post()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: BankStatementDetailDto })
  create(@Body() dto: CreateBankStatementDto) {
    return this.reconciliation.create(dto);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: BankStatementDetailDto })
  detail(@Param('id') id: string) {
    return this.reconciliation.detail(BigInt(id));
  }

  @Put(':id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: BankStatementDetailDto })
  update(@Param('id') id: string, @Body() dto: BankStatementHeaderDto) {
    return this.reconciliation.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  remove(@Param('id') id: string) {
    return this.reconciliation.remove(BigInt(id));
  }

  @Post(':id/lines')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: BankStatementDetailDto })
  addLine(@Param('id') id: string, @Body() dto: BankStatementLineInputDto) {
    return this.reconciliation.addLine(BigInt(id), dto);
  }

  @Delete(':id/lines/:lineId')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: BankStatementDetailDto })
  removeLine(@Param('id') id: string, @Param('lineId') lineId: string) {
    return this.reconciliation.removeLine(BigInt(id), BigInt(lineId));
  }

  /** Adds the rows of an xlsx bank statement, all or nothing (ADR-035 §2). */
  @Post(':id/import')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SHEET_IMPORT_MAX_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  @ApiCreatedResponse({ type: BankStatementDetailDto })
  importLines(@Param('id') id: string, @UploadedFile() file: UploadedSheet | undefined) {
    return this.reconciliation.importLines(BigInt(id), file);
  }

  @Get(':id/candidates')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: BankBookLineDto, isArray: true })
  candidates(@Param('id') id: string) {
    return this.reconciliation.candidates(BigInt(id));
  }

  @Post(':id/matches')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: BankStatementDetailDto })
  match(@Param('id') id: string, @Body() dto: MatchBankStatementLineDto) {
    return this.reconciliation.match(BigInt(id), BigInt(dto.statementLineId), dto.journalLineIds.map((value) => BigInt(value)));
  }

  @Delete(':id/matches/:lineId')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: BankStatementDetailDto })
  unmatch(@Param('id') id: string, @Param('lineId') lineId: string) {
    return this.reconciliation.unmatch(BigInt(id), BigInt(lineId));
  }

  @Post(':id/auto-match')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: BankAutoMatchResultDto })
  autoMatch(@Param('id') id: string) {
    return this.reconciliation.autoMatch(BigInt(id));
  }

  @Post(':id/reconcile')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: BankStatementDetailDto })
  reconcile(@Param('id') id: string) {
    return this.reconciliation.reconcile(BigInt(id));
  }

  @Post(':id/reopen')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: BankStatementDetailDto })
  reopen(@Param('id') id: string) {
    return this.reconciliation.reopen(BigInt(id));
  }

  /** The reconciliation report: JSON, or a PDF or xlsx file (ADR-035 §9). */
  @Get(':id/report')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiFileResponse(REPORT_FILE_TYPES, BankStatementDetailDto)
  async report(@Param('id') id: string, @Query() q: BankReconciliationReportQueryDto) {
    const data = await this.reconciliation.detail(BigInt(id));
    return this.printing.respond(data, q, bankReconciliationTable);
  }
}
