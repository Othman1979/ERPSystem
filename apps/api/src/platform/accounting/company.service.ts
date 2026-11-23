import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { OWNER_ROLE } from '../../common/permissions/member-permissions.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ProcurementCycleRegistry } from '../../common/procurement/procurement-level.js';
import { StorageService } from '../../common/storage/storage.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ProcurementLevel } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { UpdateCompanyDto } from './dto/company.dto.js';
import { MappingsService, mappingAccountValidationError } from './mappings.service.js';
import { currentCompanyFilter } from '../../common/cls/current-company.js';

/** The sales cycle settings (ADR-027 §1), owner only. */
const SALES_SETTING_KEYS = [
  'salesOrderRequired',
  'salesReservation',
  'salesOrderApproval',
  'salesPriceLocked',
  'quoteValidityDays',
] as const;

/** What the upload interceptor hands over (multer's file, the fields we use). */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Logo rules (ADR-009 §7): PNG or JPEG, at most 1 MB, recognised by content. */
export const LOGO_MAX_BYTES = 1024 * 1024;

/** The image type of the bytes, from their signature; null if neither. */
export function imageKind(bytes: Buffer): { mimeType: string; extension: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  return null;
}

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim());

/**
 * The tenant's company profile (§13.4 step 1, printing header §13.7): names,
 * tax number, address, logo, tax-inclusive prices and the setup wizard state.
 */
@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly procurementCycle: ProcurementCycleRegistry,
    private readonly mappings: MappingsService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async company(db: ReturnType<PrismaService['forTenant']>) {
    const company = await db.company.findFirst({
      where: { isActive: true, ...currentCompanyFilter() },
      orderBy: { id: 'asc' },
      include: { logoAttachment: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true, storageKey: true } } },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    return company;
  }

  async get() {
    const { db } = this.tenant();
    const c = await this.company(db);
    return {
      id: c.id.toString(),
      legalNameAr: c.legalNameAr,
      legalNameEn: c.legalNameEn,
      taxNumber: c.taxNumber,
      commercialRegistration: c.commercialRegistration,
      address: c.address,
      phone: c.phone,
      pricesIncludeTax: c.pricesIncludeTax,
      costCentersEnabled: c.costCentersEnabled,
      consignmentEnabled: c.consignmentEnabled,
      procurementLevel: c.procurementLevel,
      salesOrderRequired: c.salesOrderRequired,
      salesReservation: c.salesReservation,
      salesOrderApproval: c.salesOrderApproval,
      salesPriceLocked: c.salesPriceLocked,
      quoteValidityDays: c.quoteValidityDays,
      // ADR-027 §1: the owner reviews these before turning sales_order_required on.
      directSalesDraftCount: await db.salesInvoice.count({ where: { companyId: c.id, status: 'DRAFT', salesOrderId: null } }),
      onboardingCompletedAt: c.onboardingCompletedAt,
      logo: c.logoAttachment
        ? {
            id: c.logoAttachment.id.toString(),
            fileName: c.logoAttachment.fileName,
            mimeType: c.logoAttachment.mimeType,
            sizeBytes: c.logoAttachment.sizeBytes?.toString() ?? null,
          }
        : null,
    };
  }

  private async assertConsignmentMappings(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint) {
    for (const mappingKey of ['CONSIGNMENT_SHRINKAGE'] as const) {
      let accountId: bigint;
      try {
        accountId = await this.mappings.mappedAccountId(tx, tenantId, companyId, mappingKey);
      } catch (error) {
        if (error instanceof DomainError && error.code === ErrorCode.MAPPING_ACCOUNT_INVALID) {
          throw new DomainError(
            ErrorCode.MAPPING_ACCOUNT_INVALID,
            'Map the supplier-goods-shortage account in account settings before enabling temporary receipt tracking',
            { mappingKey },
          );
        }
        throw error;
      }
      const account = await tx.account.findFirst({
        where: { tenantId, companyId, id: accountId },
        select: { isActive: true, isPostable: true, accountType: true, isControl: true, controlType: true },
      });
      if (!account || mappingAccountValidationError(mappingKey, account)) {
        throw new DomainError(
          ErrorCode.MAPPING_ACCOUNT_INVALID,
          'Map a valid supplier-goods-shortage account in account settings before enabling temporary receipt tracking',
          { mappingKey },
        );
      }
    }
  }

  async update(dto: UpdateCompanyDto) {
    const { tenantId, db } = this.tenant();
    const c = await this.company(db);
    const levelChange = dto.procurementLevel !== undefined && dto.procurementLevel !== c.procurementLevel;
    const consignmentChange =
      dto.consignmentEnabled !== undefined && dto.consignmentEnabled !== c.consignmentEnabled;
    if (
      (levelChange || consignmentChange) &&
      !ClsServiceManager.getClsService<RequestContext>().get('permissions')?.has(PERMISSIONS.COMPANY_MANAGE)
    ) {
      throw new DomainError(ErrorCode.FORBIDDEN, `Missing permission: ${PERMISSIONS.COMPANY_MANAGE}`);
    }
    // ADR-027 §1: the sales settings are the owner's alone, whatever permissions a member holds.
    const salesChange = SALES_SETTING_KEYS.some((k) => dto[k] !== undefined);
    if (salesChange && ClsServiceManager.getClsService<RequestContext>().get('roleCode') !== OWNER_ROLE) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Only the owner changes the sales settings');
    }
    const data = {
      ...(dto.legalNameAr !== undefined ? { legalNameAr: dto.legalNameAr.trim() } : {}),
      legalNameEn: blankToNull(dto.legalNameEn),
      taxNumber: blankToNull(dto.taxNumber),
      commercialRegistration: blankToNull(dto.commercialRegistration),
      address: blankToNull(dto.address),
      phone: blankToNull(dto.phone),
      ...(dto.pricesIncludeTax !== undefined ? { pricesIncludeTax: dto.pricesIncludeTax } : {}),
      ...(dto.costCentersEnabled !== undefined ? { costCentersEnabled: dto.costCentersEnabled } : {}),
      ...(dto.consignmentEnabled !== undefined ? { consignmentEnabled: dto.consignmentEnabled } : {}),
      ...(levelChange ? { procurementLevel: dto.procurementLevel } : {}),
      ...(dto.salesOrderRequired !== undefined ? { salesOrderRequired: dto.salesOrderRequired } : {}),
      ...(dto.salesReservation !== undefined ? { salesReservation: dto.salesReservation } : {}),
      ...(dto.salesOrderApproval !== undefined ? { salesOrderApproval: dto.salesOrderApproval } : {}),
      ...(dto.salesPriceLocked !== undefined ? { salesPriceLocked: dto.salesPriceLocked } : {}),
      ...(dto.quoteValidityDays !== undefined ? { quoteValidityDays: dto.quoteValidityDays } : {}),
    };
    const levelBefore = await db.$transaction(async (tx) => {
      let from = c.procurementLevel;
      if (levelChange || dto.consignmentEnabled !== undefined) {
        // The company row lock orders the open-documents check with the cycle
        // documents created from phase 12 on (ADR-024 §2.2). The level is read
        // by the locking query itself: a concurrent change may have moved it
        // since `c` was read.
        const [locked] = await tx.$queryRaw<{ procurement_level: ProcurementLevel; consignment_enabled: boolean }[]>`
          SELECT procurement_level, consignment_enabled FROM companies WHERE tenant_id = ${tenantId} AND id = ${c.id} FOR UPDATE`;
        from = locked.procurement_level;
        if (levelChange) await this.procurementCycle.assertLevelChange(tx, from, dto.procurementLevel!);
        if (dto.consignmentEnabled === true && !locked.consignment_enabled) {
          await this.assertConsignmentMappings(tx, tenantId, c.id);
        }
        if (dto.consignmentEnabled === false && locked.consignment_enabled) {
          const [stock] = await tx.$queryRaw<{ id: bigint }[]>`
            SELECT b.id
              FROM stock_balances b
              JOIN warehouses w ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
             WHERE b.tenant_id = ${tenantId} AND w.company_id = ${c.id}
               AND w.consignment_supplier_id IS NOT NULL AND b.qty_on_hand <> 0
             LIMIT 1`;
          const [openSale] = await tx.$queryRaw<{ id: bigint }[]>`
            SELECT id FROM consignment_sales
             WHERE tenant_id = ${tenantId} AND company_id = ${c.id}
               AND qty > returned_qty + invoiced_qty LIMIT 1`;
          const draftNote = await tx.goodsNote.findFirst({
            where: { companyId: c.id, status: 'DRAFT', noteType: { in: ['CONSIGNMENT_IN', 'CONSIGNMENT_OUT'] } },
            select: { id: true },
          });
          const draftSettlement = await tx.purchaseInvoice.findFirst({
            where: { companyId: c.id, status: 'DRAFT', consignmentSettlement: true },
            select: { id: true },
          });
          if (stock || openSale || draftNote || draftSettlement) {
            throw new DomainError(ErrorCode.CONSIGNMENT_IN_USE, 'Temporary-receipt stock or documents remain');
          }
        }
      }
      await tx.company.update({ where: { id: c.id }, data });
      return from;
    });
    await this.audit.log({
      action: 'company.update',
      entityType: 'company',
      entityId: c.id,
      before: {
        legalNameAr: c.legalNameAr,
        taxNumber: c.taxNumber,
        address: c.address,
        pricesIncludeTax: c.pricesIncludeTax,
        costCentersEnabled: c.costCentersEnabled,
        consignmentEnabled: c.consignmentEnabled,
        procurementLevel: levelBefore,
        salesOrderRequired: c.salesOrderRequired,
        salesReservation: c.salesReservation,
        salesOrderApproval: c.salesOrderApproval,
        salesPriceLocked: c.salesPriceLocked,
        quoteValidityDays: c.quoteValidityDays,
      },
      after: dto,
    });
    return this.get();
  }

  /** Stores a new logo (replacing the old one, file included). */
  async uploadLogo(file: UploadedFileLike | undefined) {
    if (!file?.buffer?.length) throw new DomainError(ErrorCode.VALIDATION, 'A logo file is required');
    if (file.size > LOGO_MAX_BYTES) {
      throw new DomainError(ErrorCode.UPLOAD_TOO_LARGE, 'The logo is larger than 1 MB', { maxBytes: LOGO_MAX_BYTES });
    }
    const kind = imageKind(file.buffer);
    if (!kind) throw new DomainError(ErrorCode.UPLOAD_TYPE_NOT_ALLOWED, 'The logo must be a PNG or JPEG image');

    const { tenantId, db } = this.tenant();
    const c = await this.company(db);
    const key = await this.storage.save(tenantId, file.buffer, kind.extension);
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId');
    try {
      await db.$transaction(async (tx) => {
        const attachment = await tx.attachment.create({
          data: {
            tenantId,
            storageKey: key,
            fileName: file.originalname.slice(0, 255),
            mimeType: kind.mimeType,
            sizeBytes: BigInt(file.size),
            uploadedBy: userId ?? null,
          },
        });
        await tx.company.update({ where: { id: c.id }, data: { logoAttachmentId: attachment.id } });
        if (c.logoAttachment) await tx.attachment.delete({ where: { id: c.logoAttachment.id } });
      });
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
    // The old file goes once the database no longer points at it.
    if (c.logoAttachment) await this.storage.remove(c.logoAttachment.storageKey);
    await this.audit.log({ action: 'company.logo', entityType: 'company', entityId: c.id, after: { fileName: file.originalname } });
    return this.get();
  }

  /** The logo bytes as base64 (the web shows it without a cookie-less image URL). */
  async logo(): Promise<{ mimeType: string; base64: string }> {
    const { db } = this.tenant();
    const c = await this.company(db);
    if (!c.logoAttachment) throw DomainError.notFound('Logo', c.id.toString());
    const bytes = await this.storage.read(c.logoAttachment.storageKey);
    return { mimeType: c.logoAttachment.mimeType, base64: bytes.toString('base64') };
  }

  async removeLogo() {
    const { db } = this.tenant();
    const c = await this.company(db);
    if (c.logoAttachment) {
      await db.$transaction(async (tx) => {
        await tx.company.update({ where: { id: c.id }, data: { logoAttachmentId: null } });
        await tx.attachment.delete({ where: { id: c.logoAttachment!.id } });
      });
      await this.storage.remove(c.logoAttachment.storageKey);
      await this.audit.log({ action: 'company.logo_removed', entityType: 'company', entityId: c.id });
    }
    return this.get();
  }

  /** Marks the setup wizard done (§13.4); the first completion date is kept. */
  async completeOnboarding() {
    const { db } = this.tenant();
    const c = await this.company(db);
    if (!c.onboardingCompletedAt) {
      await db.company.update({ where: { id: c.id }, data: { onboardingCompletedAt: new Date() } });
      await this.audit.log({ action: 'company.onboarding_completed', entityType: 'company', entityId: c.id });
    }
    return this.get();
  }
}
