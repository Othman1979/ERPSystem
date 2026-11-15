import { DomainError } from '../../common/errors/domain.error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { COST_CENTER_USAGE_OWNERS, CostCenterUsageRegistry } from './cost-center-usage.registry.js';

const tx = {} as Prisma.TransactionClient;

describe('CostCenterUsageRegistry (ADR-024 §1.7)', () => {
  it('refuses to answer while an owner has not registered (blocks, never lets a delete through)', async () => {
    const registry = new CostCenterUsageRegistry();
    registry.register('journal', async () => null);
    await expect(registry.usage(tx, 1n)).rejects.toBeInstanceOf(DomainError);
  });

  it('lists every owner that references the centre, in a fixed order', async () => {
    const registry = new CostCenterUsageRegistry();
    const seen: string[] = [];
    for (const owner of COST_CENTER_USAGE_OWNERS) {
      registry.register(owner, async (_tx, id) => {
        seen.push(owner);
        return id === 1n && (owner === 'sales' || owner === 'journal') ? `${owner}_table` : null;
      });
    }
    expect(await registry.usage(tx, 1n)).toEqual(['journal:journal_table', 'sales:sales_table']);
    expect(await registry.usage(tx, 2n)).toEqual([]);
    expect(seen).toEqual([...COST_CENTER_USAGE_OWNERS, ...COST_CENTER_USAGE_OWNERS]);
  });
});
