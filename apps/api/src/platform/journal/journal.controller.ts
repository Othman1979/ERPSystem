import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireAllBranches, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse, ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { keysetLimit } from '../../common/paging/page-query.dto.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import {
  CreateJournalEntryDto,
  CreateOpeningEntryDto,
  ListJournalEntriesQueryDto,
  ReportQueryDto,
  ReverseJournalEntryDto,
  StatementQueryDto,
} from './dto/journal.dto.js';
import {
  GeneralLedgerPageDto,
  JournalEntryDetailDto,
  JournalEntryListItemDto,
  PartyStatementPageDto,
  REPORT_FILE_TYPES,
  TrialBalanceDto,
} from './dto/journal-response.dto.js';
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

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022, LEDGER-08), the caller's branches only. */
  @Get('journal-entries')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(JournalEntryListItemDto)
  list(@Query() q: ListJournalEntriesQueryDto) {
    return this.journal.list(q);
  }

  @Post('journal-entries')
  @RequirePermission(PERMISSIONS.JOURNAL_MANAGE)
  @ApiCreatedResponse({ type: JournalEntryDetailDto })
  createDraft(@Body() dto: CreateJournalEntryDto) {
    return this.journal.createDraft(dto);
  }

  @Get('journal-entries/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: JournalEntryDetailDto })
  get(@Param('id', ParseIdPipe) id: string) {
    return this.journal.get(BigInt(id));
  }

  @Delete('journal-entries/:id')
  @RequirePermission(PERMISSIONS.JOURNAL_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  deleteDraft(@Param('id', ParseIdPipe) id: string) {
    return this.journal.deleteDraft(BigInt(id));
  }

  @Post('journal-entries/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  @ApiCreatedResponse({ type: JournalEntryDetailDto })
  post(@Param('id', ParseIdPipe) id: string) {
    return this.journal.postDraft(BigInt(id));
  }

  @Post('journal-entries/:id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  @ApiCreatedResponse({ type: JournalEntryDetailDto })
  reverse(@Param('id', ParseIdPipe) id: string, @Body() dto: ReverseJournalEntryDto) {
    return this.journal.reverse(BigInt(id), dto);
  }

  /** Guided opening-balance entry with OPENING_BALANCE_EQUITY plug (§8.6). */
  @Post('journal-entries/opening')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  @ApiCreatedResponse({ type: JournalEntryDetailDto })
  opening(@Body() dto: CreateOpeningEntryDto) {
    return this.journal.createOpening(dto);
  }

  // ---- reports (?format=json|pdf|xlsx&lang=ar|en) ----

  /** Company-wide: only for members with every branch (ADR-003 §13). */
  @Get('reports/trial-balance')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @RequireAllBranches()
  @ApiFileResponse(REPORT_FILE_TYPES, TrialBalanceDto)
  async trialBalance(@Query() q: ReportQueryDto) {
    return this.printing.respond(await this.reports.trialBalance(q), q, (d, lang) => trialBalanceTable(d, lang, q));
  }

  /**
   * Account statement. JSON: one keyset page (ADR-022 §4) — `{ account,
   * summary (first page), items, nextCursor }`. PDF / XLSX: the whole
   * statement, capped (REPORT_TOO_LARGE). Company-wide (ADR-003 §13).
   */
  @Get('reports/general-ledger')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @RequireAllBranches()
  @ApiFileResponse(REPORT_FILE_TYPES, GeneralLedgerPageDto)
  async generalLedger(@Query() q: StatementQueryDto) {
    if (!q.accountId) {
      throw new DomainError(ErrorCode.VALIDATION, 'accountId is required', { field: 'accountId' });
    }
    const accountId = BigInt(q.accountId);
    if ((q.format ?? 'json') === 'json') {
      return this.reports.generalLedgerPage(accountId, q, { limit: keysetLimit(q), cursor: q.cursor });
    }
    const data = await this.reports.generalLedger(accountId, q);
    return this.printing.respond(data, q, (d, lang) => generalLedgerTable(d, lang, q));
  }

  /**
   * Party statement, on the caller's branches (ADR-003 §12). JSON: one keyset
   * page (ADR-022 §4); PDF / XLSX: the whole statement, capped.
   */
  @Get('reports/party-statement')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiFileResponse(REPORT_FILE_TYPES, PartyStatementPageDto)
  async partyStatement(@Query() q: StatementQueryDto) {
    if (!q.partyId || !q.partyType) {
      throw new DomainError(ErrorCode.VALIDATION, 'partyType and partyId are required', {
        field: !q.partyType ? 'partyType' : 'partyId',
      });
    }
    const partyId = BigInt(q.partyId);
    if ((q.format ?? 'json') === 'json') {
      return this.reports.partyStatementPage(q.partyType, partyId, q, { limit: keysetLimit(q), cursor: q.cursor });
    }
    const data = await this.reports.partyStatement(q.partyType, partyId, q);
    const party = q.format && q.format !== 'json' ? ((await this.parties.summaries([partyId]))[0] ?? null) : null;
    return this.printing.respond(data, q, (d, lang) => partyStatementTable(d, lang, q, party));
  }
}
