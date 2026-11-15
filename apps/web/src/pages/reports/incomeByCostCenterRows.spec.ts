import type { CostCenterColumnDto, IncomeStatementByCostCenterDto } from '@erp/api-client';
import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { buildIncomeByCostCenterRows, columnTitle } from './incomeByCostCenterRows';

const LABELS = {
  revenue: 'Revenue',
  expenses: 'Expenses',
  netRevenue: 'Net revenue',
  totalExpenses: 'Total expenses',
  netProfit: 'Net profit',
};

const SALES: CostCenterColumnDto = { costCenterId: 'c1', code: 'CC1', nameAr: 'مبيعات', nameEn: 'Sales' };
const NONE: CostCenterColumnDto = { costCenterId: null, code: null, nameAr: null, nameEn: null };

const DATA: IncomeStatementByCostCenterDto = {
  from: '2026-01-01',
  to: '2026-12-31',
  fiscalYear: null,
  columns: [SALES, NONE],
  revenue: {
    rows: [
      { accountId: 'r1', code: '4101', nameAr: 'مبيعات', nameEn: 'Sales', amounts: ['1200.000', '50.000'], total: '1250.000' },
    ],
    totals: ['1200.000', '50.000'],
    total: '1250.000',
  },
  expenses: {
    rows: [
      { accountId: 'e1', code: '5101', nameAr: 'رواتب', nameEn: null, amounts: ['200.000', '0.000'], total: '200.000' },
    ],
    totals: ['200.000', '0.000'],
    total: '200.000',
  },
  netProfit: { amounts: ['1000.000', '50.000'], total: '1050.000' },
};

describe('buildIncomeByCostCenterRows', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('lays out headings, accounts, subtotals and the net profit footer in order', () => {
    const rows = buildIncomeByCostCenterRows(DATA, LABELS, 'en');
    expect(rows.map((r) => [r.kind, r.key])).toEqual([
      ['heading', 'rev:h'],
      ['account', 'rev:r1'],
      ['subtotal', 'rev:t'],
      ['heading', 'exp:h'],
      ['account', 'exp:e1'],
      ['subtotal', 'exp:t'],
      ['result', 'net'],
    ]);
  });

  it('carries the API amounts unchanged, one per column, with the totals', () => {
    const rows = buildIncomeByCostCenterRows(DATA, LABELS, 'en');
    const net = rows[rows.length - 1];
    expect(net).toMatchObject({ kind: 'result', label: 'Net profit', amounts: ['1000.000', '50.000'], total: '1050.000' });
    expect(rows[1]).toMatchObject({ kind: 'account', code: '4101', label: 'Sales', amounts: ['1200.000', '50.000'] });
  });

  it('falls back to the Arabic name when the English one is missing', () => {
    const rows = buildIncomeByCostCenterRows(DATA, LABELS, 'en');
    expect(rows[4]).toMatchObject({ kind: 'account', code: '5101', label: 'رواتب' });
    expect(buildIncomeByCostCenterRows(DATA, LABELS, 'ar')[1]).toMatchObject({ label: 'مبيعات' });
  });
});

describe('columnTitle', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows the centre as "CODE — Name" in the screen language', () => {
    expect(columnTitle(SALES, 'No centre', 'en')).toBe('CC1 — Sales');
    expect(columnTitle(SALES, 'بلا مركز', 'ar')).toBe('CC1 — مبيعات');
  });

  it('labels the null column with the "no centre" text', () => {
    expect(columnTitle(NONE, 'No centre', 'en')).toBe('No centre');
  });
});
