import type { Prisma } from '../../generated/prisma/client.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { isLoweringLevel, ProcurementCycleRegistry } from './procurement-level.js';

const tx = {} as Prisma.TransactionClient;

describe('Procurement level changes (ADR-024 §2.2)', () => {
  it('orders SIMPLE < MEDIUM < FULL', () => {
    expect(isLoweringLevel('FULL', 'MEDIUM')).toBe(true);
    expect(isLoweringLevel('MEDIUM', 'SIMPLE')).toBe(true);
    expect(isLoweringLevel('SIMPLE', 'FULL')).toBe(false);
    expect(isLoweringLevel('MEDIUM', 'MEDIUM')).toBe(false);
  });

  it('ships with no counter: every change passes', async () => {
    const registry = new ProcurementCycleRegistry();
    expect(registry.keys()).toEqual([]);
    await expect(registry.assertLevelChange(tx, 'FULL', 'SIMPLE')).resolves.toBeUndefined();
  });

  it('refuses a lowering while a counter reports open documents, with the counts by kind', async () => {
    const registry = new ProcurementCycleRegistry();
    registry.register({ key: 'purchaseOrders', count: async () => 3 });
    registry.register({ key: 'purchaseRequests', count: async () => 0 });
    const err = await registry.assertLevelChange(tx, 'FULL', 'MEDIUM').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(ErrorCode.PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS);
    expect((err as DomainError).getStatus()).toBe(409);
    expect((err as DomainError).details).toEqual({ from: 'FULL', to: 'MEDIUM', openDocuments: { purchaseOrders: 3 } });
  });

  it('never counts for a raise', async () => {
    const registry = new ProcurementCycleRegistry();
    let calls = 0;
    registry.register({ key: 'x', count: async () => (calls += 1) });
    await registry.assertLevelChange(tx, 'SIMPLE', 'FULL');
    expect(calls).toBe(0);
  });

  it('refuses the same counter twice', () => {
    const registry = new ProcurementCycleRegistry();
    registry.register({ key: 'x', count: async () => 0 });
    expect(() => registry.register({ key: 'x', count: async () => 0 })).toThrow('registered twice');
  });
});
