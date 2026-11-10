import { validate } from 'jofotara-kit';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { computeLineAmounts } from '../shared/invoice-math.js';
import { renderUbl, totalsOf, typeName, type UblDocument, type UblLine } from './ubl-render.js';

const seller = { taxNumber: '12345678', name: 'شركة الاختبار', incomeSourceSequence: '1234567' };
const buyer = { scheme: 'TN' as const, id: '87654321', name: 'عميل & شركاه <ذ.م.م>', phone: '0790000000' };

/** A line as the ERP posts it: per-line amounts rounded to 3 decimals (invoice-math). */
function line(id: number, qty: string, price: string, discountPct: string, rate: string, category: 'S' | 'Z' | 'O'): UblLine {
  const a = computeLineAmounts({ qty, factorToBase: 1, unitPrice: price, discountPct, taxRate: rate });
  return {
    id,
    name: `صنف ${id}`,
    quantity: new Decimal(qty),
    unitPrice: new Decimal(price),
    discount: a.discountAmount,
    extension: a.netAmount,
    category,
    rate: new Decimal(rate),
    tax: a.taxAmount,
  };
}

const invoice = (over: Partial<UblDocument> = {}): UblDocument => ({
  kind: 'invoice',
  track: 'GENERAL_SALES',
  paymentTerms: 'receivable',
  id: 'SI-2025-000001',
  uuid: '6f1c1d8a-3a52-4d6a-9d5e-1f2a3b4c5d6e',
  issueDate: '2025-03-10',
  icv: 1,
  seller,
  buyer,
  lines: [
    line(1, '3', '2.500', '10', '16', 'S'),
    line(2, '1.25', '7.333', '0', '16', 'S'), // tax 1.466640 → 1.467 (rounded per line)
    line(3, '2', '0.750', '0', '0', 'Z'),
    line(4, '1', '4.000', '5', '0', 'O'),
  ],
  ...over,
});

function errorsOf(xml: string) {
  const report = validate(xml);
  return report.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule}: ${f.message}`);
}

describe('JoFotara UBL renderer', () => {
  it('a general-sales receivable invoice (S, Z and O lines) passes the validator', () => {
    const doc = invoice();
    const xml = renderUbl(doc);
    expect(errorsOf(xml)).toEqual([]);
    expect(xml).toContain('<cbc:InvoiceTypeCode name="022">388</cbc:InvoiceTypeCode>');
    // Escaped, never raw markup from data.
    expect(xml).toContain('عميل &amp; شركاه &lt;ذ.م.م&gt;');
    // The posted (per-line rounded) amounts are written as they are.
    expect(xml).toContain('<cbc:TaxAmount currencyID="JO">1.467</cbc:TaxAmount>');
  });

  it('totals follow the manual: exclusive = Σ qty × price; payable = Σ net + Σ tax', () => {
    const t = totalsOf(invoice().lines);
    expect(t.allowance.toFixed(3)).toBe('0.950'); // 0.750 + 0.200
    expect(t.taxExclusive.toFixed(3)).toBe('22.166'); // 7.500 + 9.166 + 1.500 + 4.000
    expect(t.tax.toFixed(3)).toBe('2.547'); // 1.080 + 1.467
    expect(t.payable.toFixed(3)).toBe('23.763'); // 21.216 net + 2.547 tax
  });

  it('a cash invoice is 012; an income-track invoice is 011 and has no tax blocks', () => {
    expect(typeName({ track: 'GENERAL_SALES', paymentTerms: 'cash' })).toBe('012');
    const income = invoice({
      track: 'INCOME',
      paymentTerms: 'cash',
      lines: [line(1, '2', '5.000', '0', '0', 'Z'), line(2, '1', '3.000', '10', '0', 'Z')].map((l) => ({
        ...l,
        tax: new Decimal(0),
      })),
    });
    const xml = renderUbl(income);
    expect(errorsOf(xml)).toEqual([]);
    expect(xml).toContain('name="011"');
    expect(xml).not.toContain('<cac:TaxTotal>');
  });

  it('a partial general-sales return carries the return-only fields and passes', () => {
    const original = invoice();
    const ret: UblDocument = {
      ...original,
      kind: 'credit-note',
      id: 'SR-2025-000001',
      uuid: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      icv: 2,
      // Line 1 partly (1 of 3) and line 3: original line numbers, prices and rates.
      lines: [line(1, '1', '2.500', '10', '16', 'S'), line(3, '2', '0.750', '0', '0', 'Z')],
      billingReference: { id: original.id, uuid: original.uuid, total: totalsOf(original.lines).payable },
      reason: 'إرجاع من العميل',
    };
    const xml = renderUbl(ret);
    expect(errorsOf(xml)).toEqual([]);
    expect(xml).toContain('<cbc:InvoiceTypeCode name="022">381</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>');
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="JO">0.000</cbc:PrepaidAmount>');
    expect(xml).toContain('<cbc:DocumentDescription>23.763</cbc:DocumentDescription>');
  });

  it('a walk-in cash buyer (TN 0) passes', () => {
    const xml = renderUbl(invoice({ paymentTerms: 'cash', buyer: { scheme: 'TN', id: '0', name: 'Cash customer' } }));
    expect(errorsOf(xml)).toEqual([]);
  });
});
