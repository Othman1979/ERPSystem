/**
 * Benchmark: render a sales-invoice PDF with N lines (Arabic and English)
 * through the same path PrintingService uses (salesInvoicePrint → documentPdf
 * → pdfmake). No database.
 *
 *   pnpm --filter api exec tsx scripts/bench-pdf.mts [lines ...] [--runs=3] [--out=<dir>]
 *
 * Prints cold (first call in the process) and warm timings, page count and
 * size. With --out=<dir>, writes the PDFs there for a visual check.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Decimal } from '../src/common/decimal/decimal.utils.js';
import { documentPdf } from '../src/platform/printing/document-pdf.js';
import { renderPdf } from '../src/platform/printing/pdf-render.js';
import type { PrintContext } from '../src/platform/printing/report-table.js';
import { salesInvoicePrint } from '../src/platform/sales/sales.print.js';

const args = process.argv.slice(2);
const sizes = args.filter((a) => /^\d+$/.test(a)).map(Number);
const runs = Number(args.find((a) => a.startsWith('--runs='))?.slice(7) ?? 3);
const outDir = args.find((a) => a.startsWith('--out='))?.slice(6);
if (outDir) mkdirSync(outDir, { recursive: true });

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

function ctx(lang: 'ar' | 'en'): PrintContext {
  return {
    lang,
    company: { name: 'شركة النور للتجارة', taxNumber: '987654321', address: 'عمّان — شارع الجامعة', phone: '0799999999' },
    printedAt: new Date('2025-03-10T10:00:00Z'),
    timeZone: 'Asia/Amman',
  };
}

const ms = (t: number) => `${t.toFixed(0)} ms`;
const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

for (const lang of ['ar', 'en'] as const) {
  for (const n of sizes.length ? sizes : [10, 200, 1000]) {
    const times: { build: number; render: number }[] = [];
    let buf = Buffer.alloc(0);
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      const def = documentPdf(salesInvoicePrint(invoice(n), lang), ctx(lang));
      const t1 = performance.now();
      buf = await renderPdf(def);
      const t2 = performance.now();
      times.push({ build: t1 - t0, render: t2 - t1 });
    }
    const fmt = times.map((t) => `${ms(t.build + t.render)} (build ${ms(t.build)}, render ${ms(t.render)})`).join(' | ');
    console.log(`${lang} ${String(n).padStart(4)} lines: ${pages(buf)} pages, ${(buf.length / 1024).toFixed(0)} KB — ${fmt}`);
    if (outDir) writeFileSync(path.join(outDir, `invoice-${lang}-${n}.pdf`), buf);
  }
}
