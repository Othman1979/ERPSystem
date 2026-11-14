/**
 * Response shapes of the reports routes (PLAT-15). They describe what
 * FinancialStatementsService, TaxSummaryService, TradeSummaryService and
 * DashboardService return today; nothing here changes a body.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Content type of the report downloads (`?format=pdf|xlsx`). */
export const REPORT_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** The fiscal year a statement falls in (`fiscalYear`, null when none covers the period). */
export class StatementFiscalYearRefDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  code!: string;
}

/** One account row of a financial statement section. */
export class FinancialStatementRowDto {
  @ApiProperty({ type: 'string' })
  accountId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ type: 'integer', description: 'Depth in the chart of accounts.' })
  depth!: number;

  @ApiProperty({ type: 'boolean' })
  isGroup!: boolean;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'May be negative.' })
  amount!: string;
}

/** A section of a financial statement: its rows and their total. */
export class FinancialStatementSectionDto {
  @ApiProperty({ type: () => FinancialStatementRowDto, isArray: true })
  rows!: FinancialStatementRowDto[];

  @ApiProperty({ type: 'string', format: 'decimal' })
  total!: string;
}

/** A cost of sales row: COGS or an inventory adjustment (IncomeStatementDto.costOfSales). */
export class IncomeStatementCostRowDto {
  @ApiProperty({ type: 'string', enum: ['COGS', 'INVENTORY_ADJUSTMENT'] })
  kind!: 'COGS' | 'INVENTORY_ADJUSTMENT';

  @ApiProperty({ type: 'string' })
  accountId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'May be negative.' })
  amount!: string;
}

/** The cost of sales section of the income statement. */
export class IncomeStatementCostOfSalesDto {
  @ApiProperty({ type: () => IncomeStatementCostRowDto, isArray: true })
  rows!: IncomeStatementCostRowDto[];

  @ApiProperty({ type: 'string', format: 'decimal' })
  total!: string;
}

/** The income statement as JSON (`format=json`, the default). */
export class IncomeStatementDto {
  @ApiProperty({ type: 'string', format: 'date' })
  from!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  to!: string;

  @ApiProperty({ type: () => StatementFiscalYearRefDto, nullable: true })
  fiscalYear!: StatementFiscalYearRefDto | null;

  @ApiProperty({ type: () => FinancialStatementSectionDto })
  revenue!: FinancialStatementSectionDto;

  @ApiProperty({ type: () => IncomeStatementCostOfSalesDto })
  costOfSales!: IncomeStatementCostOfSalesDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  grossProfit!: string;

  @ApiProperty({ type: () => FinancialStatementSectionDto })
  expenses!: FinancialStatementSectionDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  netProfit!: string;
}

/** The balance sheet as JSON (`format=json`, the default). */
export class BalanceSheetDto {
  @ApiProperty({ type: 'string', format: 'date' })
  asOf!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  yearStart!: string;

  @ApiProperty({ type: () => StatementFiscalYearRefDto, nullable: true })
  fiscalYear!: StatementFiscalYearRefDto | null;

  @ApiProperty({ type: () => FinancialStatementSectionDto })
  assets!: FinancialStatementSectionDto;

  @ApiProperty({ type: () => FinancialStatementSectionDto })
  liabilities!: FinancialStatementSectionDto;

  @ApiProperty({ type: () => FinancialStatementSectionDto })
  equity!: FinancialStatementSectionDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  priorYears!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  yearProfit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  totalLiabilitiesAndEquity!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  difference!: string;

  @ApiProperty({ type: 'boolean' })
  balanced!: boolean;
}

/** The tax amounts of a tax summary row, or of its totals (TaxSummaryService). */
export class TaxSummaryAmountsDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  salesBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  salesTax!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  salesReturnsBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  salesReturnsTax!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outputBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outputTax!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  purchasesBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  purchasesTax!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  purchaseReturnsBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  purchaseReturnsTax!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  inputBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  inputTax!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  payable!: string;
}

/** One tax category and rate of a tax summary (key is `taxCategoryId|rate`). */
export class TaxSummaryRowDto extends TaxSummaryAmountsDto {
  @ApiProperty({ type: 'string' })
  key!: string;

  @ApiProperty({ type: 'string', nullable: true })
  taxCategoryId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  code!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  nameAr!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Decimal.toString() of the rate, e.g. "16".' })
  rate!: string;

  @ApiProperty({ type: 'string', nullable: true })
  einvoiceCode!: string | null;
}

/** Output or input tax on the ledger, or the difference from the summary. */
export class TaxLedgerAmountsDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  output!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  input!: string;
}

/** The tax summary as JSON (`format=json`, the default). */
export class TaxSummaryDto {
  @ApiProperty({ type: 'string', format: 'date' })
  from!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  to!: string;

  @ApiProperty({ type: () => TaxSummaryRowDto, isArray: true })
  rows!: TaxSummaryRowDto[];

  @ApiProperty({ type: () => TaxSummaryAmountsDto })
  totals!: TaxSummaryAmountsDto;

  @ApiProperty({ type: () => TaxLedgerAmountsDto })
  ledger!: TaxLedgerAmountsDto;

  @ApiProperty({ type: () => TaxLedgerAmountsDto })
  ledgerDifference!: TaxLedgerAmountsDto;
}

/** The counts and amounts shared by every trade summary row and by its totals (TradeSummaryService). */
export class TradeSummaryAmountsDto {
  @ApiProperty({ type: 'integer', nullable: true, description: 'Null when grouped by item.' })
  invoiceCount!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Null when grouped by item.' })
  returnCount!: number | null;

  @ApiPropertyOptional({ type: 'string', format: 'decimal', description: 'Sent only when grouped by item.' })
  qty?: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  net!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  tax!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  grand!: string;
}

/** Totals of the sales summary: the amounts plus cost and margin. */
export class SalesSummaryTotalsDto extends TradeSummaryAmountsDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  cost!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  margin!: string;
}

/** One sales summary row (keyed by day, month, customer or item). */
export class SalesSummaryRowDto extends SalesSummaryTotalsDto {
  @ApiProperty({ type: 'string' })
  key!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Null when grouped by day or month.' })
  code!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  nameAr!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;
}

/** The sales summary as JSON (`format=json`, the default). */
export class SalesSummaryDto {
  @ApiProperty({ type: 'string', format: 'date' })
  from!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  to!: string;

  @ApiProperty({ type: 'string', enum: ['day', 'month', 'customer', 'supplier', 'item'] })
  groupBy!: 'day' | 'month' | 'customer' | 'supplier' | 'item';

  @ApiProperty({ type: () => SalesSummaryRowDto, isArray: true })
  rows!: SalesSummaryRowDto[];

  @ApiProperty({ type: () => SalesSummaryTotalsDto })
  totals!: SalesSummaryTotalsDto;
}

/** One purchases summary row (keyed by day, month, supplier or item). */
export class PurchasesSummaryRowDto extends TradeSummaryAmountsDto {
  @ApiProperty({ type: 'string' })
  key!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Null when grouped by day or month.' })
  code!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  nameAr!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;
}

/** The purchases summary as JSON (`format=json`, the default). */
export class PurchasesSummaryDto {
  @ApiProperty({ type: 'string', format: 'date' })
  from!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  to!: string;

  @ApiProperty({ type: 'string', enum: ['day', 'month', 'customer', 'supplier', 'item'] })
  groupBy!: 'day' | 'month' | 'customer' | 'supplier' | 'item';

  @ApiProperty({ type: () => PurchasesSummaryRowDto, isArray: true })
  rows!: PurchasesSummaryRowDto[];

  @ApiProperty({ type: () => TradeSummaryAmountsDto })
  totals!: TradeSummaryAmountsDto;
}

/** Sales of one day or of the month to date, on the dashboard (DashboardService). */
export class DashboardSalesBlockDto {
  @ApiProperty({ type: 'string', format: 'date' })
  from!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  to!: string;

  @ApiProperty({ type: 'integer', description: 'Null coalesced to 0.' })
  count!: number;

  @ApiProperty({ type: 'integer', description: 'Null coalesced to 0.' })
  returnCount!: number;

  @ApiProperty({ type: 'string', format: 'decimal' })
  net!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  tax!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  grand!: string;
}

/** Receivables on the dashboard. */
export class DashboardReceivablesDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  total!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  overdue!: string;
}

/** One item below its minimum stock, on the dashboard. */
export class DashboardBelowMinimumItemDto {
  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ type: 'string' })
  unit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyOnHand!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  minStock!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  shortage!: string;
}

/** Items below minimum stock: the total count and at most 10 of them. */
export class DashboardBelowMinimumDto {
  @ApiProperty({ type: 'integer' })
  count!: number;

  @ApiProperty({ type: () => DashboardBelowMinimumItemDto, isArray: true, description: 'At most 10.' })
  items!: DashboardBelowMinimumItemDto[];
}

/** The dashboard summary (DashboardService.summary). */
export class DashboardSummaryDto {
  @ApiProperty({ type: 'string', format: 'date' })
  date!: string;

  @ApiProperty({ type: () => DashboardSalesBlockDto })
  salesToday!: DashboardSalesBlockDto;

  @ApiProperty({ type: () => DashboardSalesBlockDto })
  salesMonth!: DashboardSalesBlockDto;

  @ApiProperty({ type: () => DashboardReceivablesDto })
  receivables!: DashboardReceivablesDto;

  @ApiProperty({ type: () => DashboardBelowMinimumDto })
  belowMinimum!: DashboardBelowMinimumDto;
}
