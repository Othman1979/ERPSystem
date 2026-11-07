import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  CHART_TEMPLATE,
  DEFAULT_PAYMENT_METHODS,
  DEFAULT_TAX_CATEGORIES,
  DEFAULT_UNITS,
  TEMPLATE_MAPPINGS,
} from './chart-template.js';

/**
 * Provisions the default chart of accounts (§8.7), account_mappings (§7.2),
 * and default units/tax categories/payment methods for a company.
 * Idempotent per company: skips accounts/mappings that already exist.
 *
 * Accepts a transaction client so it can run inside registration's single
 * transaction or standalone via the /accounting/setup/provision endpoint.
 */
@Injectable()
export class ChartProvisioningService {
  async provision(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    userId?: bigint,
  ): Promise<{ accounts: number; mappings: number; units: number; taxCategories: number; paymentMethods: number }> {
    // --- Accounts (parents before children; template is ordered that way) ---
    const existing = await tx.account.findMany({
      where: { tenantId, companyId },
      select: { id: true, code: true },
    });
    const existingCodes = new Set(existing.map((a) => a.code));
    const idByCode = new Map(existing.map((a) => [a.code, a.id] as const));

    let created = 0;
    for (const t of CHART_TEMPLATE) {
      if (existingCodes.has(t.code)) continue;
      const parentId = t.parentCode ? (idByCode.get(t.parentCode) ?? null) : null;
      const row = await tx.account.create({
        data: {
          tenantId,
          companyId,
          code: t.code,
          nameAr: t.nameAr,
          nameEn: t.nameEn ?? null,
          parentId,
          level: levelOf(t.code),
          accountType: t.accountType,
          normalBalance: t.normalBalance,
          isPostable: t.isPostable,
          isControl: t.isControl ?? false,
          controlType: t.controlType ?? null,
          createdBy: userId ?? null,
        },
      });
      idByCode.set(t.code, row.id);
      created++;
    }

    // --- account_mappings ---
    let mappings = 0;
    for (const [key, code] of Object.entries(TEMPLATE_MAPPINGS)) {
      const accountId = idByCode.get(code);
      if (!accountId) continue;
      const res = await tx.accountMapping.upsert({
        where: {
          tenantId_companyId_mappingKey: { tenantId, companyId, mappingKey: key },
        },
        update: {},
        create: { tenantId, companyId, mappingKey: key, accountId },
      });
      if (res) mappings++;
    }

    // --- default units / tax categories / payment methods (tenant-level) ---
    let units = 0;
    for (const u of DEFAULT_UNITS) {
      const r = await tx.unit.upsert({
        where: { tenantId_code: { tenantId, code: u.code } },
        update: {},
        create: { tenantId, ...u },
      });
      if (r) units++;
    }
    let taxCategories = 0;
    for (const tc of DEFAULT_TAX_CATEGORIES) {
      const r = await tx.taxCategory.upsert({
        where: { tenantId_code: { tenantId, code: tc.code } },
        update: {},
        create: { tenantId, ...tc, rate: tc.rate as never },
      });
      if (r) taxCategories++;
    }
    let paymentMethods = 0;
    for (const pm of DEFAULT_PAYMENT_METHODS) {
      const r = await tx.paymentMethod.upsert({
        where: { tenantId_code: { tenantId, code: pm.code } },
        update: {},
        create: { tenantId, ...pm },
      });
      if (r) paymentMethods++;
    }

    return { accounts: created, mappings, units, taxCategories, paymentMethods };
  }
}

function levelOf(code: string): number {
  // depth by code length groups in the template: 1→1, 2→2, 4→3
  if (code.length <= 1) return 1;
  if (code.length <= 2) return 2;
  return 3;
}
