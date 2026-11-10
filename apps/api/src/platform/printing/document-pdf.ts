import { FONT_NAME } from './fonts.js';
import { formatAmount, formatQty } from './format.js';
import { paragraph } from './pdf-text.js';
import { footer, headerBlock, L, PALETTE, type PrintContext, type ReportColumn, type ReportRow } from './report-table.js';

/**
 * A printed business document (BUILD_PLAN §13.7): sales invoice, return,
 * purchase invoice, receipt / payment voucher. Arabic RTL (English
 * optional), the company header with its tax number, the e-invoice QR when
 * JoFotara accepted it, and a clear banner while it has not (§12.4).
 */
export interface DocumentPrint {
  title: string;
  docNo: string | null;
  status: 'DRAFT' | 'POSTED';
  /** Header fields, shown two per row. */
  fields: { label: string; value: string | null | undefined }[];
  lines?: { columns: ReportColumn[]; rows: ReportRow[] };
  /** Amount summary under the lines (net, tax, total …). */
  totals?: { label: string; value: string; strong?: boolean }[];
  notes?: { label: string; value: string }[];
  /** JoFotara QR (only when ACCEPTED). */
  qr?: { payload: string; lines: string[] } | null;
  /** Shown in red above the lines and printed: e.g. not accepted by JoFotara yet. */
  banner?: string | null;
  signatures?: string[];
  fileName: string;
}

const PAGE_W = 595.28;
const MARGIN = 32;
const USABLE = PAGE_W - 2 * MARGIN;

export function documentPdf(doc: DocumentPrint, ctx: PrintContext): object {
  const rtl = ctx.lang === 'ar';
  const base = rtl ? 'rtl' : 'ltr';
  const align = rtl ? 'right' : 'left';
  const half = USABLE / 2 - 6;

  const titleMeta = [
    `${L(ctx, 'رقم المستند', 'Document no.')}: ${doc.docNo ?? L(ctx, 'مسودة', 'Draft')}`,
  ];

  // Header fields: label: value, two per row, first field on the right in Arabic.
  const fieldCell = (f: DocumentPrint['fields'][number] | undefined) =>
    f
      ? {
          stack: [
            paragraph(f.label, { width: half - 8, size: 8, base, align, color: '#555555' }),
            paragraph(f.value ?? '—', { width: half - 8, size: 10, bold: true, base, align }),
          ],
          fillColor: PALETTE.panel,
        }
      : { text: '', fillColor: PALETTE.panel };
  const fieldRows: object[][] = [];
  for (let i = 0; i < doc.fields.length; i += 2) {
    const pair = [fieldCell(doc.fields[i]), fieldCell(doc.fields[i + 1])];
    fieldRows.push(rtl ? pair.reverse() : pair);
  }

  const content: object[] = [...headerBlock(ctx, doc.title, titleMeta, USABLE)];
  if (doc.banner) {
    content.push({
      table: {
        widths: [USABLE],
        body: [[{ ...paragraph(doc.banner, { width: USABLE - 12, size: 10, bold: true, base, align, color: '#a8071a' }), fillColor: '#fff1f0' }]],
      },
      layout: { hLineColor: () => '#ffa39e', vLineColor: () => '#ffa39e', hLineWidth: () => 0.8, vLineWidth: () => 0.8 },
      margin: [0, 0, 0, 8],
    });
  }
  if (fieldRows.length) {
    content.push({
      table: { widths: [half, half], body: fieldRows },
      layout: {
        hLineColor: () => PALETTE.line,
        vLineColor: () => PALETTE.line,
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
        paddingTop: () => 3,
        paddingBottom: () => 3,
      },
      margin: [0, 0, 0, 10],
    });
  }

  if (doc.lines) {
    const cols = doc.lines.columns;
    const fixed = cols.map((c) => c.width ?? (c.kind === 'amount' ? 66 : c.kind === 'qty' ? 50 : c.kind === 'int' ? 26 : 0));
    const free = fixed.filter((w) => w === 0).length || 1;
    // pdfmake adds each cell's padding (4 + 4) and rules to these widths.
    const inner = USABLE - cols.length * 9;
    const rest = Math.max(inner - fixed.reduce((s, w) => s + w, 0), 80);
    const widths = fixed.map((w) => (w === 0 ? rest / free : w));
    const order = cols.map((_, i) => i);
    if (rtl) order.reverse();
    const cell = (c: ReportColumn, w: number, v: unknown, bold = false) => {
      const kind = c.kind ?? 'text';
      if (kind === 'text') return paragraph(v === null || v === undefined ? '' : String(v), { width: w - 8, base, bold });
      const s = v === null || v === undefined || v === '' ? '' : kind === 'amount' ? formatAmount(String(v)) : kind === 'qty' ? formatQty(String(v)) : String(v);
      return { text: s, alignment: 'right', noWrap: true, bold };
    };
    content.push({
      table: {
        headerRows: 1,
        widths: order.map((i) => widths[i]),
        body: [
          order.map((i) => ({
            ...paragraph(cols[i].label, { width: widths[i] - 8, bold: true, base, align: (cols[i].kind ?? 'text') === 'text' ? align : 'right' }),
            fillColor: PALETTE.bar,
          })),
          ...doc.lines.rows.map((r) => order.map((i) => cell(cols[i], widths[i], r[cols[i].key], Boolean(r._bold)))),
        ],
      },
      layout: {
        hLineColor: () => PALETTE.line,
        vLineColor: () => PALETTE.line,
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
        paddingTop: () => 2,
        paddingBottom: () => 2,
      },
      margin: [0, 0, 0, 8],
    });
  }

  // Totals on the reading-end side, QR on the other.
  const totalsBlock = doc.totals?.length
    ? {
        width: 220,
        table: {
          widths: [120, 100],
          body: doc.totals.map((t) => {
            const label = { ...paragraph(t.label, { width: 112, bold: t.strong, base, align }), fillColor: t.strong ? PALETTE.bar : PALETTE.panel };
            const value = { text: formatAmount(t.value), alignment: 'right', bold: t.strong, fillColor: t.strong ? PALETTE.bar : undefined };
            return rtl ? [value, label] : [label, value];
          }),
        },
        layout: { hLineColor: () => PALETTE.line, vLineColor: () => PALETTE.line, hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
      }
    : { width: 220, text: '' };
  const qrBlock = doc.qr
    ? {
        width: '*',
        columns: [
          { qr: doc.qr.payload, fit: 110, width: 116 },
          { width: '*', stack: doc.qr.lines.map((l) => paragraph(l, { width: 150, size: 7.5, base, align: 'left', color: '#444444' })) },
        ],
        columnGap: 6,
      }
    : { width: '*', text: '' };
  content.push({ columns: rtl ? [qrBlock, totalsBlock] : [totalsBlock, qrBlock], columnGap: 12, margin: [0, 4, 0, 10] });

  for (const n of doc.notes ?? []) {
    content.push(paragraph(`${n.label}: ${n.value}`, { width: USABLE, base, align, size: 9 }));
  }
  if (doc.signatures?.length) {
    const w = USABLE / doc.signatures.length;
    const sigs = doc.signatures.map((s) => ({
      stack: [
        { canvas: [{ type: 'line', x1: 10, y1: 30, x2: w - 10, y2: 30, lineWidth: 0.5, lineColor: PALETTE.border }] },
        paragraph(s, { width: w - 20, size: 8, base, align: 'center', color: '#555555' }),
      ],
    }));
    content.push({ columns: rtl ? sigs.reverse() : sigs, margin: [0, 24, 0, 0] });
  }

  return {
    pageSize: 'A4',
    pageMargins: [MARGIN, MARGIN, MARGIN, 40],
    defaultStyle: { font: FONT_NAME, fontSize: 9, color: PALETTE.text },
    info: { title: `${doc.title} ${doc.docNo ?? ''}`.trim(), creator: 'ERP Cloud' },
    ...(doc.status === 'DRAFT' ? { watermark: { text: L(ctx, 'مسودة', 'DRAFT'), opacity: 0.08, bold: true, fontSize: 90 } } : {}),
    footer: footer(ctx),
    content,
  };
}
