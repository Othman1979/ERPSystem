import type { Prisma } from '../../generated/prisma/client.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { isLoweringLevel, ProcurementCycleRegistry } from './procurement-level.js';

const tx = {} as Prisma.TransactionClient;

const refusal = async (registry: ProcurementCycleRegistry, from: 'FULL' | 'MEDIUM', to: 'MEDIUM' | 'SIMPLE') => {
  const err = await registry.assertLevelChange(tx, from, to).catch((e: unknown) => e);
  return err === undefined ? null : (err as DomainError);
};

describe('Procurement level changes (ADR-024 §2.2, ADR-025 §6)', () => {
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
    registry.register({ key: 'purchaseQuotes', level: 'FULL', count: async () => 3 });
    registry.register({ key: 'purchaseRequests', level: 'FULL', count: async () => 0 });
    const err = await refusal(registry, 'FULL', 'MEDIUM');
    expect(err).toBeInstanceOf(DomainError);
    expect(err!.code).toBe(ErrorCode.PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS);
    expect(err!.getStatus()).toBe(409);
    expect(err!.details).toEqual({ from: 'FULL', to: 'MEDIUM', openDocuments: { purchaseQuotes: 3 } });
  });

  it('counts only the documents the target level drops: orders hold SIMPLE, not MEDIUM', async () => {
    const registry = new ProcurementCycleRegistry();
    const counted: string[] = [];
    registry.register({ key: 'purchaseRequests', level: 'FULL', count: async () => (counted.push('purchaseRequests'), 0) });
    registry.register({ key: 'purchaseOrders', level: 'MEDIUM', count: async () => (counted.push('purchaseOrders'), 2) });
    expect(await refusal(registry, 'FULL', 'MEDIUM')).toBeNull();
    expect(counted).toEqual(['purchaseRequests']);
    expect((await refusal(registry, 'FULL', 'SIMPLE'))!.details).toEqual({ from: 'FULL', to: 'SIMPLE', openDocuments: { purchaseOrders: 2 } });
    expect((await refusal(registry, 'MEDIUM', 'SIMPLE'))!.code).toBe(ErrorCode.PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS);
  });

  it('never counts for a raise', async () => {
    const registry = new ProcurementCycleRegistry();
    let calls = 0;
    registry.register({ key: 'x', level: 'MEDIUM', count: async () => (calls += 1) });
    await registry.assertLevelChange(tx, 'SIMPLE', 'FULL');
    expect(calls).toBe(0);
  });

  it('refuses the same counter twice', () => {
    const registry = new ProcurementCycleRegistry();
    registry.register({ key: 'x', level: 'FULL', count: async () => 0 });
    expect(() => registry.register({ key: 'x', level: 'FULL', count: async () => 0 })).toThrow('registered twice');
  });
});
