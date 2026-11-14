import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PARTY_USAGE_OWNERS, PartyUsageRegistry } from './party-usage.registry.js';

/** The checks only pass the transaction through; a stand-in object is enough here. */
const tx = {} as Prisma.TransactionClient;

describe('PartyUsageRegistry (DB-15, ADR-021)', () => {
  const unused = async () => null;

  it('lists every owner that references the party', async () => {
    const registry = new PartyUsageRegistry();
    for (const owner of PARTY_USAGE_OWNERS) registry.register(owner, unused);
    registry.register('journal', async () => 'journal_lines');
    registry.register('treasury', async () => 'receipts');
    await expect(registry.usage(tx, 1n)).resolves.toEqual(['treasury:receipts', 'journal:journal_lines']);
  });

  it('answers empty when no owner references the party', async () => {
    const registry = new PartyUsageRegistry();
    for (const owner of PARTY_USAGE_OWNERS) registry.register(owner, unused);
    await expect(registry.usage(tx, 1n)).resolves.toEqual([]);
  });

  it('fails closed when an owner has not registered its check', async () => {
    const registry = new PartyUsageRegistry();
    registry.register('sales', unused);
    registry.register('purchases', unused);
    registry.register('treasury', unused);
    const err = await registry.usage(tx, 1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(ErrorCode.INTERNAL);
    expect((err as DomainError).message).toContain('journal');
  });

  it('passes the transaction and the party id to each check, in owner order', async () => {
    const registry = new PartyUsageRegistry();
    const seen: bigint[] = [];
    for (const owner of PARTY_USAGE_OWNERS) {
      registry.register(owner, async (client, id) => {
        expect(client).toBe(tx);
        seen.push(id);
        return null;
      });
    }
    await registry.usage(tx, 42n);
    expect(seen).toEqual([42n, 42n, 42n, 42n]);
  });
});
