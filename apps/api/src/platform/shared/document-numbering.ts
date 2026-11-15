import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Allocates the next document number from document_sequences for the fiscal
 * year covering `date` (BUILD_PLAN §11). The sequence row is locked FOR UPDATE
 * inside `tx`, so numbers are gapless: a transaction that fails gives its
 * number back with the rollback.
 *
 * Shared by PostingService (posted documents) and the phase 12 documents,
 * numbered at approval or when sent (ADR-025 §8), which post nothing and so
 * do not depend on the journal module.
 */
export async function allocateDocumentNo(
  tx: Prisma.TransactionClient,
  tenantId: bigint,
  companyId: bigint,
  documentType: string,
  date: Date,
): Promise<string> {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: {
      tenantId,
      companyId,
      startDate: { lte: date },
      endDate: { gte: date },
    },
  });
  if (!fiscalYear) {
    throw new DomainError(ErrorCode.PERIOD_CLOSED, 'No fiscal year covers this date');
  }

  const rows = (await tx.$queryRaw`
    SELECT id, prefix, next_number, padding
    FROM document_sequences
    WHERE tenant_id = ${tenantId}
      AND company_id = ${companyId}
      AND document_type = ${documentType}
      AND fiscal_year_id = ${fiscalYear.id}
    FOR UPDATE
  `) as { id: bigint; prefix: string; next_number: number; padding: number }[];

  const seq = rows[0];
  if (!seq) {
    throw new DomainError(
      ErrorCode.VALIDATION,
      `No document sequence for type ${documentType} in fiscal year ${fiscalYear.code}`,
    );
  }

  const padded = String(seq.next_number).padStart(seq.padding, '0');
  await tx.documentSequence.update({
    where: { id: seq.id },
    data: { nextNumber: { increment: 1 } },
  });

  // prefix already contains "{PREFIX}-{YEARCODE}" from provisioning.
  return `${seq.prefix}-${padded}`;
}
