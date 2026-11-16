import ExcelJS from 'exceljs';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { ImportRow } from './counts.service.js';

/** The largest sheet the import reads (ADR-030 §11: xlsx up to 5 MB, held in memory only). */
export const SHEET_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** The most rows one sheet may carry. */
const MAX_ROWS = 5000;

/** An uploaded multipart file, as Multer gives it in memory. */
export interface UploadedSheet {
  originalname: string;
  size: number;
  buffer?: Buffer;
}

type ColumnKey = 'code' | 'barcode' | 'unit' | 'counted';

/** Header names the import accepts, in Arabic or English (the export writes the same, count-sheet headers). */
const HEADER_KEYS = new Map<string, ColumnKey>([
  ['الرمز', 'code'],
  ['code', 'code'],
  ['الباركود', 'barcode'],
  ['barcode', 'barcode'],
  ['الوحدة', 'unit'],
  ['unit', 'unit'],
  ['المعدود', 'counted'],
  ['counted', 'counted'],
]);

/** The text of a cell: plain values, rich text, hyperlinks and formula results. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).trim();
  if (value instanceof Date) return '';
  if (typeof value === 'object') {
    const v = value as { text?: unknown; richText?: { text: string }[]; result?: unknown };
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim();
    if (typeof v.text === 'string') return v.text.trim();
    if ('result' in v) return cellText(v.result);
  }
  return '';
}

/**
 * The rows of an uploaded count sheet, read from the first worksheet. The header
 * row is the first of the first ten rows that names a `counted` column; rows
 * with no code, barcode, unit and counted value are skipped. Each row keeps its
 * sheet row number, for the error list.
 */
export async function readSheetRows(file: UploadedSheet | undefined): Promise<ImportRow[]> {
  if (!file?.buffer?.length) throw new DomainError(ErrorCode.VALIDATION, 'A sheet file is required');
  if (!/\.xlsx$/i.test(file.originalname)) {
    throw new DomainError(ErrorCode.VALIDATION, 'The count sheet must be an .xlsx file');
  }
  if (file.size > SHEET_IMPORT_MAX_BYTES) {
    throw new DomainError(ErrorCode.UPLOAD_TOO_LARGE, 'The count sheet is larger than 5 MB', {
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
    if (found.counted !== undefined) {
      headerRow = r;
      columns = found;
    }
  }
  if (headerRow === 0) {
    throw new DomainError(ErrorCode.VALIDATION, 'The sheet has no "counted" column', {
      errors: [{ row: 1, reason: 'MISSING_COLUMN: the header row needs a counted column' }],
    });
  }

  const rows: ImportRow[] = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const read = (key: ColumnKey) => {
      const col = columns[key];
      return col === undefined ? '' : cellText(row.getCell(col).value);
    };
    const entry = { code: read('code'), barcode: read('barcode'), unit: read('unit'), counted: read('counted') };
    if (!entry.code && !entry.barcode && !entry.unit && !entry.counted) continue;
    if (rows.length >= MAX_ROWS) {
      throw new DomainError(ErrorCode.VALIDATION, `The sheet has more than ${MAX_ROWS} rows`, { maxRows: MAX_ROWS });
    }
    rows.push({
      row: r,
      code: entry.code || null,
      barcode: entry.barcode || null,
      unit: entry.unit || null,
      counted: entry.counted,
    });
  }
  return rows;
}
