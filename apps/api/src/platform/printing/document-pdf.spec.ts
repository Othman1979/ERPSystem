import { Decimal } from '../../common/decimal/decimal.utils.js';
import { salesInvoicePrint } from '../sales/sales.print.js';
import { documentPdf } from './document-pdf.js';
import { renderPdf } from './pdf-render.js';
import type { PrintContext } from './report-table.js';
import { woffStats } from './woff.js';

/**
 * A 200-line sales invoice used to take ~5 s in the request thread
 * (TRADE-21): every document re-decompressed the WOFF fonts with a pure-JS
 * inflate. Fonts are now unwrapped once per process (woff.ts), so a render
 * costs about 0.3 s locally. Timings flake on loaded runners, so the lock is
 * structural: the unwrap count must not grow across renders. The time bound
 * is only a loose sanity check.
 */
const D = (v: string) => new Decimal(v);

function invoice(n: number) {
  return {
    invoiceNo: 'SI-2025-000123',
    invoiceDate: new Date('2025-03-10'),
    dueDate: new Date('2025-04-10'),
    paymentType: 'CREDIT' as const,
    status: 'POSTED' as const,
    description: null,
    netTotal: D('1000.000'),
    taxTotal: D('160.000'),
    grandTotal: D('1160.000'),
    customer: { code: 'C-001', nameAr: 'شركة الأفق للتجارة العامة', nameEn: 'Horizon Trading Co.', taxNumber: '123456789', phone: '0791234567' },
    warehouse: { nameAr: 'المستودع الرئيسي', nameEn: 'Main warehouse' },
    lines: Array.from({ length: n }, (_, i) => ({
      lineNo: i + 1,
      qty: D(String(1 + (i % 7))),
      unitPrice: D(`${10 + (i % 13)}.500`),
      discountAmount: D('0.250'),
      taxAmount: D('1.680'),
      lineTotal: D(`${(i % 90) + 12}.345`),
      item: { code: `ITM-${String(i + 1).padStart(4, '0')}`, nameAr: i % 5 === 0 ? 'قطعة غيار للمحرك الرئيسي — طراز (2025) مع ملحقات إضافية وتركيب' : `صنف رقم ${i + 1} (Part ${i + 1})` },
      itemUnit: { unit: { nameAr: i % 2 ? 'قطعة' : 'كرتونة' } },
    })),
    einvoice: null,
  };
}

const ctx = (lang: 'ar' | 'en'): PrintContext => ({
  lang,
  company: { name: 'شركة النور للتجارة', taxNumber: '987654321', address: 'عمّان', phone: '0799999999' },
  printedAt: new Date('2025-03-10T10:00:00Z'),
  timeZone: 'Asia/Amman',
});

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const render = (n: number, lang: 'ar' | 'en') => renderPdf(documentPdf(salesInvoicePrint(invoice(n), lang), ctx(lang)));

describe('document PDFs', () => {
  beforeAll(async () => {
    // First render in a process pays one-off costs (unwrapping the fonts, module warm-up).
    await render(5, 'ar');
  }, 30_000);

  it.each(['ar', 'en'] as const)('a 200-line invoice (%s) keeps its shape without unwrapping fonts again', async (lang) => {
    const def = documentPdf(salesInvoicePrint(invoice(200), lang), ctx(lang));
    const unwrapsBefore = woffStats.unwraps;
    const started = performance.now();
    const pdf = await renderPdf(def);
    const took = performance.now() - started;

    // Regression guard (TRADE-21): no font work per document. Both fonts were unwrapped by the warm-up.
    expect(woffStats.unwraps).toBe(unwrapsBefore);
    expect(took).toBeLessThan(5_000);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // The font is embedded as a subset, from the unwrapped Buffer.
    expect(pdf.toString('latin1')).toMatch(/IBMPlexSansArabic/);
    // 200 rows with the header repeated on every page: about ten A4 pages.
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(9);
    expect(pageCount(pdf)).toBeLessThanOrEqual(11);
    // The definition carries the header row, every line, and the document number.
    const json = JSON.stringify(def);
    expect(json).toContain('SI-2025-000123');
    expect(json).toContain('ITM-0200');
  }, 30_000);

  it('fonts are unwrapped once per process, however many documents are rendered', async () => {
    const after = woffStats.unwraps;
    // The warm-up unwrapped exactly the two fonts (regular and bold).
    expect(after).toBe(2);
    const pdf = await render(10, 'ar');
    await render(10, 'en');
    expect(woffStats.unwraps).toBe(after);
    expect(pageCount(pdf)).toBe(1);
  }, 30_000);
});
