import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';

/** The company-level cost projection of one item (item_costs), as locked. */
export interface CostState {
  totalQty: Decimal;
  totalValue: Decimal;
  avgCost: Decimal;
}

export interface CostingInput {
  type: 'IN' | 'OUT';
  /** Base units, > 0. */
  qty: Decimal;
  /**
   * Cost per base unit. IN: the incoming cost (default: current average).
   * OUT: a specific cost (purchase return at the original line cost, §9.5);
   * default: the current average.
   */
  unitCost?: Decimal.Value | null;
  /**
   * Exact movement value, for a reversal that mirrors the original movement
   * (DB-04/05). Takes precedence over unitCost for the value.
   */
  totalCost?: Decimal.Value | null;
}

export interface CostingResult {
  /** Stored on the movement (6 dp). */
  unitCost: Decimal;
  /** The movement's value (3 dp). */
  totalCost: Decimal;
  newTotalQty: Decimal;
  newTotalValue: Decimal;
  newAvg: Decimal;
  /**
   * Value taken out of item_costs on top of the movement's own value
   * (negative: added) so the projection stays meaningful (ADR-018):
   *  - quantity 0 always means value 0 — a residue is written off;
   *  - a positive quantity never carries a negative value;
   *  - stock coming back above zero from zero or below is revalued at the
   *    incoming cost.
   * The ledger records it as a zero-quantity movement and the posting
   * document books it Dr INVENTORY_ADJUSTMENT / Cr INVENTORY (reverse sides
   * when negative), so the GL inventory account keeps equal to item_costs.
   */
  writeOff: Decimal;
}

/**
 * Weighted-average costing of one movement (BUILD_PLAN §9.2, §9.3, §9.5;
 * ADR-018 for quantities at or below zero). Pure: no I/O.
 */
export function costMovement(cost: CostState, input: CostingInput): CostingResult {
  const qty = new Decimal(input.qty);
  const q0 = new Decimal(cost.totalQty);
  const v0 = new Decimal(cost.totalValue);
  const a0 = new Decimal(cost.avgCost);
  const explicitTotal =
    input.totalCost !== undefined && input.totalCost !== null ? round3(input.totalCost) : null;
  const explicitUnit =
    input.unitCost !== undefined && input.unitCost !== null ? new Decimal(input.unitCost) : null;
  if (explicitUnit?.lt(0) || explicitTotal?.lt(0)) {
    throw new DomainError(ErrorCode.VALIDATION, 'unitCost cannot be negative');
  }

  let totalCost: Decimal;
  let unitCost: Decimal;
  if (explicitTotal) {
    totalCost = explicitTotal;
    unitCost = explicitUnit ? round6(explicitUnit) : round6(explicitTotal.div(qty));
  } else if (explicitUnit) {
    totalCost = round3(qty.times(explicitUnit));
    unitCost = round6(explicitUnit);
  } else if (input.type === 'OUT' && qty.eq(q0)) {
    // Emptying the item carries its remaining value out in full (§9.2): no residue.
    totalCost = v0;
    unitCost = a0;
  } else {
    totalCost = round3(qty.times(a0));
    unitCost = a0;
  }

  const newTotalQty = input.type === 'IN' ? q0.plus(qty) : q0.minus(qty);
  const provisional = input.type === 'IN' ? v0.plus(totalCost) : v0.minus(totalCost);

  let newTotalValue = provisional;
  let newAvg: Decimal;
  if (newTotalQty.isZero()) {
    newTotalValue = new Decimal(0);
    // Keep the last known cost: the next outflow on negative stock or a
    // count surplus is valued with it, not at zero (DB-19).
    newAvg = a0.isZero() ? unitCost : a0;
  } else if (newTotalQty.lt(0)) {
    // Short position (allowNegativeStock): valued at the last average.
    newAvg = a0.isZero() ? unitCost : a0;
  } else if (input.type === 'IN' && (q0.lt(0) || (q0.isZero() && !v0.isZero()))) {
    // Back above zero: the new stock is valued at the incoming cost (ADR-018).
    newTotalValue = q0.isZero() ? totalCost : round3(newTotalQty.times(totalCost).div(qty));
    newAvg = round6(newTotalValue.div(newTotalQty));
  } else if (provisional.lt(0)) {
    newTotalValue = new Decimal(0);
    newAvg = new Decimal(0);
  } else {
    newAvg = round6(provisional.div(newTotalQty));
  }

  return {
    unitCost,
    totalCost,
    newTotalQty,
    newTotalValue,
    newAvg,
    writeOff: provisional.minus(newTotalValue),
  };
}
