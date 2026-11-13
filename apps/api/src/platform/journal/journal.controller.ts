import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import {
  CreateJournalEntryDto,
  CreateOpeningEntryDto,
  ReportQueryDto,
  ReverseJournalEntryDto,
} from './dto/journal.dto.js';
import { PartiesService } from '../parties/parties.service.js';
import { PrintingService } from '../printing/printing.service.js';
import { JournalService } from './journal.service.js';
import { generalLedgerTable, partyStatementTable, trialBalanceTable } from './reports.table.js';
import { ReportsService } from './reports.service.js';

@ApiTags('journal')
@Controller()
export class JournalController {
  constructor(
    private readonly journal: JournalService,
    private readonly reports: ReportsService,
    private readonly printing: PrintingService,
    private readonly parties: PartiesService,
  ) {}

  @Get('journal-entries')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  list(
    @Query('status') status?: string,
    @Query('voucherType') voucherType?: string,
    /** MANUAL_JOURNAL or OPENING_ENTRY (the opening balances screen). */
    @Query('sourceType') sourceType?: string,
  ) {
    return this.journal.list(status, voucherType, sourceType);
  }

  @Post('journal-entries')
  @RequirePermission(PERMISSIONS.JOURNAL_MANAGE)
  createDraft(@Body() dto: CreateJournalEntryDto) {
    return this.journal.createDraft(dto);
  }

  @Get('journal-entries/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  get(@Param('id', ParseIdPipe) id: string) {
    return this.journal.get(BigInt(id));
  }

  @Delete('journal-entries/:id')
  @RequirePermission(PERMISSIONS.JOURNAL_MANAGE)
  deleteDraft(@Param('id', ParseIdPipe) id: string) {
    return this.journal.deleteDraft(BigInt(id));
  }

  @Post('journal-entries/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  post(@Param('id', ParseIdPipe) id: string) {
    return this.journal.postDraft(BigInt(id));
  }

  @Post('journal-entries/:id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  reverse(@Param('id', ParseIdPipe) id: string, @Body() dto: ReverseJournalEntryDto) {
    return this.journal.reverse(BigInt(id), dto);
  }

  /** Guided opening-balance entry with OPENING_BALANCE_EQUITY plug (§8.6). */
  @Post('journal-entries/opening')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  opening(@Body() dto: CreateOpeningEntryDto) {
    return this.journal.createOpening(dto);
  }

  // ---- reports (?format=json|pdf|xlsx&lang=ar|en) ----

  @Get('reports/trial-balance')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async trialBalance(@Query() q: ReportQueryDto) {
    return this.printing.respond(await this.reports.trialBalance(q), q, (d, lang) => trialBalanceTable(d, lang, q));
  }

  @Get('reports/general-ledger')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async generalLedger(@Query() q: ReportQueryDto) {
    if (!q.accountId) {
      throw new DomainError(ErrorCode.VALIDATION, 'accountId is required', { field: 'accountId' });
    }
    const data = await this.reports.generalLedger(BigInt(q.accountId), q);
    return this.printing.respond(data, q, (d, lang) => generalLedgerTable(d, lang, q));
  }

  @Get('reports/party-statement')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async partyStatement(@Query() q: ReportQueryDto) {
    if (!q.partyId || !q.partyType) {
      throw new DomainError(ErrorCode.VALIDATION, 'partyType and partyId are required', {
        field: !q.partyType ? 'partyType' : 'partyId',
      });
    }
    const partyId = BigInt(q.partyId);
    const data = await this.reports.partyStatement(q.partyType, partyId, q);
    const party = q.format && q.format !== 'json' ? ((await this.parties.summaries([partyId]))[0] ?? null) : null;
    return this.printing.respond(data, q, (d, lang) => partyStatementTable(d, lang, q, party));
  }
}
