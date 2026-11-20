import ExcelJS from 'exceljs';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { SHEET_IMPORT_MAX_BYTES, type UploadedSheet } from '../inventory/count-sheet-import.js';

const MAX_ROWS = 5000;

type ColumnKey = 'date' | 'description' | 'reference' | 'deposit' | 'withdrawal';

/** Header names the bank statement import accepts, in Arabic or English (ADR-035 §2). */
const HEADER_KEYS = new Map<string, ColumnKey>([
  ['التاريخ', 'date'],
  ['date', 'date'],
  ['البيان', 'description'],
  ['description', 'description'],
  ['المرجع', 'reference'],
  ['reference', 'reference'],
  ['إيداع', 'deposit'],
  ['ايداع', 'deposit'],
  ['deposit', 'deposit'],
  ['سحب', 'withdrawal'],
  ['withdrawal', 'withdrawal'],
]);

/** One sheet row as text; the service validates and converts it. */
export interface StatementImportRow {
  row: number;
  date: string;
  description: string;
  reference: string;
  deposit: string;
  withdrawal: string;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).trim();
  if (typeof value === 'object') {
    const v = value as { text?: unknown; richText?: { text: string }[]; result?: unknown };
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim();
    if (typeof v.text === 'string') return v.text.trim();
    if ('result' in v) return cellText(v.result);
  }
  return '';
}

/**
 * The rows of an uploaded bank statement (first worksheet). The header row is the
 * first of the first ten rows that names a date column; empty rows are skipped.
 */
export async function readStatementRows(file: UploadedSheet | undefined): Promise<StatementImportRow[]> {
  if (!file?.buffer?.length) throw new DomainError(ErrorCode.VALIDATION, 'A sheet file is required');
  if (!/\.xlsx$/i.test(file.originalname)) {
    throw new DomainError(ErrorCode.VALIDATION, 'The bank statement must be an .xlsx file');
  }
  if (file.size > SHEET_IMPORT_MAX_BYTES) {
    throw new DomainError(ErrorCode.UPLOAD_TOO_LARGE, 'The bank statement is larger than 5 MB', {
      maxBytes: SHEET_IMPORT_MAX_BYTES,
    });
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer as unknown as ArrayBuffer);
  } catch {
    throw new DomainError(ErrorCode.VALIDATION, 'The file is not a readable .xlsx workbook');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new DomainError(ErrorCode.VALIDATION, 'The workbook has no worksheet');

  let headerRow = 0;
  let columns: Partial<Record<ColumnKey, number>> = {};
  for (let r = 1; r <= Math.min(sheet.rowCount, 10) && headerRow === 0; r++) {
    const found: Partial<Record<ColumnKey, number>> = {};
    sheet.getRow(r).eachCell((cell, col) => {
      const key = HEADER_KEYS.get(cellText(cell.value).toLowerCase());
      if (key && found[key] === undefined) found[key] = col;
    });
    if (found.date !== undefined) {
      headerRow = r;
      columns = found;
    }
  }
  if (headerRow === 0 || (columns.deposit === undefined && columns.withdrawal === undefined)) {
    throw new DomainError(ErrorCode.VALIDATION, 'The sheet needs a date column and a deposit or withdrawal column', {
      errors: [{ row: 1, reason: 'MISSING_COLUMN: date, deposit, withdrawal' }],
    });
  }

  const rows: StatementImportRow[] = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const read = (key: ColumnKey) => {
      const col = columns[key];
      return col === undefined ? '' : cellText(row.getCell(col).value);
    };
    const entry = {
      row: r,
      date: read('date'),
      description: read('description'),
      reference: read('reference'),
      deposit: read('deposit'),
      withdrawal: read('withdrawal'),
    };
    if (!entry.date && !entry.description && !entry.reference && !entry.deposit && !entry.withdrawal) continue;
    if (rows.length >= MAX_ROWS) {
      throw new DomainError(ErrorCode.VALIDATION, `The sheet has more than ${MAX_ROWS} rows`, { maxRows: MAX_ROWS });
    }
    rows.push(entry);
  }
  return rows;
}
