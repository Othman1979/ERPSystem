// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { formatAmount } from '../format/number';
import { InvoiceLinesGrid } from './InvoiceLinesGrid';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('./CompanyProfileForm', () => ({ useCompany: () => ({ data: { pricesIncludeTax: false } }) }));

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

describe('invoice grid server preview', () => {
  it('shows server-computed line and document totals instead of local estimates', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
      <InvoiceLinesGrid
        lines={[{ key: 1, itemId: '1', qty: '1', price: '1.000', discountPct: '0' }]}
        onChange={() => undefined}
        itemOptions={[{ id: '1', label: 'Item', price: '1.000', taxRate: '0', itemKind: 'STOCK' }]}
        serverPreviewRequired
        serverAmounts={[{ netAmount: '0.821', taxAmount: '0.131', lineTotal: '0.952' }]}
        serverSummary={{
          subtotal: '1.000',
          lineDiscountAmount: '0.000',
          invoiceDiscountAmount: '0.048',
          netTotal: '0.821',
          taxTotal: '0.131',
          grandTotal: '0.952',
        }}
      />,
    ));
    expect(host.textContent).toContain(formatAmount('0.821'));
    expect(host.textContent).toContain(formatAmount('0.131'));
    expect(host.textContent).toContain(formatAmount('0.952'));
    expect(host.textContent).toContain('Invoice discount');
    expect(host.textContent).toContain(formatAmount('0.048'));
    expect(host.textContent).not.toContain(formatAmount('1.000') + formatAmount('0.000'));
  });
});
