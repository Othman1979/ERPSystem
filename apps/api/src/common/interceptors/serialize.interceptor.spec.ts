import { lastValueFrom, of } from 'rxjs';
import { SerializeInterceptor } from './serialize.interceptor.js';

describe('SerializeInterceptor', () => {
  const interceptor = new SerializeInterceptor();

  function run(data: unknown): Promise<unknown> {
    const context = {} as never;
    const handler = { handle: () => of(data) } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return lastValueFrom(interceptor.intercept(context, handler) as any);
  }

  it('serializes bigint as string', async () => {
    await expect(run({ id: 10n })).resolves.toEqual({ id: '10' });
  });

  it('serializes nested bigints inside arrays and objects', async () => {
    await expect(run({ items: [{ qty: 5n }], total: 42n })).resolves.toEqual({
      items: [{ qty: '5' }],
      total: '42',
    });
  });

  it('leaves plain values untouched', async () => {
    await expect(run({ a: 1, b: 'x', c: null, d: true })).resolves.toEqual({
      a: 1,
      b: 'x',
      c: null,
      d: true,
    });
  });
});
