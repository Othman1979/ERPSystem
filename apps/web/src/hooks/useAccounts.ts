import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { accountingControllerListAccounts, type AccountDto } from '@erp/api-client';

/** The one cache key of the chart of accounts (WEB-13): every screen shares it. */
export const ACCOUNTS_QUERY_KEY = ['accounts'] as const;

/** A row of GET /accounts: a flat list of accounts (no children; screens build the tree themselves). */
export type AccountRow = AccountDto;

/** Active accounts that take journal lines. Module-level so `select` stays memoised. */
export const selectPostable = (rows: AccountRow[]): AccountRow[] => rows.filter((a) => a.isActive && a.isPostable);

/** Cash and bank accounts (receipts, payments, cash invoices). */
export const selectCashBank = (rows: AccountRow[]): AccountRow[] =>
  rows.filter((a) => a.controlType === 'CASH' || a.controlType === 'BANK');

/**
 * The chart of accounts, fetched once per 5 minutes (reference-data policy in
 * referenceData.ts) whichever screen asks. Pass a module-level `select`
 * (selectPostable, selectCashBank) for a derived view; without one, every account.
 */
export function useAccounts(): UseQueryResult<AccountRow[], Error>;
export function useAccounts<T>(select: (rows: AccountRow[]) => T): UseQueryResult<T, Error>;
export function useAccounts<T>(select?: (rows: AccountRow[]) => T): UseQueryResult<T, Error> {
  return useQuery<AccountRow[], Error, T>({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: ({ signal }) =>
      accountingControllerListAccounts({ signal }).then((r) => r.data),
    // Without a select, TData is AccountRow[] (the overloads above guarantee it).
    select: select as ((rows: AccountRow[]) => T) | undefined,
  });
}
