import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isForeignKeyViolation } from '../../common/errors/db-errors.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type { CreatePartyDto, UpdatePartyDto } from './dto/parties.dto.js';
import { PartyUsageRegistry } from './party-usage.registry.js';

/** Unified customers/suppliers (docs/BUILD_PLAN.md §7.5, partyType BOTH ok). */
@Injectable()
export class PartiesService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
    private readonly usage: PartyUsageRegistry,
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

  /** Code and names of the given parties (reports that start from journal lines). */
  async summaries(ids: bigint[]) {
    if (ids.length === 0) return [];
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.party.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true, code: true, nameAr: true, nameEn: true, partyType: true },
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
        nationalIdKind: dto.nationalIdKind ?? 'NIN',
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
        ...(dto.nationalIdKind !== undefined ? { nationalIdKind: dto.nationalIdKind } : {}),
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

  /**
   * Deactivates a party that is referenced anywhere, deletes one that is not
   * (DB-15, ADR-021). "Anywhere" is any draft or posted document, voucher,
   * allocation or journal line: each owning module answers through the
   * PartyUsageRegistry (module boundary). Journal lines have no FK to
   * parties, so a delete must never rely on the database to refuse it.
   */
  async deactivate(id: bigint) {
    const { db } = this.support.tenant();
    const party = await db.party.findFirst({ where: { id } });
    if (!party) throw DomainError.notFound('Party', id.toString());
    const usedBy = await this.usage.usage(id);
    if (usedBy.length > 0) {
      // Keep history intact — deactivate instead of delete.
      await db.party.update({
        where: { id },
        data: { isActive: false, updatedBy: this.support.userId() ?? null },
      });
      await this.audit.log({
        action: 'party.deactivate',
        entityType: 'party',
        entityId: id,
        after: { code: party.code, usedBy },
      });
      return { deactivated: true };
    }
    try {
      await db.party.delete({ where: { id } });
    } catch (err) {
      // A document referencing the party was saved between the check and
      // the delete; its foreign key refused the delete.
      if (isForeignKeyViolation(err)) {
        throw new DomainError(ErrorCode.PARTY_IN_USE, 'The party is in use; deactivate it instead', {
          partyId: id.toString(),
        });
      }
      throw err;
    }
    await this.audit.log({
      action: 'party.delete',
      entityType: 'party',
      entityId: id,
      before: { code: party.code, partyType: party.partyType },
    });
    return { deleted: true };
  }
}
