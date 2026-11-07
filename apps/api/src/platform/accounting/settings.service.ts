import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CreateTaxCategoryDto,
  CreateUnitDto,
  UpdateLookupDto,
  UpdateTaxCategoryDto,
} from './dto/accounting.dto.js';

type LookupKind = 'unit' | 'taxCategory' | 'paymentMethod';

const MODEL: Record<LookupKind, 'unit' | 'taxCategory' | 'paymentMethod'> = {
  unit: 'unit',
  taxCategory: 'taxCategory',
  paymentMethod: 'paymentMethod',
};

/**
 * CRUD for tenant-level lookup tables: units, tax_categories,
 * payment_methods (docs/BUILD_PLAN.md §7.2).
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return this.prisma.forTenant(tenantId);
  }

  private delegate(kind: LookupKind) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.tenant() as any)[MODEL[kind]] as any;
  }

  private async findByCode(kind: LookupKind, code: string) {
    return this.delegate(kind).findFirst({ where: { code } });
  }

  async list(kind: LookupKind) {
    return this.delegate(kind).findMany({ orderBy: { code: 'asc' } });
  }

  async create(kind: LookupKind, dto: CreateUnitDto | CreateTaxCategoryDto) {
    const db = this.delegate(kind);
    const existing = await this.findByCode(kind, dto.code);
    if (existing) throw new DomainError(ErrorCode.CONFLICT, 'Code already exists');

    const data: Record<string, unknown> = {
      code: dto.code,
      nameAr: dto.nameAr,
      nameEn: dto.nameEn ?? null,
    };
    if (kind === 'taxCategory') {
      const t = dto as CreateTaxCategoryDto;
      data.rate = t.rate;
      data.einvoiceCode = t.einvoiceCode ?? null;
      data.isDefault = t.isDefault ?? false;
    }
    try {
      return await db.create({ data });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DomainError(ErrorCode.CONFLICT, 'Code already exists');
      }
      throw err;
    }
  }

  async update(kind: LookupKind, id: bigint, dto: UpdateLookupDto | UpdateTaxCategoryDto) {
    const db = this.delegate(kind);
    const existing = await db.findFirst({ where: { id } });
    if (!existing) throw DomainError.notFound(kind, id.toString());

    const data: Record<string, unknown> = {
      nameAr: dto.nameAr,
      nameEn: dto.nameEn,
      isActive: dto.isActive,
    };
    if (kind === 'taxCategory') {
      const t = dto as UpdateTaxCategoryDto;
      if (t.rate !== undefined) data.rate = t.rate;
      if (t.einvoiceCode !== undefined) data.einvoiceCode = t.einvoiceCode;
      if (t.isDefault !== undefined) data.isDefault = t.isDefault;
    }
    return db.update({ where: { id }, data });
  }
}
