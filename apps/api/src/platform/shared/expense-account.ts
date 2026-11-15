import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * ADR-026 §8: the account a goods issue to a department debits is an
 * income-statement expense account of the company, active and postable.
 * NOT_FOUND for another company's or tenant's id, VALIDATION for any other
 * account (a balance-sheet or revenue account, a group).
 */
export async function assertExpenseAccount(
  db: Pick<Prisma.TransactionClient, 'account'>,
  companyId: bigint,
  id: bigint,
): Promise<void> {
  const acc = await db.account.findFirst({
    where: { companyId, id },
    select: { id: true, code: true, accountType: true, isActive: true, isPostable: true },
  });
  if (!acc) throw DomainError.notFound('Account', id.toString());
  if (acc.accountType !== 'EXPENSE' || !acc.isActive || !acc.isPostable) {
    throw new DomainError(ErrorCode.VALIDATION, `Account ${acc.code} is not an active postable expense account`, {
      field: 'expenseAccountId',
      accountId: id.toString(),
    });
  }
}
