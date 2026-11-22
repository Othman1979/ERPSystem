// @vitest-environment jsdom
/**
 * The consumption table (ADR-032 §3): every item of the report with its opening,
 * receipts, closing, actual and the recorded split; a variance that is not zero
 * is in the warning colour; the value totals are shown under the table.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ConsumptionReportDto, ConsumptionRowDto } from '@erp/api-client';
import i18n from '../../i18n';
import { ConsumptionTable } from './ConsumptionTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const row = (over: Partial<ConsumptionRowDto>): ConsumptionRowDto => ({
  itemId: '11',
  code: 'FLOUR',
  nameAr: 'دقيق',
  nameEn: 'Flour',
  avgCost: '0.500000',
  openingCounted: '10',
  receipts: '5',
  closingCounted: '4',
  actual: '11',
  recorded: '9',
  recipeOut: '6',
  directSales: '2',
  otherOut: '1',
  variance: '2',
  actualValue: '5.500',
  recordedValue: '4.500',
  varianceValue: '1.000',
  ...over,
});

const report = (rows: ConsumptionRowDto[]): ConsumptionReportDto => ({
  warehouseId: '1',
  fromCount: { id: '7', countDate: '2026-11-01' },
  toCount: { id: '8', countDate: '2026-11-10' },
  rows,
  totals: { actualValue: '5.500', recordedValue: '4.500', varianceValue: '1.000' },
});

function render(data: ConsumptionReportDto): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ConsumptionTable report={data} />));
  return host;
}

describe('ConsumptionTable (ADR-032 §3)', () => {
  it('shows each item with the counts, the receipts, the actual and the recorded split', () => {
    const el = render(report([row({})]));
    const cells = [...el.querySelectorAll('tbody td')].map((td) => td.textContent?.trim());
    expect(cells).toContain('FLOUR');
    expect(cells).toContain('Flour');
    // Opening 10, receipts 5, closing 4, actual 11, then recipes 6, direct 2, other 1, recorded 9.
    for (const v of ['10', '5', '4', '11', '6', '2', '1', '9']) expect(cells).toContain(v);
  });

  it('marks a variance that is not zero in the warning colour, and leaves a zero one plain', () => {
    const el = render(report([row({}), row({ itemId: '12', code: 'SUGAR', variance: '0', varianceValue: '0' })]));
    const warnings = el.querySelectorAll('.ant-typography-warning');
    expect(warnings.length).toBeGreaterThan(0);
    const sugarRow = [...el.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('SUGAR'));
    expect(sugarRow?.querySelector('.ant-typography-warning')).toBeNull();
  });

  it('shows the value totals under the table', () => {
    const el = render(report([row({})]));
    expect(el.textContent).toContain(i18n.t('reports.consumption.actual'));
    expect(el.textContent).toContain('5.500');
    expect(el.textContent).toContain('4.500');
  });
});
