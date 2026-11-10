import path from 'node:path';
import { Injectable, StreamableFile } from '@nestjs/common';
import pdfmake from 'pdfmake';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { FONT_DIR, FONT_FILES, FONT_NAME } from './fonts.js';
import { documentPdf, type DocumentPrint } from './document-pdf.js';
import { tablePdf, tableXlsx, type PrintContext, type ReportTable } from './report-table.js';

export type ExportFormat = 'json' | 'pdf' | 'xlsx';

/** Rows a report may export at most (REPORT_TOO_LARGE above); env-tunable, proven in the perf test. */
export const EXPORT_LIMITS = {
  pdf: Number(process.env.REPORT_PDF_MAX_ROWS ?? 3_000),
  xlsx: Number(process.env.REPORT_XLSX_MAX_ROWS ?? 200_000),
};

let configured = false;
function configurePdfmake() {
  if (configured) return;
  pdfmake.setFonts({
    [FONT_NAME]: { normal: FONT_FILES.normal, bold: FONT_FILES.bold, italics: FONT_FILES.normal, bolditalics: FONT_FILES.bold },
  });
  // Documents never fetch anything: no URLs, and only our font files on disk.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(FONT_DIR));
  configured = true;
}

/**
 * PDF (pdfmake, BUILD_PLAN §3 — no Chromium on the hosting) and XLSX
 * (exceljs) output for reports and documents. No business-module imports:
 * every module can use it.
 */
@Injectable()
export class PrintingService {
  constructor(private readonly support: DocumentSupportService) {}

  /** Company header data and language for a printout. */
  async context(lang: 'ar' | 'en' = 'ar'): Promise<PrintContext> {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const c = await db.company.findFirst({
      where: { id: companyId },
      select: { legalNameAr: true, legalNameEn: true, taxNumber: true, address: true, phone: true },
    });
    return {
      lang,
      company: {
        name: (lang === 'en' ? c?.legalNameEn : null) || c?.legalNameAr || '',
        taxNumber: c?.taxNumber ?? null,
        address: c?.address ?? null,
        phone: c?.phone ?? null,
      },
      printedAt: new Date(),
    };
  }

  async pdf(definition: object): Promise<Buffer> {
    configurePdfmake();
    return Buffer.from(await pdfmake.createPdf(definition).getBuffer());
  }

  /** A business document as an A4 PDF (§13.7). */
  async exportDocument(doc: DocumentPrint, lang: 'ar' | 'en'): Promise<StreamableFile> {
    const ctx = await this.context(lang);
    return file(await this.pdf(documentPdf(doc, ctx)), 'pdf', doc.fileName);
  }

  /** A report as a downloadable PDF or XLSX file. */
  async exportTable(table: ReportTable, format: 'pdf' | 'xlsx', lang: 'ar' | 'en'): Promise<StreamableFile> {
    const rows = table.rows.length;
    if (rows > EXPORT_LIMITS[format]) {
      throw new DomainError(
        ErrorCode.REPORT_TOO_LARGE,
        `The report has ${rows} rows; ${format.toUpperCase()} exports take at most ${EXPORT_LIMITS[format]}. Narrow the filters.`,
        { rows, limit: EXPORT_LIMITS[format] },
      );
    }
    const ctx = await this.context(lang);
    const buf = format === 'pdf' ? await this.pdf(tablePdf(table, ctx)) : await tableXlsx(table, ctx);
    return file(buf, format, table.fileName);
  }
}

export function file(buf: Buffer, format: 'pdf' | 'xlsx', name: string): StreamableFile {
  const type =
    format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const safe = name.replace(/[^A-Za-z0-9_.-]+/g, '-');
  return new StreamableFile(buf, { type, disposition: `attachment; filename="${safe}.${format}"`, length: buf.length });
}
