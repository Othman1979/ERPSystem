import ExcelJS from 'exceljs';
import { FONT_NAME } from './fonts.js';
import { formatAmount, formatQty, toExcelNumber } from './format.js';
import { paragraph } from './pdf-text.js';
import { ltr } from './rtl-text.js';

/**
 * One model for every report export (BUILD_PLAN §15 "?format=json|pdf|xlsx"):
 * each report maps its JSON to a ReportTable, and this file turns it into an
 * A4 PDF (pdfmake, Arabic-safe) or an XLSX sheet (exceljs, RTL in Arabic).
 */
export type ColumnKind = 'text' | 'amount' | 'qty' | 'date' | 'int';

export interface ReportColumn {
  key: string;
  label: string;
  kind?: ColumnKind;
  /** Points in the PDF; text columns share what is left when omitted. */
  width?: number;
}

export type Cell = string | number | null | undefined;
export interface ReportRow {
  [key: string]: Cell | boolean | undefined;
  /** Bold row (group totals). */
  _bold?: boolean;
  /** Indent level of the first text column (account tree). */
  _indent?: number;
}

export interface ReportTable {
  title: string;
  /** Lines under the title: period, filters, "as of". */
  meta?: string[];
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Footer rows (totals), bold on a grey band. */
  totals?: ReportRow[];
  orientation?: 'portrait' | 'landscape';
  /** File name without extension. */
  fileName: string;
}

export interface PrintContext {
  lang: 'ar' | 'en';
  company: { name: string; taxNumber: string | null; address: string | null; phone: string | null };
  printedAt: Date;
}

/** The owner's grid palette (theme.ts / index.css). */
export const PALETTE = { bar: '#D3DCE3', panel: '#EEEEEE', line: '#C0C0C0', border: '#AAAAAA', text: '#1B2A36' };

const PAGE = { portrait: 595.28, landscape: 841.89 };
const MARGIN = 28;
const CELL_PAD = 8;
const DEFAULT_WIDTH: Record<ColumnKind, number> = { text: 0, amount: 74, qty: 60, date: 62, int: 38 };

export const L = (ctx: Pick<PrintContext, 'lang'>, ar: string, en: string) => (ctx.lang === 'ar' ? ar : en);

function cellText(kind: ColumnKind, v: Cell): string {
  if (v === null || v === undefined || v === '') return '';
  if (kind === 'amount') return formatAmount(String(v));
  if (kind === 'qty') return formatQty(String(v));
  return String(v);
}

function widthsFor(table: ReportTable): number[] {
  const page = PAGE[table.orientation ?? (table.columns.length > 7 ? 'landscape' : 'portrait')];
  // pdfmake widths are content widths: each cell adds its padding and the grid its 0.5pt lines.
  const usable = page - 2 * MARGIN - table.columns.length * CELL_PAD - (table.columns.length + 1) * 0.5;
  const fixed = table.columns.map((c) => c.width ?? DEFAULT_WIDTH[c.kind ?? 'text']);
  const free = table.columns.filter((c, i) => fixed[i] === 0).length;
  const rest = Math.max(usable - fixed.reduce((s, w) => s + w, 0), free * 60);
  return fixed.map((w) => (w === 0 ? rest / Math.max(free, 1) : w));
}

/** Header block shared by reports and documents: company, then the title and its lines. */
export function headerBlock(ctx: PrintContext, title: string, meta: string[], width: number): object[] {
  const align = ctx.lang === 'ar' ? 'right' : 'left';
  const base = ctx.lang === 'ar' ? 'rtl' : 'ltr';
  const companyLine = [
    // Numbers with spaces or a "+" stay one left-to-right unit inside Arabic.
    ctx.company.taxNumber ? `${L(ctx, 'الرقم الضريبي', 'Tax no.')}: ${ltr(ctx.company.taxNumber)}` : '',
    ctx.company.phone ? ltr(ctx.company.phone) : '',
  ]
    .filter(Boolean)
    .join('   ');
  return [
    paragraph(ctx.company.name, { width, size: 13, bold: true, align, base }),
    ...(companyLine ? [paragraph(companyLine, { width, size: 8, align, base, color: '#555555' })] : []),
    ...(ctx.company.address ? [paragraph(ctx.company.address, { width, size: 8, align, base, color: '#555555' })] : []),
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: width, y2: 4, lineWidth: 0.6, lineColor: PALETTE.border }], margin: [0, 2, 0, 6] },
    paragraph(title, { width, size: 14, bold: true, align, base }),
    ...meta.map((m) => paragraph(m, { width, size: 9, align, base, color: '#333333' })),
    { text: '', margin: [0, 0, 0, 6] },
  ];
}

export function footer(ctx: PrintContext) {
  const printed = ctx.printedAt.toISOString().slice(0, 16).replace('T', ' ');
  return (page: number, pages: number) => ({
    columns: [
      { text: `${page} / ${pages}`, alignment: ctx.lang === 'ar' ? 'left' : 'right', fontSize: 8, color: '#777777' },
      paragraph(`${L(ctx, 'طُبع في', 'Printed')} ${printed} UTC`, {
        width: 260,
        size: 8,
        align: ctx.lang === 'ar' ? 'right' : 'left',
        base: ctx.lang === 'ar' ? 'rtl' : 'ltr',
        color: '#777777',
      }),
    ],
    margin: [MARGIN, 10, MARGIN, 0],
  });
}

/** pdfmake document definition for a report table. */
export function tablePdf(table: ReportTable, ctx: PrintContext): object {
  const orientation = table.orientation ?? (table.columns.length > 7 ? 'landscape' : 'portrait');
  const usable = PAGE[orientation] - 2 * MARGIN;
  const widths = widthsFor({ ...table, orientation });
  const rtl = ctx.lang === 'ar';
  const order = table.columns.map((_, i) => i);
  if (rtl) order.reverse(); // first column on the right

  const textCell = (col: ReportColumn, w: number, v: Cell, bold: boolean, indent = 0) => {
    const kind = col.kind ?? 'text';
    const text = cellText(kind, v);
    if (kind === 'text') {
      const pad = indent * 10;
      const p = paragraph(text, { width: w - CELL_PAD - pad, bold, base: rtl ? 'rtl' : 'ltr' });
      return { ...p, margin: rtl ? [0, 0, pad, 0] : [pad, 0, 0, 0] };
    }
    // Numbers right-aligned in both languages so decimals line up (§16).
    return { text, alignment: 'right', bold, noWrap: true };
  };

  const header = order.map((i) => ({
    ...paragraph(table.columns[i].label, {
      width: widths[i] - CELL_PAD,
      bold: true,
      align: (table.columns[i].kind ?? 'text') === 'text' ? (rtl ? 'right' : 'left') : 'right',
      base: rtl ? 'rtl' : 'ltr',
    }),
    fillColor: PALETTE.bar,
  }));
  const body = table.rows.map((r) =>
    order.map((i, pos) =>
      textCell(table.columns[i], widths[i], r[table.columns[i].key] as Cell, Boolean(r._bold), pos === (rtl ? order.length - 1 : 0) ? (r._indent ?? 0) : 0),
    ),
  );
  const totals = (table.totals ?? []).map((r) =>
    order.map((i) => ({ ...textCell(table.columns[i], widths[i], r[table.columns[i].key] as Cell, true), fillColor: PALETTE.panel })),
  );

  return {
    pageSize: 'A4',
    pageOrientation: orientation,
    pageMargins: [MARGIN, MARGIN, MARGIN, 40],
    defaultStyle: { font: FONT_NAME, fontSize: 9, color: PALETTE.text },
    info: { title: table.title, creator: 'ERP Cloud' },
    footer: footer(ctx),
    content: [
      ...headerBlock(ctx, table.title, table.meta ?? [], usable),
      {
        table: {
          headerRows: 1,
          widths: order.map((i) => widths[i]),
          body: [header, ...(body.length ? body : [order.map(() => ({ text: '' }))]), ...totals],
        },
        layout: {
          hLineColor: () => PALETTE.line,
          vLineColor: () => PALETTE.line,
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          paddingLeft: () => CELL_PAD / 2,
          paddingRight: () => CELL_PAD / 2,
          paddingTop: () => 2,
          paddingBottom: () => 2,
        },
      },
    ],
  };
}

/** Excel sheet names: at most 31 characters, none of * ? : \ / [ ] (file names carry free-text codes). */
export function sheetName(name: string): string {
  const clean = name.replace(/[*?:\\/[\]]+/g, '-').replace(/^'+|'+$/g, '').slice(0, 31).trim();
  return clean || 'report';
}

/** XLSX workbook for a report table: one sheet, right-to-left in Arabic, numbers as numbers. */
export async function tableXlsx(table: ReportTable, ctx: PrintContext): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ERP Cloud';
  wb.created = ctx.printedAt;
  const ws = wb.addWorksheet(sheetName(table.fileName), {
    views: [{ rightToLeft: ctx.lang === 'ar', state: 'frozen', ySplit: 0 }],
    pageSetup: { paperSize: 9, orientation: table.orientation ?? 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.addRow([ctx.company.name]).font = { bold: true, size: 13 };
  ws.addRow([table.title]).font = { bold: true, size: 12 };
  for (const m of table.meta ?? []) ws.addRow([m]);
  ws.addRow([]);
  const headerRow = ws.addRow(table.columns.map((c) => c.label));
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3DCE3' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFAAAAAA' } } };
  });
  ws.views = [{ rightToLeft: ctx.lang === 'ar', state: 'frozen', ySplit: headerRow.number }];

  const write = (r: ReportRow, bold: boolean) => {
    const row = ws.addRow(
      table.columns.map((c) => {
        const v = r[c.key] as Cell;
        const kind = c.kind ?? 'text';
        if (kind === 'amount' || kind === 'qty' || kind === 'int') return toExcelNumber(v === undefined ? null : String(v ?? ''));
        return v ?? null;
      }),
    );
    table.columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.kind === 'amount') cell.numFmt = '#,##0.000';
      if (c.kind === 'qty') cell.numFmt = '#,##0.######';
      if ((c.kind ?? 'text') === 'text' && i === 0 && r._indent) cell.alignment = { indent: r._indent };
    });
    if (bold || r._bold) row.font = { bold: true };
    return row;
  };
  for (const r of table.rows) write(r, false);
  for (const t of table.totals ?? []) {
    const row = write(t, true);
    row.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } }));
  }
  table.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.kind === 'text' || !c.kind ? 34 : c.kind === 'date' ? 12 : c.kind === 'int' ? 8 : 16;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
