import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { Prisma } from '../../generated/prisma/client.js';
import { DocumentSupportService, retryOnLockConflict } from '../shared/document-support.service.js';
import {
  assertCanDeactivate,
  assertCanDelete,
  assertCanReactivate,
  assertCanTakeChild,
  type PostingCentre,
} from './cost-center-rules.js';
import { CostCenterUsageRegistry } from './cost-center-usage.registry.js';
import type { CreateCostCenterDto, UpdateCostCenterDto } from './dto/cost-centers.dto.js';

/**
 * Cost centres (ADR-013 §3, ADR-024 §1): a tree per company, apart from the
 * branches. Only a leaf takes lines. A centre referenced anywhere (journal
 * lines, document headers, drafts included) is deactivated, never deleted
 * (ADR-021 pattern, through CostCenterUsageRegistry).
 *
 * Locks: posting reads its centres LOCK IN SHARE MODE to COMMIT (lockForPosting),
 * after its accounts; every change here takes the row FOR UPDATE first, so it
 * waits for a posting in flight and a later posting sees the change.
 */
@Injectable()
export class CostCentersService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly usageRegistry: CostCenterUsageRegistry,
    private readonly audit: AuditService,
  ) {}

  /** Flat list by code; the web builds the tree (a company has tens of centres). */
  async list() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.costCenter.findMany({ where: { companyId }, orderBy: { code: 'asc' } });
  }

  async create(dto: CreateCostCenterDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId() ?? null;
    const parentId = dto.parentId ? BigInt(dto.parentId) : null;
    try {
      const created = await retryOnLockConflict(() =>
        db.$transaction(async (tx) => {
          if (parentId !== null) {
            const parent = await this.lockRow(tx, tenantId, companyId, parentId);
            assertCanTakeChild(parent, await this.usageRegistry.usage(tx, parentId));
          }
          const row = await tx.costCenter.create({
            data: {
              tenantId,
              companyId,
              code: dto.code,
              nameAr: dto.nameAr,
              nameEn: dto.nameEn ?? null,
              parentId,
              createdBy: userId,
            },
          });
          // A centre with a child is a group: it takes no lines (§1.4).
          if (parentId !== null) {
            await tx.costCenter.updateMany({ where: { id: parentId, isPostable: true }, data: { isPostable: false } });
          }
          return row;
        }),
      );
      await this.audit.log({
        action: 'cost_center.create',
        entityType: 'cost_center',
        entityId: created.id,
        after: { code: created.code, nameAr: created.nameAr, parentId: dto.parentId ?? null },
      });
      return created;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DomainError(ErrorCode.DUPLICATE_CODE, 'Cost centre code already exists', { code: dto.code });
      }
      throw err;
    }
  }

  async update(id: bigint, dto: UpdateCostCenterDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId() ?? null;
    const { before, updated } = await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        const before = await this.lockRow(tx, tenantId, companyId, id);
        if (dto.isActive === false && before.isActive) {
          assertCanDeactivate(before, await tx.costCenter.count({ where: { parentId: id, isActive: true } }));
        }
        // Reactivate under an active parent only: no active leaf sits under an inactive group.
        if (dto.isActive === true && !before.isActive && before.parentId !== null) {
          const parent = await this.lockRow(tx, tenantId, companyId, before.parentId);
          assertCanReactivate(parent);
        }
        const updated = await tx.costCenter.update({
          where: { id },
          data: { nameAr: dto.nameAr, nameEn: dto.nameEn, isActive: dto.isActive, updatedBy: userId },
        });
        return { before, updated };
      }),
    );
    await this.audit.log({
      action: dto.isActive === false && before.isActive ? 'cost_center.deactivate' : 'cost_center.update',
      entityType: 'cost_center',
      entityId: id,
      before: { nameAr: before.nameAr, nameEn: before.nameEn, isActive: before.isActive },
      after: dto,
    });
    return updated;
  }

  /**
   * Deletes a leaf that nothing references. A used centre answers
   * COST_CENTER_IN_USE (409): deactivate it instead (ADR-024 §1.7). A parent
   * left without children takes lines again.
   */
  async remove(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const removed = await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        const row = await this.lockRow(tx, tenantId, companyId, id);
        // Lock the parent too, before the child goes: it may become a leaf again.
        if (row.parentId !== null) await this.lockRow(tx, tenantId, companyId, row.parentId);
        const children = await tx.costCenter.count({ where: { parentId: id } });
        assertCanDelete(row, children, children > 0 ? [] : await this.usageRegistry.usage(tx, id));
        await tx.costCenter.delete({ where: { id } });
        if (row.parentId !== null && (await tx.costCenter.count({ where: { parentId: row.parentId } })) === 0) {
          await tx.costCenter.update({ where: { id: row.parentId }, data: { isPostable: true } });
        }
        return row;
      }),
    );
    await this.audit.log({
      action: 'cost_center.delete',
      entityType: 'cost_center',
      entityId: id,
      before: { code: removed.code, nameAr: removed.nameAr },
    });
    return { deleted: true };
  }

  /** The company's centre as a report header names it; 404 for another company's or tenant's. */
  async header(id: bigint): Promise<{ id: string; code: string; nameAr: string; nameEn: string | null }> {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const row = await db.costCenter.findFirst({
      where: { companyId, id },
      select: { id: true, code: true, nameAr: true, nameEn: true },
    });
    if (!row) throw DomainError.notFound('CostCenter', id.toString());
    return { id: row.id.toString(), code: row.code, nameAr: row.nameAr, nameEn: row.nameEn };
  }

  /**
   * A header centre on a document: one of the company's, active and a leaf.
   * Called inside the transaction that writes the header row, before that
   * write: the centre is share-locked to COMMIT first (lockForPosting), so the
   * row's foreign key check never waits behind a delete holding the centre,
   * and a delete that runs first leaves a 404 here, a delete that runs second
   * sees the document and answers COST_CENTER_IN_USE. Posting checks it again.
   */
  async assertUsable(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint, id: bigint): Promise<void> {
    const row = (await this.lockForPosting(tx, tenantId, companyId, [id])).get(id);
    if (!row) throw DomainError.notFound('CostCenter', id.toString());
    if (!row.isActive) {
      throw new DomainError(ErrorCode.COST_CENTER_INACTIVE, `Cost centre ${row.code} is inactive`, {
        costCenterId: id.toString(),
      });
    }
    if (!row.isPostable) {
      throw new DomainError(ErrorCode.COST_CENTER_NOT_POSTABLE, `Cost centre ${row.code} is a group`, {
        costCenterId: id.toString(),
      });
    }
  }

  /**
   * Centres of journal lines, for posting and for draft lines (journal_lines
   * has no FK to cost_centers): read LOCK IN SHARE MODE, held to COMMIT, in
   * ascending id order, so a concurrent delete or regrouping waits for this
   * transaction and two postings never lock them in opposite orders. The
   * caller locks its accounts first (ADR-024 §1.4). Centres of other companies
   * are absent from the map.
   */
  async lockForPosting(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    ids: bigint[],
  ): Promise<Map<bigint, PostingCentre>> {
    const unique = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (unique.length === 0) return new Map();
    // FORCE INDEX (PRIMARY), as for accounts in PostingService.validateLines: the
    // clustered record first, the order every row lock on a centre takes.
    const rows = (await tx.$queryRaw`
      SELECT id, code, is_active, is_postable
      FROM cost_centers FORCE INDEX (PRIMARY)
      WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id IN (${Prisma.join(unique)})
      ORDER BY id
      LOCK IN SHARE MODE
    `) as { id: bigint; code: string; is_active: number | boolean; is_postable: number | boolean }[];
    return new Map(
      rows.map((r) => [
        BigInt(r.id),
        { id: BigInt(r.id), code: r.code, isActive: Boolean(r.is_active), isPostable: Boolean(r.is_postable) },
      ]),
    );
  }

  /** The company's centre, locked FOR UPDATE; 404 for another company's or tenant's. */
  private async lockRow(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint, id: bigint) {
    await tx.$queryRaw`SELECT id FROM cost_centers FORCE INDEX (PRIMARY) WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    const row = await tx.costCenter.findFirst({ where: { id, companyId } });
    if (!row) throw DomainError.notFound('CostCenter', id.toString());
    return row;
  }
}
