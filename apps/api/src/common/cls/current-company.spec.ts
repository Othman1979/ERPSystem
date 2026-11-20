import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from './cls.types.js';
import { withAllCompanies } from './current-company.js';

const cls = ClsServiceManager.getClsService<RequestContext>();

describe('withAllCompanies', () => {
  it('clears the company in a child context and preserves the parent context', async () => {
    await cls.run({ ifNested: 'override' }, async () => {
      cls.set('tenantId', 41n);
      cls.set('companyId', 12n);

      await withAllCompanies(async () => {
        expect(cls.get('tenantId')).toBe(41n);
        expect(cls.get('companyId')).toBeUndefined();
      });

      expect(cls.get('companyId')).toBe(12n);
    });
  });

  it('awaits lazy promise-like results inside the child context', async () => {
    await cls.run({ ifNested: 'override' }, async () => {
      cls.set('companyId', 12n);

      const companyId = await withAllCompanies(
        () =>
          ({
            then(resolve: (value: bigint | undefined) => void) {
              resolve(cls.get('companyId'));
            },
          }) as unknown as Promise<bigint | undefined>,
      );

      expect(companyId).toBeUndefined();
      expect(cls.get('companyId')).toBe(12n);
    });
  });
});
