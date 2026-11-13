import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { JournalLineInput } from '../journal/posting.service.js';

/**
 * Journal lines for the stock write-offs of a document (ADR-018): the value
 * StockLedgerService took out of item_costs on top of the movements' own
 * value (MovementResult.writeOff). Positive: Dr INVENTORY_ADJUSTMENT /
 * Cr INVENTORY; negative: the other way round; zero: no lines. Booking it in
 * the same entry keeps the INVENTORY account equal to the stock value.
 */
export function stockWriteOffLines(
  writeOff: Decimal.Value,
  accounts: { inventory: bigint; adjustment: bigint },
): JournalLineInput[] {
  const amount = new Decimal(writeOff);
  if (amount.isZero()) return [];
  const value = amount.abs().toString();
  const description = 'Stock revaluation (ADR-018)';
  return amount.gt(0)
    ? [
        { accountId: accounts.adjustment, debit: value, description },
        { accountId: accounts.inventory, credit: value, description },
      ]
    : [
        { accountId: accounts.inventory, debit: value, description },
        { accountId: accounts.adjustment, credit: value, description },
      ];
}
