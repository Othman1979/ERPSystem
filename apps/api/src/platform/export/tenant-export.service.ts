import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { zipSync, strToU8 } from 'fflate';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { toExcelNumber } from '../printing/format.js';

/** Excel keeps at most 32,767 characters per cell. */
const CELL_MAX = 32_000;

/**
 * The workbooks of the export and the tables (Prisma models) in each, one
 * sheet per table. Left out on purpose: idempotency keys (technical),
 * JoFotara settings (they hold the encrypted secret) and send attempts
 * (raw request / response bodies); submissions lose their XML and lease token.
 */
const WORKBOOKS: { file: string; models: string[] }[] = [
  {
    file: '01-company.xlsx',
    models: ['Company', 'Branch', 'Subscription', 'Unit', 'TaxCategory', 'PaymentMethod', 'FiscalYear', 'FiscalPeriod', 'DocumentSequence', 'Attachment'],
  },
  { file: '02-accounts.xlsx', models: ['Account', 'AccountMapping'] },
  { file: '03-journal.xlsx', models: ['JournalEntry', 'JournalLine'] },
  { file: '04-items.xlsx', models: ['ItemGroup', 'Item', 'ItemUnit', 'ItemBarcode', 'Warehouse'] },
  {
    file: '05-stock.xlsx',
    models: [
      'StockMovement',
      'StockBalance',
      'ItemCost',
      'StockAdjustment',
      'StockAdjustmentLine',
      'StockTransfer',
      'StockTransferLine',
      'StockCount',
      'StockCountLine',
      'GoodsNote',
      'GoodsNoteLine',
    ],
  },
  { file: '06-parties.xlsx', models: ['Party'] },
  { file: '07-sales.xlsx', models: ['SalesInvoice', 'SalesInvoiceLine', 'SalesReturn', 'SalesReturnLine'] },
  { file: '08-purchases.xlsx', models: ['PurchaseInvoice', 'PurchaseInvoiceLine', 'PurchaseReturn', 'PurchaseReturnLine'] },
  { file: '09-treasury.xlsx', models: ['CashBox', 'BankAccount', 'Receipt', 'Payment', 'Allocation', 'CashTransfer'] },
  { file: '10-einvoice.xlsx', models: ['EInvoiceSubmission'] },
  { file: '11-audit.xlsx', models: ['AuditLog'] },
];

/** Columns not exported (secrets, leases, raw payloads). */
const DROPPED_COLUMNS: Record<string, string[]> = {
  EInvoiceSubmission: ['requestXml', 'claimToken'],
  Attachment: ['storageKey'],
};

type Row = Record<string, unknown>;

/** A database value as an Excel cell: exact numbers, ids as text, JSON as text. */
function cell(value: unknown): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value;
  // Prisma's Decimal is its own decimal.js copy: recognise either by shape.
  if (Decimal.isDecimal(value) || (typeof value === 'object' && 'toFixed' in value && 'isZero' in value)) {
    return toExcelNumber(String(value));
  }
  if (typeof value === 'object') return clip(JSON.stringify(value));
  if (typeof value === 'string') return clip(value);
  return value as ExcelJS.CellValue;
}

const clip = (s: string) => (s.length > CELL_MAX ? `${s.slice(0, CELL_MAX)}…` : s);

const delegate = (model: string) => model[0].toLowerCase() + model.slice(1);

/**
 * Tenant data export (BUILD_PLAN §13.6, ADR-009 §13): a ZIP of Excel
 * workbooks with every business table of the tenant, the members, the
 * stored files and a README. A read-only dump across modules by design
 * (like a backup), always through tenantScopedPrisma; owner only, and
 * allowed in SUSPENDED / CANCELLED (a GET passes the read-only guard).
 */
@Injectable()
export class TenantExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async export(): Promise<{ zip: Buffer; fileName: string; counts: Record<string, number> }> {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    if (cls.get('roleCode') !== 'OWNER') {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Only the owner can export the company data');
    }
    const db = this.prisma.forTenant(tenantId);
    // Dynamic model access by name; every model listed is tenant-scoped.
    const models = db as unknown as Record<string, { findMany: (args: object) => Promise<Row[]> }>;

    const files: Record<string, Uint8Array> = {};
    const counts: Record<string, number> = {};

    for (const wb of WORKBOOKS) {
      const book = new ExcelJS.Workbook();
      for (const model of wb.models) {
        const rows = await models[delegate(model)].findMany({ orderBy: { id: 'asc' } });
        counts[model] = rows.length;
        addSheet(book, model, rows, DROPPED_COLUMNS[model] ?? []);
      }
      if (wb.file === '01-company.xlsx') {
        const members = await db.tenantMembership.findMany({
          orderBy: { id: 'asc' },
          select: {
            id: true,
            status: true,
            createdAt: true,
            role: { select: { code: true } },
            user: { select: { email: true, fullName: true } },
          },
        });
        counts.Members = members.length;
        addSheet(
          book,
          'Members',
          members.map((m) => ({
            id: m.id,
            email: m.user.email,
            fullName: m.user.fullName,
            role: m.role.code,
            status: m.status,
            createdAt: m.createdAt,
          })),
          [],
        );
      }
      files[wb.file] = new Uint8Array(await book.xlsx.writeBuffer());
    }

    // Stored files (the logo) next to their attachment rows.
    const attachments = await db.attachment.findMany({ orderBy: { id: 'asc' } });
    for (const a of attachments) {
      try {
        files[`attachments/${a.id}-${a.fileName.replace(/[\\/:*?"<>|]/g, '_')}`] = new Uint8Array(await this.storage.read(a.storageKey));
      } catch {
        // A file missing on disk does not stop the export; the README says so.
        files[`attachments/${a.id}-MISSING.txt`] = strToU8(`File not found in storage: ${a.fileName}`);
      }
    }

    // systemPrisma: `tenants` is the platform's table (not tenant-scoped); read by
    // the CLS tenant's own id only, for the README.
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id: tenantId }, select: { name: true, status: true } });
    const now = new Date();
    files['README.txt'] = strToU8(readme(tenant?.name ?? '', tenant?.status ?? '', now, counts));

    const zip = Buffer.from(zipSync(files, { level: 6 }));
    await this.audit.log({ action: 'tenant.export', entityType: 'tenant', entityId: tenantId, after: { bytes: zip.length, counts } });
    return { zip, fileName: `tenant-export-${now.toISOString().slice(0, 10)}.zip`, counts };
  }
}

function addSheet(book: ExcelJS.Workbook, name: string, rows: Row[], dropped: string[]) {
  const sheet = book.addWorksheet(name.slice(0, 31));
  if (rows.length === 0) {
    sheet.addRow(['(empty)']);
    return;
  }
  const keys = Object.keys(rows[0]).filter((k) => !dropped.includes(k));
  const header = sheet.addRow(keys);
  header.font = { bold: true };
  for (const r of rows) sheet.addRow(keys.map((k) => cell(r[k])));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function readme(tenant: string, status: string, at: Date, counts: Record<string, number>): string {
  return [
    'ERP Cloud — company data export / تصدير بيانات الشركة',
    `Company / الشركة: ${tenant}`,
    `Status / الحالة: ${status}`,
    `Exported at (UTC) / وقت التصدير: ${at.toISOString()}`,
    '',
    'One Excel workbook per area, one sheet per table. Amounts are exact numbers;',
    'ids are text. Cells longer than 32,000 characters are cut (Excel limit).',
    'كل ملف Excel لمجال، وكل ورقة لجدول. المبالغ أرقام دقيقة، والمعرفات نصوص.',
    '',
    'Not included / غير مشمول: idempotency keys, JoFotara settings (secret),',
    'JoFotara send attempts, the XML of submissions, user passwords.',
    '',
    'Rows per table / عدد الصفوف:',
    ...Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`),
    '',
  ].join('\n');
}
