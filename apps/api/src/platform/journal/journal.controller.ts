import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import {
  CreateJournalEntryDto,
  CreateOpeningEntryDto,
  ReportQueryDto,
  ReverseJournalEntryDto,
} from './dto/journal.dto.js';
import { JournalService } from './journal.service.js';
import { ReportsService } from './reports.service.js';

@ApiTags('journal')
@Controller()
export class JournalController {
  constructor(
    private readonly journal: JournalService,
    private readonly reports: ReportsService,
  ) {}

  @Get('journal-entries')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  list(@Query('status') status?: string, @Query('voucherType') voucherType?: string) {
    return this.journal.list(status, voucherType);
  }

  @Post('journal-entries')
  @RequirePermission(PERMISSIONS.JOURNAL_MANAGE)
  createDraft(@Body() dto: CreateJournalEntryDto) {
    return this.journal.createDraft(dto);
  }

  @Get('journal-entries/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  get(@Param('id') id: string) {
    return this.journal.get(BigInt(id));
  }

  @Delete('journal-entries/:id')
  @RequirePermission(PERMISSIONS.JOURNAL_MANAGE)
  deleteDraft(@Param('id') id: string) {
    return this.journal.deleteDraft(BigInt(id));
  }

  @Post('journal-entries/:id/post')
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  post(@Param('id') id: string) {
    return this.journal.postDraft(BigInt(id));
  }

  @Post('journal-entries/:id/reverse')
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  reverse(@Param('id') id: string, @Body() dto: ReverseJournalEntryDto) {
    return this.journal.reverse(BigInt(id), dto);
  }

  /** Guided opening-balance entry with OPENING_BALANCE_EQUITY plug (§8.6). */
  @Post('journal-entries/opening')
  @RequirePermission(PERMISSIONS.JOURNAL_POST)
  opening(@Body() dto: CreateOpeningEntryDto) {
    return this.journal.createOpening(dto);
  }

  // ---- reports (JSON) ----

  @Get('reports/trial-balance')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  trialBalance(@Query() q: ReportQueryDto) {
    return this.reports.trialBalance(q);
  }

  @Get('reports/general-ledger')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  generalLedger(@Query() q: ReportQueryDto) {
    return this.reports.generalLedger(BigInt(q.accountId ?? '0'), q);
  }

  @Get('reports/party-statement')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  partyStatement(@Query() q: ReportQueryDto) {
    return this.reports.partyStatement(
      q.partyType ?? 'CUSTOMER',
      BigInt(q.partyId ?? '0'),
      q,
    );
  }
}
