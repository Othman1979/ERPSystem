import type { CostCenterColumnDto, CostCenterSectionDto, IncomeStatementByCostCenterDto } from '@erp/api-client';
import { codeAndName, displayName } from '../../i18n/displayName';

/**
 * One line of the income-statement-by-centre table: a section heading, an
 * account with one amount per centre column, a section subtotal, or the net
 * profit footer. Amounts stay API strings; the table formats them.
 */
export type ByCentreRow =
  | { kind: 'heading'; key: string; label: string }
  | { kind: 'account'; key: string; code: string; label: string; amounts: string[]; total: string }
  | { kind: 'subtotal' | 'result'; key: string; label: string; amounts: string[]; total: string };

/** Translated labels the rows need (passed in so the builder stays a pure function). */
export interface ByCentreLabels {
  revenue: string;
  expenses: string;
  netRevenue: string;
  totalExpenses: string;
  netProfit: string;
}

function sectionRows(
  key: string,
  heading: string,
  section: CostCenterSectionDto,
  totalLabel: string,
  lang: string,
): ByCentreRow[] {
  return [
    { kind: 'heading', key: `${key}:h`, label: heading },
    ...section.rows.map(
      (r): ByCentreRow => ({
        kind: 'account',
        key: `${key}:${r.accountId}`,
        code: r.code,
        label: displayName({ nameAr: r.nameAr, nameEn: r.nameEn }, lang),
        amounts: r.amounts,
        total: r.total,
      }),
    ),
    { kind: 'subtotal', key: `${key}:t`, label: totalLabel, amounts: section.totals, total: section.total },
  ];
}

/** Revenue, expenses (cost of sales included) and the net profit footer, one amount per centre column. */
export function buildIncomeByCostCenterRows(
  data: IncomeStatementByCostCenterDto,
  labels: ByCentreLabels,
  lang: string,
): ByCentreRow[] {
  return [
    ...sectionRows('rev', labels.revenue, data.revenue, labels.netRevenue, lang),
    ...sectionRows('exp', labels.expenses, data.expenses, labels.totalExpenses, lang),
    {
      kind: 'result',
      key: 'net',
      label: labels.netProfit,
      amounts: data.netProfit.amounts,
      total: data.netProfit.total,
    },
  ];
}

/** Column header: "CODE — Name" of the centre, or the "no centre" label for the null column. */
export function columnTitle(column: CostCenterColumnDto, unassignedLabel: string, lang: string): string {
  if (!column.costCenterId) return unassignedLabel;
  return codeAndName({ code: column.code ?? '', nameAr: column.nameAr ?? '', nameEn: column.nameEn }, lang) ?? unassignedLabel;
}
