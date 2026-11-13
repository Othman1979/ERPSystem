import ExcelJS from 'exceljs';
import { PrintingService } from './printing.service.js';
import { tablePdf, tableXlsx, wallClock, type PrintContext, type ReportTable } from './report-table.js';

const ctx: PrintContext = {
  lang: 'ar',
  company: { name: 'شركة الاختبار', taxNumber: null, address: null, phone: null },
  printedAt: new Date('2026-11-13T21:30:00Z'),
  timeZone: 'Asia/Amman',
};

describe('wallClock', () => {
  it('prints the wall clock of the company zone', () => {
    // Amman is UTC+3 in November 2026: 21:30 UTC is 00:30 the next day.
    expect(wallClock(new Date('2026-11-13T21:30:00Z'), 'Asia/Amman')).toBe('2026-11-14 00:30');
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(wallClock(new Date('2026-11-13T21:30:00Z'), 'Not/AZone')).toBe('2026-11-13 21:30');
  });
});

describe('tableXlsx date columns', () => {
  it('writes a date column as a real date cell', async () => {
    const table: ReportTable = {
      title: 'Dates',
      fileName: 'dates',
      columns: [{ key: 'date', label: 'Date', kind: 'date' }],
      rows: [{ date: '2025-03-10' }],
    };
    const buf = await tableXlsx(table, ctx);
    const wb = new ExcelJS.Workbook();
    // exceljs declares its load() input with another Buffer typing; the bytes are the same.
    await wb.xlsx.load(buf as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
    const cell = wb.worksheets[0].lastRow!.getCell(1);
    expect(cell.value).toEqual(new Date('2025-03-10T00:00:00.000Z'));
    expect(cell.numFmt).toBe('yyyy-mm-dd');
  });
});

describe('tablePdf', () => {
  type PdfDefinition = {
    content: { table?: { headerRows?: number } }[];
    footer: (page: number, pages: number) => unknown;
  };

  it('repeats the header row and numbers the pages', () => {
    const table: ReportTable = {
      title: 'T',
      fileName: 't',
      columns: [{ key: 'code', label: 'Code' }],
      rows: [{ code: 'A' }],
    };
    const def = tablePdf(table, ctx) as unknown as PdfDefinition;
    const grid = def.content.find((c) => c.table)!.table!;
    expect(grid.headerRows).toBe(1);
    expect(JSON.stringify(def.footer(2, 5))).toContain('2 / 5');
  });

  it('renders 10,000 rows to a PDF in under 30 seconds', async () => {
    const table: ReportTable = {
      title: 'Large statement',
      fileName: 'large',
      columns: [
        { key: 'code', label: 'Code', width: 60 },
        { key: 'name', label: 'Name' },
        { key: 'amount', label: 'Amount', kind: 'amount' },
      ],
      rows: Array.from({ length: 10_000 }, (_, i) => ({
        code: `A-${i}`,
        name: `صنف رقم ${i}`,
        amount: `${i}.500`,
      })),
    };
    const started = Date.now();
    const buf = await new PrintingService({} as never, {} as never).pdf(tablePdf(table, ctx));
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF');
  }, 60_000);
});
