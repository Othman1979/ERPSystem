// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { InvoiceDiscountField, type InvoiceDiscountType } from './InvoiceDiscountField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = '';
});

describe('invoice discount field', () => {
  it('offers percentage and fixed-amount inputs with localized labels', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const props = {
      type: 'PERCENT' as InvoiceDiscountType,
      value: '10',
      onTypeChange: () => undefined,
      onValueChange: () => undefined,
    };
    act(() => root!.render(<InvoiceDiscountField {...props} />));
    expect(host.textContent).toContain('Percentage');
    expect(host.querySelectorAll('input')[1]?.getAttribute('aria-label')).toBe('Percentage');

    act(() => root!.render(<InvoiceDiscountField {...props} type="AMOUNT" value="2.500" />));
    expect(host.textContent).toContain('Fixed amount');
    expect(host.querySelectorAll('input')[1]?.getAttribute('aria-label')).toBe('Fixed amount');
  });
});
