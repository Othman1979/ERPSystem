/**
 * Response shapes of the treasury routes (PLAT-15). They describe what the
 * cash-accounts, vouchers, cash-transfers and treasury-reports services return
 * today; nothing here changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import {
  AccountRow,
  AllocationRow,
  BankAccountRow,
  CashBoxRow,
  CashTransferRow,
  JournalEntryRow,
  PartyRow,
  PaymentMethodRow,
  PaymentRow,
  ReceiptRow,
} from '../../../common/openapi/prisma-models.js';
import { JournalPartyType } from '../../../generated/prisma/enums.js';

/** Content type of the report downloads (`?format=pdf|xlsx`). */
export const REPORT_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** Account on a treasury row: `{ id, code, nameAr }`. */
export class TreasuryAccountRefDto extends PickType(AccountRow, ['id', 'code', 'nameAr'] as const) {}

/** Account with its English name: `{ id, code, nameAr, nameEn }`. */
export class TreasuryAccountRefBilingualDto extends PickType(AccountRow, ['id', 'code', 'nameAr', 'nameEn'] as const) {}

/** Party on a voucher list row: `{ id, code, nameAr, partyType }`. */
export class TreasuryPartyTypeRefDto extends PickType(PartyRow, ['id', 'code', 'nameAr', 'partyType'] as const) {}

/** Party on an allocation: `{ id, code, nameAr }`. */
export class TreasuryPartyRefDto extends PickType(PartyRow, ['id', 'code', 'nameAr'] as const) {}

/** Payment method on a voucher: `{ id, code, nameAr }`. */
export class TreasuryPaymentMethodRefDto extends PickType(PaymentMethodRow, ['id', 'code', 'nameAr'] as const) {}

/** Journal entry a voucher or transfer posted: `{ id, entryNo, status }`. */
export class TreasuryJournalEntryRefDto extends PickType(JournalEntryRow, ['id', 'entryNo', 'status'] as const) {}

/** A cash box row (createCashBox, updateCashBox). */
export class CashBoxDto extends CashBoxRow {}

/** A cash box with its GL account (listCashBoxes). */
export class CashBoxListItemDto extends CashBoxRow {
  @ApiProperty({ type: () => TreasuryAccountRefDto })
  account!: TreasuryAccountRefDto;
}

/** A bank account row (createBankAccount, updateBankAccount). */
export class BankAccountDto extends BankAccountRow {}

/** A bank account with its GL account (listBankAccounts). */
export class BankAccountListItemDto extends BankAccountRow {
  @ApiProperty({ type: () => TreasuryAccountRefDto })
  account!: TreasuryAccountRefDto;
}

/** Delete of a cash box or bank account whose GL account has journal lines: deactivated instead (TRADE-25). */
export class TreasuryAccountDeactivatedDto {
  @ApiProperty({ type: 'boolean', enum: [false] })
  deleted!: false;

  @ApiProperty({ type: 'boolean', enum: [true] })
  deactivated!: true;
}

/** Number of allocations on a receipt row (cancelled ones included). */
export class ReceiptCountDto {
  @ApiProperty({ type: 'integer' })
  allocations!: number;
}

/** Number of allocations on a payment row (cancelled ones included). */
export class PaymentCountDto {
  @ApiProperty({ type: 'integer' })
  allocations!: number;
}

/** An allocation of a voucher, with the party it settled (VouchersService.getReceipt / getPayment). */
export class TreasuryAllocationDto extends AllocationRow {
  @ApiProperty({ type: () => TreasuryPartyRefDto })
  party!: TreasuryPartyRefDto;
}

/** A receipt row in the list (VouchersService.listReceipts). */
export class ReceiptListItemDto extends ReceiptRow {
  @ApiProperty({ type: () => TreasuryPartyTypeRefDto })
  party!: TreasuryPartyTypeRefDto;

  @ApiProperty({ type: () => TreasuryAccountRefDto })
  cashAccount!: TreasuryAccountRefDto;

  @ApiProperty({ type: () => ReceiptCountDto })
  _count!: ReceiptCountDto;
}

/** A receipt with its allocation totals (VouchersService.getReceipt; also the result of every receipt write). */
export class ReceiptDetailDto extends ReceiptRow {
  @ApiProperty({ type: () => PartyRow, description: 'The full party row.' })
  party!: PartyRow;

  @ApiProperty({ type: () => TreasuryAccountRefDto })
  cashAccount!: TreasuryAccountRefDto;

  @ApiProperty({ type: () => TreasuryPaymentMethodRefDto, nullable: true })
  paymentMethod!: TreasuryPaymentMethodRefDto | null;

  @ApiProperty({ type: () => TreasuryJournalEntryRefDto, nullable: true })
  journalEntry!: TreasuryJournalEntryRefDto | null;

  @ApiProperty({ type: () => TreasuryAllocationDto, isArray: true, description: 'Cancelled allocations included.' })
  allocations!: TreasuryAllocationDto[];

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Active allocations only, to 3 decimals.' })
  allocatedAmount!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Amount minus the allocated amount, to 3 decimals.' })
  unallocatedAmount!: string;
}

/** A payment row in the list (VouchersService.listPayments). */
export class PaymentListItemDto extends PaymentRow {
  @ApiProperty({ type: () => TreasuryPartyTypeRefDto, nullable: true, description: 'Null on a direct expense payment.' })
  party!: TreasuryPartyTypeRefDto | null;

  @ApiProperty({ type: () => TreasuryAccountRefDto })
  cashAccount!: TreasuryAccountRefDto;

  @ApiProperty({ type: () => TreasuryAccountRefDto, nullable: true })
  expenseAccount!: TreasuryAccountRefDto | null;

  @ApiProperty({ type: () => PaymentCountDto })
  _count!: PaymentCountDto;
}

/** A payment with its allocation totals (VouchersService.getPayment; also the result of every payment write). */
export class PaymentDetailDto extends PaymentRow {
  @ApiProperty({ type: () => PartyRow, nullable: true, description: 'The full party row; null on a direct expense payment.' })
  party!: PartyRow | null;

  @ApiProperty({ type: () => TreasuryAccountRefDto })
  cashAccount!: TreasuryAccountRefDto;

  @ApiProperty({ type: () => TreasuryAccountRefDto, nullable: true })
  expenseAccount!: TreasuryAccountRefDto | null;

  @ApiProperty({ type: () => TreasuryPaymentMethodRefDto, nullable: true })
  paymentMethod!: TreasuryPaymentMethodRefDto | null;

  @ApiProperty({ type: () => TreasuryJournalEntryRefDto, nullable: true })
  journalEntry!: TreasuryJournalEntryRefDto | null;

  @ApiProperty({ type: () => TreasuryAllocationDto, isArray: true, description: 'Cancelled allocations included.' })
  allocations!: TreasuryAllocationDto[];

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Active allocations only, to 3 decimals.' })
  allocatedAmount!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Amount minus the allocated amount, to 3 decimals.' })
  unallocatedAmount!: string;
}

/** A cash transfer row in the list (CashTransfersService.list). */
export class CashTransferListItemDto extends CashTransferRow {
  @ApiProperty({ type: () => TreasuryAccountRefBilingualDto })
  fromAccount!: TreasuryAccountRefBilingualDto;

  @ApiProperty({ type: () => TreasuryAccountRefBilingualDto })
  toAccount!: TreasuryAccountRefBilingualDto;
}

/** A cash transfer with its journal entry (CashTransfersService.get; also the result of create and reverse). */
export class CashTransferDetailDto extends CashTransferRow {
  @ApiProperty({ type: () => TreasuryAccountRefBilingualDto })
  fromAccount!: TreasuryAccountRefBilingualDto;

  @ApiProperty({ type: () => TreasuryAccountRefBilingualDto })
  toAccount!: TreasuryAccountRefBilingualDto;

  @ApiProperty({ type: () => TreasuryJournalEntryRefDto, nullable: true })
  journalEntry!: TreasuryJournalEntryRefDto | null;
}

/** One party row of the receivables or payables aging (TreasuryReportsService.aging). */
export class AgingReportRowDto {
  @ApiProperty({ type: 'string' })
  partyId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  notDue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  d1_30!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  d31_60!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  d61_90!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  d90plus!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  total!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'May be negative.' })
  unapplied!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'May be negative.' })
  balance!: string;
}

/** Column totals of the aging report. */
export class AgingReportTotalsDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  notDue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  d1_30!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  d31_60!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  d61_90!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  d90plus!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  total!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  unapplied!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  balance!: string;
}

/** The aging report as JSON (`format=json`, the default). */
export class AgingReportDto {
  @ApiProperty({ enum: JournalPartyType, enumName: 'JournalPartyType' })
  partyType!: JournalPartyType;

  @ApiProperty({ type: 'string', format: 'date', description: 'The day the balances are aged to.' })
  asOf!: string;

  @ApiProperty({ type: () => AgingReportRowDto, isArray: true })
  rows!: AgingReportRowDto[];

  @ApiProperty({ type: () => AgingReportTotalsDto })
  totals!: AgingReportTotalsDto;
}

/** One account row of the cash balances: a cash box, a bank account, or a plain account. */
export class CashBalanceRowDto {
  @ApiProperty({ type: 'string', enum: ['CASH_BOX', 'BANK_ACCOUNT', 'ACCOUNT'] })
  kind!: 'CASH_BOX' | 'BANK_ACCOUNT' | 'ACCOUNT';

  @ApiProperty({ type: 'string', description: 'Cash box, bank account or account id, by kind.' })
  id!: string;

  @ApiProperty({ type: 'string' })
  name!: string;

  @ApiProperty({ type: 'boolean' })
  isActive!: boolean;

  @ApiProperty({ type: () => TreasuryAccountRefBilingualDto })
  account!: TreasuryAccountRefBilingualDto;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'May be negative.' })
  balance!: string;
}

/** The cash balances report (TreasuryReportsService.cashBalances). */
export class CashBalancesDto {
  @ApiProperty({ type: () => CashBalanceRowDto, isArray: true })
  rows!: CashBalanceRowDto[];

  @ApiProperty({ type: 'string', format: 'decimal' })
  total!: string;
}
