import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isForeignKeyViolation } from '../../common/errors/db-errors.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { findPage } from '../../common/paging/find-page.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import type { CreatePartyDto, ListPartiesQueryDto, UpdatePartyDto } from './dto/parties.dto.js';
import { PartyUsageRegistry } from './party-usage.registry.js';
import { Prisma, type PartyType } from '../../generated/prisma/client.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';

/** Unified customers/suppliers (docs/BUILD_PLAN.md §7.5, partyType BOTH ok). */
@Injectable()
export class PartiesService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
    private readonly usage: PartyUsageRegistry,
  ) {}

  /**
   * One numbered page of the company's parties (ADR-022). Master data, so no
   * branch filter: parties are company master data. `partyType` is an exact match.
   */
  async list(query: ListPartiesQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const q = query.q;
    const where: Prisma.PartyWhereInput = {
      companyId,
      ...(query.partyType ? { partyType: query.partyType } : {}),
      ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
      ...(q
        ? {
            OR: [
              { code: { contains: q } },
              { nameAr: { contains: q } },
              { nameEn: { contains: q } },
              { phone: { contains: q } },
              { taxNumber: { contains: q } },
            ],
          }
        : {}),
    };
    const orderBy = orderByOf<'code' | 'nameAr', Prisma.PartyOrderByWithRelationInput>(
      query.sort,
      'code',
      {
        code: (dir) => ({ code: dir }),
        nameAr: (dir) => ({ nameAr: dir }),
      },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: (tx, window) => tx.party.findMany({ where, orderBy, ...window }),
      count: (tx) => tx.party.count({ where }),
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
   * Shared-locks the given parties of the company in the caller's
   * transaction and returns their types (ADR-021). A writer that attaches a
   * party without a foreign key (journal lines) calls this before inserting:
   * a concurrent deactivate then waits for its COMMIT and sees the new line,
   * or the writer waits for the delete and finds the party gone. Rows with a
   * foreign key to parties get the same shared lock from InnoDB.
   */
  async lockForReference(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    ids: bigint[],
  ): Promise<Map<bigint, PartyType>> {
    if (ids.length === 0) return new Map();
    const { tenantId } = this.support.tenant();
    const rows = await tx.$queryRaw<{ id: bigint; party_type: PartyType }[]>`
      SELECT id, party_type FROM parties
       WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id IN (${Prisma.join(ids)})
       ORDER BY id LOCK IN SHARE MODE`;
    return new Map(rows.map((r) => [BigInt(r.id), r.party_type]));
  }

  /**
   * Deactivates a party that is referenced anywhere, deletes one that is not
   * (DB-15, ADR-021). "Anywhere" is any draft or posted document, voucher,
   * allocation or journal line: each owning module answers through the
   * PartyUsageRegistry (module boundary). The party row is locked FOR UPDATE
   * first, and the checks and the delete run in that one transaction:
   * writers that reference the party hold a shared lock on it (a foreign key,
   * or lockForReference for journal lines), so none can slip in between.
   */
  async deactivate(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const userId = this.support.userId() ?? null;
    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const [party] = await tx.$queryRaw<{ code: string; party_type: PartyType }[]>`
          SELECT code, party_type FROM parties WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        if (!party) throw DomainError.notFound('Party', id.toString());
        const usedBy = await this.usage.usage(tx, id);
        if (usedBy.length > 0) {
          // Keep history intact — deactivate instead of delete.
          await tx.party.update({ where: { id }, data: { isActive: false, updatedBy: userId } });
          return { deactivated: true as const, code: party.code, usedBy };
        }
        try {
          await tx.party.delete({ where: { id } });
        } catch (err) {
          // Defence in depth: the lock above should make this unreachable.
          if (isForeignKeyViolation(err)) {
            throw new DomainError(ErrorCode.PARTY_IN_USE, 'The party is in use; deactivate it instead', {
              partyId: id.toString(),
            });
          }
          throw err;
        }
        return { deleted: true as const, code: party.code, partyType: party.party_type };
      }, POSTING_TX_OPTIONS),
    );
    if ('deactivated' in result) {
      await this.audit.log({
        action: 'party.deactivate',
        entityType: 'party',
        entityId: id,
        after: { code: result.code, usedBy: result.usedBy },
      });
      return { deactivated: true };
    }
    await this.audit.log({
      action: 'party.delete',
      entityType: 'party',
      entityId: id,
      before: { code: result.code, partyType: result.partyType },
    });
    return { deleted: true };
  }
}
