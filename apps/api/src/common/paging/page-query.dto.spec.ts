import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import {
  KeysetQueryDto,
  PageQueryDto,
  SortParam,
  keysetLimit,
  orderByOf,
  pageWindow,
  sortValues,
  type SortDirection,
} from './page-query.dto.js';

/** Builds the DTO from query-string values (strings), as the API receives them, and validates it. */
async function check<T extends object>(cls: ClassConstructor<T>, input: Record<string, string>) {
  const dto = plainToInstance(cls, input);
  const errors = await validate(dto);
  return { dto, failed: errors.map((e) => e.property) };
}

describe('PageQueryDto', () => {
  it('turns page and pageSize strings into numbers', async () => {
    const { dto, failed } = await check(PageQueryDto, { page: '2', pageSize: '100' });
    expect(failed).toEqual([]);
    expect(dto.page).toBe(2);
    expect(dto.pageSize).toBe(100);
  });

  it.each(['0', '-1', '1.5', 'abc', '10001'])('refuses page %s', async (page) => {
    const { failed } = await check(PageQueryDto, { page });
    expect(failed).toEqual(['page']);
  });

  it('accepts pageSize 100 and refuses 101', async () => {
    expect((await check(PageQueryDto, { pageSize: '100' })).failed).toEqual([]);
    expect((await check(PageQueryDto, { pageSize: '101' })).failed).toEqual(['pageSize']);
  });

  it('trims q', async () => {
    const { dto, failed } = await check(PageQueryDto, { q: '  abc  ' });
    expect(failed).toEqual([]);
    expect(dto.q).toBe('abc');
  });

  it('treats a blank q as not given', async () => {
    const { dto, failed } = await check(PageQueryDto, { q: '   ' });
    expect(failed).toEqual([]);
    expect(dto.q).toBeUndefined();
  });

  it('refuses q longer than 100 characters', async () => {
    const { failed } = await check(PageQueryDto, { q: 'a'.repeat(101) });
    expect(failed).toEqual(['q']);
  });

  it('measures q after trimming, so 100 characters with padding is accepted', async () => {
    const { failed } = await check(PageQueryDto, { q: `  ${'a'.repeat(100)}  ` });
    expect(failed).toEqual([]);
  });

});

/** A list DTO as the lists build it: the base query plus its own `sort` property. */
class SortedListDto extends PageQueryDto {
  @SortParam(sortValues(['invoiceDate', 'grandTotal']), '-invoiceDate')
  sort?: string;
}

describe('SortParam', () => {
  it('accepts a descending and an ascending allowed key', async () => {
    const desc = await check(SortedListDto, { sort: '-invoiceDate' });
    expect(desc.failed).toEqual([]);
    expect(desc.dto.sort).toBe('-invoiceDate');
    expect((await check(SortedListDto, { sort: 'grandTotal' })).failed).toEqual([]);
  });

  it.each(['invoice-date', '--invoiceDate', 'id'])('refuses sort %s', async (sort) => {
    const { failed } = await check(SortedListDto, { sort });
    expect(failed).toEqual(['sort']);
  });
});

describe('KeysetQueryDto', () => {
  it('accepts limit 500 and refuses 501 and 0', async () => {
    expect((await check(KeysetQueryDto, { limit: '500' })).failed).toEqual([]);
    expect((await check(KeysetQueryDto, { limit: '501' })).failed).toEqual(['limit']);
    expect((await check(KeysetQueryDto, { limit: '0' })).failed).toEqual(['limit']);
  });

  it('accepts a cursor of 512 characters and refuses 513', async () => {
    expect((await check(KeysetQueryDto, { cursor: 'c'.repeat(512) })).failed).toEqual([]);
    expect((await check(KeysetQueryDto, { cursor: 'c'.repeat(513) })).failed).toEqual(['cursor']);
  });
});

describe('pageWindow and keysetLimit', () => {
  it('defaults the numbered window to page 1 of 20', () => {
    expect(pageWindow({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('keeps the given page and pageSize', () => {
    expect(pageWindow({ page: 3, pageSize: 50 })).toEqual({ page: 3, pageSize: 50 });
  });

  it('defaults the keyset limit to 100', () => {
    expect(keysetLimit({})).toBe(100);
    expect(keysetLimit({ limit: 40 })).toBe(40);
  });
});

describe('sortValues', () => {
  it('lists each key ascending and descending', () => {
    expect(sortValues(['a', 'b'])).toEqual(['a', '-a', 'b', '-b']);
  });
});

describe('orderByOf', () => {
  type Key = 'invoiceDate' | 'amount';
  type Order = Record<string, SortDirection>;

  const keys: Record<Key, (dir: SortDirection) => Order> = {
    invoiceDate: (dir) => ({ invoiceDate: dir }),
    amount: (dir) => ({ amount: dir }),
  };
  const idOrder = (dir: SortDirection): Order => ({ id: dir });
  const order = (sort: string | undefined, fallback: Key | `-${Key}`) =>
    orderByOf<Key, Order>(sort, fallback, keys, idOrder);

  it('uses the fallback when sort is not given', () => {
    expect(order(undefined, '-amount')).toEqual([{ amount: 'desc' }, { id: 'desc' }]);
    expect(order(undefined, 'invoiceDate')).toEqual([{ invoiceDate: 'asc' }, { id: 'asc' }]);
  });

  it('sorts descending for a - prefix, on the key and on id', () => {
    expect(order('-invoiceDate', 'amount')).toEqual([{ invoiceDate: 'desc' }, { id: 'desc' }]);
  });

  it('sorts ascending without a prefix, on the key and on id', () => {
    expect(order('amount', '-invoiceDate')).toEqual([{ amount: 'asc' }, { id: 'asc' }]);
  });

  it.each(['bogus', '-bogus', 'constructor', 'toString'])('falls back when the key %s is unknown', (sort) => {
    expect(order(sort, '-amount')).toEqual([{ amount: 'desc' }, { id: 'desc' }]);
  });

  it('always puts id last, in the same direction as the key', () => {
    const asc = order('amount', 'invoiceDate');
    const desc = order('-amount', 'invoiceDate');
    expect(asc[asc.length - 1]).toEqual({ id: 'asc' });
    expect(desc[desc.length - 1]).toEqual({ id: 'desc' });
  });
});
