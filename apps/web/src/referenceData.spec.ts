import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyReferenceDataPolicy, invalidateReferenceData, REFERENCE_STALE_MS } from './referenceData';

const write = (path: string) => ({ method: 'POST', path, status: 201 });

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
    [['accounts-postable']],
    [['accounts-tree']],
    [['accounts-all']],
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

  it('expires every cached copy of the accounts after a cash box is created', async () => {
    seed(['accounts'], ['accounts-tree'], ['accounts-postable'], ['warehouses']);
    invalidateReferenceData(client, write('/cash-boxes'));
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidated(['accounts'])).toBe(true);
    expect(invalidated(['accounts-tree'])).toBe(true);
    expect(invalidated(['accounts-postable'])).toBe(true);
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
    seed(['accounts-tree'], ['warehouses'], ['tax-categories'], ['branches'], ['units']);
    invalidateReferenceData(client, write('/accounting/setup/provision'));
    await vi.advanceTimersByTimeAsync(500);
    for (const key of [['accounts-tree'], ['warehouses'], ['tax-categories'], ['branches'], ['units']]) {
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
      queryKey: ['accounts-tree'],
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
});
