// @vitest-environment jsdom
/**
 * The cost card of an ACTIVE formula (ADR-032 §4): the margin is in the warning
 * colour when the price is below the cost, a missing price says so, and a component
 * with no cost is tagged.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BomCostCardDto } from '@erp/api-client';
import i18n from '../../i18n';
import { CostCardView, marginTone } from './BomCostCard';

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

const card = (over: Partial<BomCostCardDto> = {}): BomCostCardDto => ({
  bomId: '5',
  versionNo: 1,
  status: 'ACTIVE',
  isRecipe: true,
  outputQtyBase: '1',
  missingBom: false,
  zeroCostWarning: false,
  lines: [
    {
      componentItemId: '11',
      componentItem: { id: '11', code: 'FLOUR', nameAr: 'دقيق', nameEn: 'Flour', itemKind: 'STOCK', baseUnit: { id: '1', code: 'KG', nameAr: 'كغ', nameEn: null } },
      qtyBase: '0.200000',
      avgCost: '2.500000',
      totalCost: '0.500',
      zeroCost: false,
    },
  ],
  totalCost: '0.500',
  unitCost: '0.500000',
  salePrice: '1.200',
  pricesIncludeTax: false,
  salePriceNet: '1.000',
  margin: '0.500',
  marginPct: '50',
  ...over,
});

function render(data: BomCostCardDto): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<CostCardView card={data} />));
  return host;
}

describe('marginTone (ADR-032 §4)', () => {
  it('is danger only for a negative margin', () => {
    expect(marginTone('-0.250')).toBe('danger');
    expect(marginTone('0.500')).toBeUndefined();
    expect(marginTone('0')).toBeUndefined();
    expect(marginTone(null)).toBeUndefined();
  });
});

describe('CostCardView (ADR-032 §4)', () => {
  it('shows the cost per output unit, the net sale price, the margin and its percentage', () => {
    const el = render(card());
    expect(el.textContent).toContain(i18n.t('manufacturing.bom.costPerUnit'));
    expect(el.textContent).toContain('0.500');
    expect(el.querySelector('[data-testid="margin-value"]')?.textContent).toContain('0.500');
    expect(el.querySelector('[data-testid="margin-pct"]')?.textContent).toContain('50%');
    expect(el.querySelector('[data-testid="margin-value"]')?.classList.contains('ant-typography-danger')).toBe(false);
  });

  it('shows a negative margin in the danger colour with its words', () => {
    const el = render(card({ margin: '-0.200', marginPct: '-20' }));
    expect(el.querySelector('[data-testid="margin-value"]')?.classList.contains('ant-typography-danger')).toBe(true);
    expect(el.textContent).toContain(i18n.t('manufacturing.bom.negativeMargin'));
  });

  it('says there is no sale price and shows no margin when the item has none', () => {
    const el = render(card({ salePrice: null, salePriceNet: null, margin: null, marginPct: null }));
    expect(el.textContent).toContain(i18n.t('manufacturing.bom.noSalePrice'));
    expect(el.querySelector('[data-testid="margin-value"]')).toBeNull();
  });

  it('tags a component with no cost and warns about the understated total', () => {
    const el = render(
      card({
        zeroCostWarning: true,
        lines: [
          {
            componentItemId: '11',
            componentItem: { id: '11', code: 'FLOUR', nameAr: 'دقيق', nameEn: null, itemKind: 'STOCK', baseUnit: { id: '1', code: 'KG', nameAr: 'كغ', nameEn: null } },
            qtyBase: '1',
            avgCost: '0.000000',
            totalCost: '0.000',
            zeroCost: true,
          },
        ],
      }),
    );
    expect(el.textContent).toContain(i18n.t('manufacturing.bom.zeroCostTag'));
    expect(el.textContent).toContain(i18n.t('manufacturing.bom.zeroCostWarning'));
  });

  it('warns when a recipe inside the formula has no active formula', () => {
    const el = render(card({ missingBom: true }));
    expect(el.textContent).toContain(i18n.t('manufacturing.bom.missingBomWarning'));
  });
});
