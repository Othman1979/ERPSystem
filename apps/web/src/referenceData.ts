import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { onApiWrite, type ApiWrite } from '@erp/api-client';

/**
 * How long reference data stays fresh in the cache (owner decision, WEB-13):
 * screens opened within this time reuse it instead of fetching it again.
 */
export const REFERENCE_STALE_MS = 5 * 60_000;

export interface ReferenceFamily {
  name: string;
  /** Query-key prefixes that hold this data. */
  keys: QueryKey[];
  /** API paths (under /api/v1) whose successful writes change this data. */
  writes: RegExp;
}

/** Writes that can create any reference data: chart provisioning and the setup wizard. */
const SETUP = 'accounting/setup|company/onboarding';

export const REFERENCE_DATA: ReferenceFamily[] = [
  {
    name: 'accounts',
    keys: [['accounts']],
    // Cash boxes and bank accounts create and rename GL accounts too.
    writes: new RegExp(`^/(accounts|cash-boxes|bank-accounts|${SETUP})(/|$)`),
  },
  {
    name: 'warehouses',
    keys: [['warehouses']],
    // Warehouse rows show their branch.
    writes: new RegExp(`^/(warehouses|branches|${SETUP})(/|$)`),
  },
  {
    name: 'taxes',
    keys: [['tax-categories'], ['settings', 'taxCategory']],
    writes: new RegExp(`^/(tax-categories|${SETUP})(/|$)`),
  },
  {
    name: 'branches',
    keys: [['branches']],
    writes: new RegExp(`^/(branches|${SETUP})(/|$)`),
  },
  {
    name: 'units',
    keys: [['units'], ['settings', 'unit']],
    writes: new RegExp(`^/(units|${SETUP})(/|$)`),
  },
];

/**
 * Expires every cached copy of the reference data a write changed, whichever
 * screen made the write and whichever key a screen caches it under. Runs after
 * the mutation's own onSuccess (next tick), and skips queries that onSuccess
 * already invalidated, so nothing is fetched twice.
 */
export function invalidateReferenceData(client: QueryClient, write: ApiWrite): void {
  const families = REFERENCE_DATA.filter((f) => f.writes.test(write.path));
  if (families.length === 0) return;
  setTimeout(() => {
    // Pick the targets first: invalidateQueries applies its filters again when
    // it refetches, by which time every target is invalidated.
    const cache = client.getQueryCache();
    const targets = new Set(
      families.flatMap((f) => f.keys.flatMap((queryKey) => cache.findAll({ queryKey }))).filter((q) => !q.state.isInvalidated),
    );
    if (targets.size > 0) void client.invalidateQueries({ predicate: (q) => targets.has(q) });
  }, 0);
}

/**
 * Applies the reference-data cache policy to the app's QueryClient: a
 * 5-minute staleTime for those keys and invalidation on every write to them.
 * Returns the function that removes the write listener.
 */
export function applyReferenceDataPolicy(client: QueryClient): () => void {
  for (const family of REFERENCE_DATA) {
    for (const queryKey of family.keys) client.setQueryDefaults(queryKey, { staleTime: REFERENCE_STALE_MS });
  }
  return onApiWrite((write) => invalidateReferenceData(client, write));
}
