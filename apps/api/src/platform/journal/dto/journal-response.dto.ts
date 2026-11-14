/**
 * Response shapes of the journal routes and the journal-side reports (PLAT-15).
 * They describe what JournalService and ReportsService return today; nothing
 * here changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import { KeysetOf } from '../../../common/openapi/responses.js';
import {
  AccountRow,
  JournalEntryRow,
  JournalLineRow,
} from '../../../common/openapi/prisma-models.js';
import { AccountType, JournalPartyType, JournalPostingKind, NormalBalance } from '../../../generated/prisma/enums.js';

/** Content type of the report downloads (`?format=pdf|xlsx`). */
export const REPORT_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** Account on a journal line: `{ id, code, nameAr, nameEn }`. */
export class JournalAccountRefDto extends PickType(AccountRow, ['id', 'code', 'nameAr', 'nameEn'] as const) {}

/** Number of lines on a journal entry row. */
export class JournalEntryCountDto {
  @ApiProperty({ type: 'integer' })
  lines!: number;
}

/** A reversal of a journal entry, as the list shows it: `{ id, entryNo }`. */
export class JournalEntryReversalRefDto extends PickType(JournalEntryRow, ['id', 'entryNo'] as const) {}

/** The entry a reversal reverses: `{ id, entryNo, entryDate }`. */
export class JournalEntryReversalOfDto extends PickType(JournalEntryRow, ['id', 'entryNo', 'entryDate'] as const) {}

/** A reversal of a journal entry, as the detail shows it: `{ id, entryNo, entryDate, status }`. */
export class JournalEntryReversalDto extends PickType(JournalEntryRow, ['id', 'entryNo', 'entryDate', 'status'] as const) {}

/** A journal entry row in the list (JournalService.list). */
export class JournalEntryListItemDto extends JournalEntryRow {
  @ApiProperty({ type: () => JournalEntryCountDto })
  _count!: JournalEntryCountDto;

  @ApiProperty({ type: () => JournalEntryReversalRefDto, isArray: true })
  reversals!: JournalEntryReversalRefDto[];
}

/** A journal line with its account (JournalEntryDetailDto.lines). */
export class JournalEntryLineDto extends JournalLineRow {
  @ApiProperty({ type: () => JournalAccountRefDto })
  account!: JournalAccountRefDto;
}

/** A journal entry with its lines and reversal links (JournalService.get; also the result of post, reverse and opening). */
export class JournalEntryDetailDto extends JournalEntryRow {
  @ApiProperty({ type: () => JournalEntryLineDto, isArray: true, description: 'Ordered by lineNo.' })
  lines!: JournalEntryLineDto[];

  @ApiProperty({ type: () => JournalEntryReversalOfDto, nullable: true })
  reversalOf!: JournalEntryReversalOfDto | null;

  @ApiProperty({ type: () => JournalEntryReversalDto, isArray: true })
  reversals!: JournalEntryReversalDto[];
}

/** Opening, closing and period totals of an account or party statement (ReportsService.statementSummary). */
export class JournalStatementSummaryDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  openingBalance!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  openingDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  openingCredit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  totalDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  totalCredit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingBalance!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingCredit!: string;
}

/** The account a general ledger statement is about (ReportsService.accountHeader). */
export class GeneralLedgerAccountDto extends PickType(AccountRow, ['id', 'code', 'nameAr', 'nameEn', 'normalBalance'] as const) {}

/** One line of the general ledger statement, with its running balance (ReportsService.ledgerRow). */
export class GeneralLedgerItemDto {
  @ApiProperty({ type: 'string' })
  lineId!: string;

  @ApiProperty({ type: 'string' })
  entryId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  entryNo!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  entryDate!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Line description, or the entry description when the line has none.' })
  description!: string | null;

  @ApiProperty({ type: 'string' })
  sourceType!: string;

  @ApiProperty({ enum: JournalPostingKind, enumName: 'JournalPostingKind' })
  postingKind!: JournalPostingKind;

  @ApiProperty({ enum: JournalPartyType, enumName: 'JournalPartyType', nullable: true })
  partyType!: JournalPartyType | null;

  @ApiProperty({ type: 'string', nullable: true })
  partyId!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  debit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  credit!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Running balance after this line.' })
  balance!: string;
}

/**
 * One keyset page of the general ledger statement (ReportsService.generalLedgerPage),
 * the JSON answer of GET /reports/general-ledger. `summary` is null after the first page.
 */
export class GeneralLedgerPageDto extends KeysetOf(GeneralLedgerItemDto, {
  summary: JournalStatementSummaryDto,
  summaryMode: 'nullable',
  name: 'GeneralLedgerKeysetBase',
}) {
  @ApiProperty({ type: () => GeneralLedgerAccountDto })
  account!: GeneralLedgerAccountDto;
}

/** One line of a party statement, with its account (ReportsService.partyStatementPage). */
export class PartyStatementItemDto {
  @ApiProperty({ type: 'string' })
  lineId!: string;

  @ApiProperty({ type: 'string' })
  entryId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  entryNo!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  entryDate!: string;

  @ApiProperty({ type: 'string' })
  accountCode!: string;

  @ApiProperty({ type: 'string' })
  accountName!: string;

  @ApiProperty({ type: 'string', nullable: true })
  accountNameEn!: string | null;

  @ApiProperty({ type: 'string' })
  sourceType!: string;

  @ApiProperty({ enum: JournalPostingKind, enumName: 'JournalPostingKind' })
  postingKind!: JournalPostingKind;

  @ApiProperty({ type: 'string', nullable: true })
  description!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  debit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  credit!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Running balance after this line.' })
  balance!: string;
}

/**
 * One keyset page of a party statement (ReportsService.partyStatementPage), the
 * JSON answer of GET /reports/party-statement. `summary` is null after the first page.
 */
export class PartyStatementPageDto extends KeysetOf(PartyStatementItemDto, {
  summary: JournalStatementSummaryDto,
  summaryMode: 'nullable',
  name: 'PartyStatementKeysetBase',
}) {
  @ApiProperty({ enum: JournalPartyType, enumName: 'JournalPartyType' })
  partyType!: JournalPartyType;

  @ApiProperty({ type: 'string' })
  partyId!: string;
}

/** One account row of the trial balance; the PRIOR_YEARS row carries an empty accountId (ReportsService.trialBalance). */
export class TrialBalanceRowDto {
  @ApiProperty({ type: 'string', description: 'Empty string on the PRIOR_YEARS row.' })
  accountId!: string;

  @ApiProperty({ type: 'string', enum: ['PRIOR_YEARS'], nullable: true, description: 'Null on an ordinary account.' })
  kind!: 'PRIOR_YEARS' | null;

  @ApiProperty({ type: 'string', description: 'Empty string on the PRIOR_YEARS row.' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ enum: AccountType, enumName: 'AccountType' })
  accountType!: AccountType;

  @ApiProperty({ enum: NormalBalance, enumName: 'NormalBalance' })
  normalBalance!: NormalBalance;

  @ApiProperty({ type: 'string', format: 'decimal' })
  totalDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  totalCredit!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'May be negative.' })
  balance!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  openingDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  openingCredit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  periodDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  periodCredit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingCredit!: string;
}

/** Column totals of the trial balance. */
export class TrialBalanceTotalsDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  debit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  credit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  openingDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  openingCredit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  periodDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  periodCredit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingDebit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingCredit!: string;
}

/** The trial balance as JSON (`format=json`, the default). */
export class TrialBalanceDto {
  @ApiProperty({ type: () => TrialBalanceRowDto, isArray: true })
  rows!: TrialBalanceRowDto[];

  @ApiProperty({ type: 'string', format: 'date', nullable: true, description: 'The first day of the nominal period, if any.' })
  nominalFrom!: string | null;

  @ApiProperty({ type: () => TrialBalanceTotalsDto })
  totals!: TrialBalanceTotalsDto;

  @ApiProperty({ type: 'boolean' })
  balanced!: boolean;
}
