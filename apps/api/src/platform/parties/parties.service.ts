import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type { CreatePartyDto, UpdatePartyDto } from './dto/parties.dto.js';

/** Unified customers/suppliers (docs/BUILD_PLAN.md §7.5, partyType BOTH ok). */
@Injectable()
export class PartiesService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
  ) {}

  async list(partyType?: string, isActive?: string) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.party.findMany({
      where: {
        companyId,
        ...(partyType ? { partyType: partyType as 'CUSTOMER' | 'SUPPLIER' | 'BOTH' } : {}),
        ...(isActive ? { isActive: isActive === 'true' } : {}),
      },
      orderBy: { code: 'asc' },
      take: 500,
    });
  }

  async get(id: bigint) {
    const { db } = this.support.tenant();
    const party = await db.party.findFirst({ where: { id } });
    if (!party) throw DomainError.notFound('Party', id.toString());
    return party;
  }

  async create(dto: CreatePartyDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const created = await db.party.create({
      data: {
        tenantId,
        companyId,
        code: dto.code,
        nameAr: dto.nameAr,
        nameEn: dto.nameEn ?? null,
        partyType: dto.partyType,
        taxNumber: dto.taxNumber ?? null,
        nationalId: dto.nationalId ?? null,
        phone: dto.phone ?? null,
        address: dto.address ?? null,
        city: dto.city ?? null,
        creditLimit: dto.creditLimit ?? null,
        paymentTermsDays: dto.paymentTermsDays ?? null,
        isCashCustomer: dto.isCashCustomer ?? false,
        isActive: dto.isActive ?? true,
        createdBy: this.support.userId() ?? null,
      },
    });
    await this.audit.log({
      action: 'party.create',
      entityType: 'party',
      entityId: created.id,
      after: { code: created.code, partyType: created.partyType },
    });
    return this.get(created.id);
  }

  async update(id: bigint, dto: UpdatePartyDto) {
    const { db } = this.support.tenant();
    const party = await db.party.findFirst({ where: { id } });
    if (!party) throw DomainError.notFound('Party', id.toString());
    const updated = await db.party.update({
      where: { id },
      data: {
        ...(dto.nameAr !== undefined ? { nameAr: dto.nameAr } : {}),
        ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn } : {}),
        ...(dto.partyType !== undefined ? { partyType: dto.partyType } : {}),
        ...(dto.taxNumber !== undefined ? { taxNumber: dto.taxNumber } : {}),
        ...(dto.nationalId !== undefined ? { nationalId: dto.nationalId } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.creditLimit !== undefined
          ? { creditLimit: new Decimal(dto.creditLimit) }
          : {}),
        ...(dto.paymentTermsDays !== undefined
          ? { paymentTermsDays: dto.paymentTermsDays }
          : {}),
        ...(dto.isCashCustomer !== undefined
          ? { isCashCustomer: dto.isCashCustomer }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        updatedBy: this.support.userId() ?? null,
      },
    });
    await this.audit.log({
      action: 'party.update',
      entityType: 'party',
      entityId: id,
      after: { code: updated.code },
    });
    return this.get(id);
  }

  async deactivate(id: bigint) {
    const { db } = this.support.tenant();
    const party = await db.party.findFirst({ where: { id } });
    if (!party) throw DomainError.notFound('Party', id.toString());
    const used = await db.salesInvoice.count({ where: { customerId: id, status: 'POSTED' } });
    const usedP = await db.purchaseInvoice.count({ where: { supplierId: id, status: 'POSTED' } });
    if (used + usedP > 0) {
      // Keep history intact — deactivate instead of delete.
      await db.party.update({ where: { id }, data: { isActive: false } });
      return { deactivated: true };
    }
    await db.party.delete({ where: { id } });
    return { deleted: true };
  }
}
