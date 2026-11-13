import { Decimal } from '../../common/decimal/decimal.utils.js';
import { costMovement, type CostState } from './stock-costing.js';

const state = (qty: string, value: string, avg: string): CostState => ({
  totalQty: new Decimal(qty),
  totalValue: new Decimal(value),
  avgCost: new Decimal(avg),
});
const s = (d: Decimal) => d.toString();

describe('costMovement — weighted average (§9.2) and ADR-018', () => {
  it('IN recomputes the average; OUT leaves at it', () => {
    const inn = costMovement(state('10', '50', '5'), { type: 'IN', qty: new Decimal(10), unitCost: '6' });
    expect([s(inn.totalCost), s(inn.newTotalQty), s(inn.newTotalValue), s(inn.newAvg), s(inn.writeOff)]).toEqual(['60', '20', '110', '5.5', '0']);
    const out = costMovement(state('20', '110', '5.5'), { type: 'OUT', qty: new Decimal(4) });
    expect([s(out.totalCost), s(out.newTotalValue), s(out.writeOff)]).toEqual(['22', '88', '0']);
  });

  it('an OUT that empties the item carries the remaining value (no residue, golden S6)', () => {
    const out = costMovement(state('14', '78.125', '5.580357'), { type: 'OUT', qty: new Decimal(14) });
    expect([s(out.totalCost), s(out.newTotalValue), s(out.writeOff)]).toEqual(['78.125', '0', '0']);
    // The last cost is kept for the next outflow or count surplus (DB-19).
    expect(s(out.newAvg)).toBe('5.580357');
  });

  it('keeps 6-decimal unit costs (TRADE-09)', () => {
    const inn = costMovement(state('0', '0', '0'), { type: 'IN', qty: new Decimal(12), unitCost: '0.833333' });
    expect([s(inn.unitCost), s(inn.totalCost)]).toEqual(['0.833333', '10']);
  });

  it('an explicit-cost OUT (purchase return at the original cost) moves exactly that value', () => {
    // Bought 10 @ 5 and 10 @ 15 (avg 10); return 5 of the first purchase at 5 (TRADE-03).
    const out = costMovement(state('20', '200', '10'), { type: 'OUT', qty: new Decimal(5), unitCost: '5', totalCost: '25' });
    expect([s(out.totalCost), s(out.newTotalValue), s(out.newAvg), s(out.writeOff)]).toEqual(['25', '175', '11.666667', '0']);
  });

  it('an explicit-cost OUT that empties the item writes the residue off (quantity 0 ⇒ value 0)', () => {
    const out = costMovement(state('5', '60', '12'), { type: 'OUT', qty: new Decimal(5), totalCost: '50' });
    expect([s(out.totalCost), s(out.newTotalValue), s(out.writeOff)]).toEqual(['50', '0', '10']);
  });

  it('an explicit-cost OUT never leaves a positive quantity with a negative value', () => {
    const out = costMovement(state('10', '10', '1'), { type: 'OUT', qty: new Decimal(5), totalCost: '25' });
    expect([s(out.newTotalValue), s(out.newAvg), s(out.writeOff)]).toEqual(['0', '0', '-15']);
  });

  it('a reversal mirrors the original movement exactly (DB-05)', () => {
    // Opening 10 @ 1, then 10 @ 3 (avg 2): reversing the opening takes out 10, not 20.
    const out = costMovement(state('20', '40', '2'), { type: 'OUT', qty: new Decimal(10), unitCost: '1', totalCost: '10' });
    expect([s(out.totalCost), s(out.newTotalValue), s(out.newAvg), s(out.writeOff)]).toEqual(['10', '30', '3', '0']);
  });

  it('negative stock: short sales at the last average, then reset at the incoming cost (ADR-018)', () => {
    // 2 on hand @ 5, sell 4 (allowNegativeStock): -2 valued -10, average kept.
    const sale = costMovement(state('2', '10', '5'), { type: 'OUT', qty: new Decimal(4) });
    expect([s(sale.totalCost), s(sale.newTotalQty), s(sale.newTotalValue), s(sale.newAvg), s(sale.writeOff)]).toEqual(['20', '-2', '-10', '5', '0']);
    // Buy 5 @ 6: 3 left, valued 3 × 6 = 18; the 2 sold short cost 1 more each → 2 written off.
    const buy = costMovement(state('-2', '-10', '5'), { type: 'IN', qty: new Decimal(5), unitCost: '6' });
    expect([s(buy.totalCost), s(buy.newTotalQty), s(buy.newTotalValue), s(buy.newAvg), s(buy.writeOff)]).toEqual(['30', '3', '18', '6', '2']);
  });

  it('a residue at quantity zero is written off by the next inflow', () => {
    const inn = costMovement(state('0', '0.004', '1'), { type: 'IN', qty: new Decimal(3), unitCost: '2' });
    expect([s(inn.newTotalValue), s(inn.newAvg), s(inn.writeOff)]).toEqual(['6', '2', '0.004']);
  });

  it('an inflow at no cost on an empty item uses the last known cost (count surplus)', () => {
    const inn = costMovement(state('0', '0', '4.5'), { type: 'IN', qty: new Decimal(2) });
    expect([s(inn.totalCost), s(inn.newAvg)]).toEqual(['9', '4.5']);
  });

  it('rejects a negative cost', () => {
    expect(() => costMovement(state('1', '1', '1'), { type: 'IN', qty: new Decimal(1), unitCost: '-1' })).toThrow();
  });
});
