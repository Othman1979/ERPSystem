import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';

/**
 * TRADE-12 (decisions.md, ADR-016): a CREDIT return only against a CREDIT
 * invoice; a CASH invoice is refunded in cash. A credit return may exceed
 * the invoice's remaining balance: the party is then left in credit.
 */
export function assertRefundType(invoicePaymentType: 'CASH' | 'CREDIT', refundType: 'CASH' | 'CREDIT'): void {
  if (invoicePaymentType === 'CASH' && refundType === 'CREDIT') {
    throw new DomainError(ErrorCode.VALIDATION, 'A cash invoice is refunded in cash: refundType must be CASH');
  }
}
