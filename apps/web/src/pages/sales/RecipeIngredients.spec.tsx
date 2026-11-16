// @vitest-environment jsdom
/**
 * The recipe ingredients panel of a draft invoice (ADR-032 §12): a shortage and a
 * missing formula are said in plain words, and a line with a formula lists its
 * components with what the warehouse holds.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RecipePreviewDto } from '@erp/api-client';
import i18n from '../../i18n';
import { RecipePreviewView } from './RecipeIngredients';

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
  await i18n.changeLanguage('ar');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

type Component = RecipePreviewDto['lines'][number]['components'][number];

const component = (over: Partial<Component> = {}): Component => ({
  componentItemId: '11',
  code: 'FL-1',
  nameAr: 'دقيق',
  qtyBase: '2',
  onHandBase: '5',
  shortageBase: '0',
  ...over,
});

const preview = (over: Partial<RecipePreviewDto> = {}): RecipePreviewDto => ({
  invoiceId: '9',
  warehouseId: '1',
  hasWarnings: false,
  hasShortage: false,
  lines: [{ lineId: '100', lineNo: 1, itemId: '50', itemCode: 'MEAL-1', qtyBase: '1', bomMissing: false, components: [component()] }],
  ...over,
});

function render(p: RecipePreviewDto): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RecipePreviewView preview={p} />));
  return host;
}

describe('RecipePreviewView (ADR-032 §12)', () => {
  it('lists the components of a recipe line with the quantity needed and on hand', () => {
    const el = render(preview());
    expect(el.textContent).toContain('MEAL-1');
    expect(el.textContent).toContain('FL-1');
    expect(el.textContent).toContain('دقيق');
    expect(el.textContent).not.toContain(i18n.t('sales.recipe.shortWarning'));
  });

  it('marks a component short of stock and warns that the invoice may not post', () => {
    const el = render(
      preview({
        hasShortage: true,
        lines: [{ lineId: '100', lineNo: 1, itemId: '50', itemCode: 'MEAL-1', qtyBase: '1', bomMissing: false, components: [component({ onHandBase: '1', shortageBase: '1' })] }],
      }),
    );
    expect(el.textContent).toContain(i18n.t('sales.recipe.shortWarning'));
    expect(el.textContent).toContain(i18n.t('sales.recipe.short'));
  });

  it('flags a recipe with no formula in the warning colour, with no component table', () => {
    const el = render(
      preview({
        hasWarnings: true,
        lines: [{ lineId: '100', lineNo: 1, itemId: '50', itemCode: 'MEAL-1', qtyBase: '1', bomMissing: true, components: [] }],
      }),
    );
    expect(el.textContent).toContain(i18n.t('sales.recipe.bomMissing'));
    expect(el.textContent).toContain(i18n.t('sales.recipe.bomMissingWarning'));
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelector('.ant-alert-warning')).not.toBeNull();
  });
});
