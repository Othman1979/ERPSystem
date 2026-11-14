import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyReferenceDataPolicy,
  invalidateReferenceData,
  REFERENCE_DATA,
  REFERENCE_STALE_MS,
} from './referenceData';
import { ACCOUNTS_QUERY_KEY, selectCashBank, selectPostable, type AccountRow } from './hooks/useAccounts';

const write = (path: string) => ({ method: 'POST', path, status: 201 });

/** A chart-of-accounts row with neutral defaults; tests override what they check. */
function account(overrides: Pick<AccountRow, 'id' | 'code'> & Partial<AccountRow>): AccountRow {
  return {
    nameAr: 'حساب',
    nameEn: 'Account',
    parentId: null,
    level: 2,
    accountType: 'ASSET',
    normalBalance: 'DEBIT',
    isPostable: true,
    isControl: false,
    controlType: null,
    isActive: true,
    ...overrides,
  };
}

describe('reference-data cache policy (WEB-13)', () => {
  let client: QueryClient;
  let off: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient();
    off = applyReferenceDataPolicy(client);
  });

  afterEach(() => {
    off();
    client.clear();
    vi.useRealTimers();
  });

  it.each([
    [['accounts']],
    [['warehouses']],
    [['tax-categories']],
    [['branches']],
    [['units']],
    [['settings', 'unit']],
    [['settings', 'taxCategory']],
  ])('keeps %j fresh for 5 minutes', (queryKey) => {
    expect(client.getQueryDefaults(queryKey).staleTime).toBe(REFERENCE_STALE_MS);
  });

  it('leaves documents and balances at the default staleTime', () => {
    for (const key of [['sales-invoices'], ['stock-balances'], ['trial-balance'], ['settings', 'paymentMethod']]) {
      expect(client.getQueryDefaults(key).staleTime).toBeUndefined();
    }
  });

  function seed(...keys: string[][]) {
    for (const key of keys) client.setQueryData(key, []);
  }
  const invalidated = (key: string[]) => client.getQueryState(key)?.isInvalidated;

  it('expires the accounts after a cash box is created', async () => {
    seed(['accounts'], ['warehouses']);
    invalidateReferenceData(client, write('/cash-boxes'));
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidated(['accounts'])).toBe(true);
    expect(invalidated(['warehouses'])).toBe(false);
  });

  it('expires the units list of the settings screen after a unit is edited elsewhere', async () => {
    seed(['units'], ['settings', 'unit'], ['settings', 'paymentMethod']);
    invalidateReferenceData(client, { method: 'PATCH', path: '/units/4', status: 200 });
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidated(['units'])).toBe(true);
    expect(invalidated(['settings', 'unit'])).toBe(true);
    expect(invalidated(['settings', 'paymentMethod'])).toBe(false);
  });

  it('expires everything after the setup wizard provisions the chart', async () => {
    seed(['accounts'], ['warehouses'], ['tax-categories'], ['branches'], ['units']);
    invalidateReferenceData(client, write('/accounting/setup/provision'));
    await vi.advanceTimersByTimeAsync(500);
    for (const key of [['accounts'], ['warehouses'], ['tax-categories'], ['branches'], ['units']]) {
      expect(invalidated(key)).toBe(true);
    }
  });

  it('does nothing for writes to documents, or to a path that only starts like a reference one', async () => {
    seed(['accounts'], ['warehouses']);
    invalidateReferenceData(client, write('/sales-invoices'));
    invalidateReferenceData(client, write('/account-mappings/bulk'));
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidated(['accounts'])).toBe(false);
    expect(invalidated(['warehouses'])).toBe(false);
  });

  it("does not refetch a query the mutation's own onSuccess already invalidated", async () => {
    let fetches = 0;
    // A mounted screen's query; each fetch takes 100 ms, like a real request.
    const observer = new QueryObserver(client, {
      queryKey: ['warehouses'],
      queryFn: async () => {
        fetches += 1;
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(500);
    expect(fetches).toBe(1);
    // The page's onSuccess invalidates (and refetches) its key, then the runtime's
    // write notification arrives on the next tick while that refetch is in flight.
    void client.invalidateQueries({ queryKey: ['warehouses'] });
    invalidateReferenceData(client, write('/warehouses'));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetches).toBe(2);
    unsubscribe();
  });

  it('refetches a mounted query that no onSuccess invalidated', async () => {
    let fetches = 0;
    const observer = new QueryObserver(client, {
      queryKey: ['accounts'],
      queryFn: async () => {
        fetches += 1;
        return [];
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(500);
    invalidateReferenceData(client, write('/bank-accounts'));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetches).toBe(2);
    unsubscribe();
  });

  it('caches the chart under one key only', () => {
    expect(REFERENCE_DATA.find((f) => f.name === 'accounts')!.keys).toEqual([['accounts']]);
  });

  it('shares one cache entry between the all, postable and cash/bank views', async () => {
    const rows: AccountRow[] = [
      account({ id: 'cash', code: '1000', controlType: 'CASH' }),
      // Inactive, so only the cash/bank view keeps it.
      account({ id: 'old-bank', code: '1100', controlType: 'BANK', isActive: false }),
      // A header account: not postable, so only the all view keeps it.
      account({ id: 'header', code: '1', isPostable: false }),
    ];
    const queryFn = vi.fn(async () => rows);
    const all = new QueryObserver(client, { queryKey: ACCOUNTS_QUERY_KEY, queryFn });
    const postable = new QueryObserver(client, { queryKey: ACCOUNTS_QUERY_KEY, queryFn, select: selectPostable });
    const cashBank = new QueryObserver(client, { queryKey: ACCOUNTS_QUERY_KEY, queryFn, select: selectCashBank });
    const unsubscribes = [all, postable, cashBank].map((o) => o.subscribe(() => {}));
    await vi.advanceTimersByTimeAsync(10);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().findAll({ queryKey: ['accounts'] })).toHaveLength(1);
    expect(all.getCurrentResult().data).toEqual(rows);
    expect(postable.getCurrentResult().data).toEqual([rows[0]]);
    expect(cashBank.getCurrentResult().data).toEqual([rows[0], rows[1]]);
    for (const unsubscribe of unsubscribes) unsubscribe();
  });

  it('expires the shared accounts entry after an account is created', async () => {
    seed(['accounts']);
    invalidateReferenceData(client, write('/accounts'));
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidated(['accounts'])).toBe(true);
  });
});
