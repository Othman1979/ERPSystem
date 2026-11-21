import type { Prisma } from '../../generated/prisma/client.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { YEAR_CLOSING_DRAFT_TYPES, YearClosingDraftRegistry } from './year-closing-draft.registry.js';

describe('YearClosingDraftRegistry', () => {
  const tx = {} as Prisma.TransactionClient;
  const from = new Date('2031-01-01T00:00:00.000Z');
  const to = new Date('2031-12-31T00:00:00.000Z');

  it('includes payroll settlements among required draft readers', () => {
    expect(YEAR_CLOSING_DRAFT_TYPES).toContain('PAYROLL_SETTLEMENT');
  });

  it('requires every expected document type to register', async () => {
    const registry = new YearClosingDraftRegistry();
    await expect(registry.list(tx, 1n, 2n, from, to)).rejects.toBeInstanceOf(DomainError);
    await expect(registry.list(tx, 1n, 2n, from, to)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining(YEAR_CLOSING_DRAFT_TYPES[0]),
    });
  });

  it('collects each registered type in date and type order', async () => {
    const registry = new YearClosingDraftRegistry();
    for (const type of YEAR_CLOSING_DRAFT_TYPES) {
      registry.register(type, async () => [{
        type,
        id: type,
        date: '2031-06-01',
        reference: null,
        description: `${type} draft`,
      }]);
    }

    const drafts = await registry.list(tx, 1n, 2n, from, to);
    expect(drafts).toHaveLength(YEAR_CLOSING_DRAFT_TYPES.length);
    expect(drafts.map((draft) => draft.type)).toEqual([...YEAR_CLOSING_DRAFT_TYPES].sort());
  });
});
