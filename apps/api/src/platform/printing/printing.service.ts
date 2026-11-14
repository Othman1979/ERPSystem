import { Injectable, StreamableFile } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { renderPdf } from './pdf-render.js';
import { documentPdf, type DocumentPrint } from './document-pdf.js';
import { tablePdf, tableXlsx, type PrintContext, type ReportTable } from './report-table.js';

export type ExportFormat = 'json' | 'pdf' | 'xlsx';

/**
 * Rows a report may export at most (REPORT_TOO_LARGE above), env-tunable.
 * Read on every use, not at import time: ConfigModule loads `.env` into
 * process.env only after this module is imported. Kept low because exports
 * run in the request thread (ADR-006: streaming XLSX / a PDF worker are
 * known debt).
 */
export const EXPORT_LIMITS = {
  // Owner decision D-4 (2026-11-13): the PDF limit rose from 1,000 to 10,000 rows;
  // the header repeats on every page and the pages are numbered.
  get pdf() {
    return Number(process.env.REPORT_PDF_MAX_ROWS || 10_000);
  },
  get xlsx() {
    return Number(process.env.REPORT_XLSX_MAX_ROWS || 50_000);
  },
};

/**
 * PDF (pdfmake, BUILD_PLAN §3 — no Chromium on the hosting) and XLSX
 * (exceljs) output for reports and documents. No business-module imports:
 * every module can use it.
 */
@Injectable()
export class PrintingService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly storage: StorageService,
  ) {}

  /** Company header data and language for a printout. */
  async context(lang: 'ar' | 'en' = 'ar'): Promise<PrintContext> {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const c = await db.company.findFirst({
      where: { id: companyId },
      select: {
        legalNameAr: true,
        legalNameEn: true,
        taxNumber: true,
        address: true,
        phone: true,
        timezone: true,
        logoAttachment: { select: { storageKey: true, mimeType: true } },
      },
    });
    // The company logo (§13.7) as a data URL: pdfmake reads no URL or file besides the fonts.
    const logo = c?.logoAttachment
      ? `data:${c.logoAttachment.mimeType};base64,${(await this.storage.read(c.logoAttachment.storageKey)).toString('base64')}`
      : null;
    return {
      lang,
      company: {
        name: (lang === 'en' ? c?.legalNameEn : null) || c?.legalNameAr || '',
        taxNumber: c?.taxNumber ?? null,
        address: c?.address ?? null,
        phone: c?.phone ?? null,
        logo,
      },
      printedAt: new Date(),
      timeZone: c?.timezone || 'Asia/Amman',
    };
  }

  async pdf(definition: object): Promise<Buffer> {
    return renderPdf(definition);
  }

  /** A business document as an A4 PDF (§13.7). */
  async exportDocument(doc: DocumentPrint, lang: 'ar' | 'en'): Promise<StreamableFile> {
    const ctx = await this.context(lang);
    return file(await this.pdf(documentPdf(doc, ctx)), 'pdf', doc.fileName);
  }

  /**
   * A report endpoint's answer for `?format=json|pdf|xlsx&lang=ar|en`: the
   * JSON unchanged, or `toTable(data, lang)` as a downloadable file.
   */
  async respond<T>(
    data: T,
    q: { format?: ExportFormat; lang?: 'ar' | 'en' },
    toTable: (data: T, lang: 'ar' | 'en') => ReportTable,
  ): Promise<T | StreamableFile> {
    const format = q.format ?? 'json';
    if (format === 'json') return data;
    const lang = q.lang ?? 'ar';
    return this.exportTable(toTable(data, lang), format, lang);
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
