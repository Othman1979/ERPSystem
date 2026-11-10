import { apiFetchData } from '@erp/api-client';
import { Form, InputNumber, Typography } from 'antd';
import type { NamePath } from 'antd/es/form/interface';
import { useTranslation } from 'react-i18next';
import { dec, toDecimal } from '../format/number';

/**
 * Opening balances on the account, customer/supplier and item forms
 * (ADR-007). The API posts only the change against 3103, dated on the first
 * day of the first fiscal year.
 */
export interface Sides {
  debit: string;
  credit: string;
}

/** Why nothing can be saved right now: no fiscal year, closed first period, or no right to post. */
export type OpeningLockReason = 'NO_FISCAL_YEAR' | 'PERIOD_CLOSED' | 'NO_PERMISSION';

export interface OpeningSummary {
  date: string | null;
  fiscalYearCode: string | null;
  editable: boolean;
  /** For new accounts and parties. */
  lockedReason: OpeningLockReason | null;
  /** For new items' opening stock. */
  stockLockedReason: OpeningLockReason | null;
  equityAccountId: string;
  inventoryAccountId: string | null;
  accounts: (Sides & { accountId: string })[];
  totals: Sides;
  difference: Sides;
}

export type AccountLockReason =
  | 'GROUP_ACCOUNT'
  | 'INACTIVE_ACCOUNT'
  | 'INCOME_ACCOUNT'
  | 'CONTROL_ACCOUNT'
  | 'INVENTORY_ACCOUNT'
  | 'EQUITY_PLUG';

export interface AccountOpening extends Sides {
  accountId: string;
  date: string | null;
  editable: boolean;
  lockedReason: AccountLockReason | OpeningLockReason | null;
}

export type PartyRole = 'CUSTOMER' | 'SUPPLIER';

export interface PartyOpening {
  partyId: string;
  date: string | null;
  editable: boolean;
  lockedReason: OpeningLockReason | null;
  balances: (Sides & { partyType: PartyRole; accountId: string | null })[];
}

export type StockLockReason = 'SERVICE_ITEM' | 'HAS_MOVEMENTS' | 'SHARED_DOCUMENT' | OpeningLockReason;

export interface OpeningStockLine {
  warehouseId: string;
  qty: string;
  unitCost: string;
  value?: string;
}

export interface ItemOpening {
  itemId: string;
  date: string | null;
  lines: OpeningStockLine[];
  lockedReason: StockLockReason | null;
}

const put = <T,>(path: string, body: unknown) =>
  apiFetchData<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export const openingApi = {
  summary: () => apiFetchData<OpeningSummary>('/api/v1/opening-balances'),
  account: (id: string) => apiFetchData<AccountOpening>(`/api/v1/opening-balances/accounts/${id}`),
  setAccount: (id: string, sides: Partial<Sides>) =>
    put<AccountOpening>(`/api/v1/opening-balances/accounts/${id}`, sides),
  party: (id: string) => apiFetchData<PartyOpening>(`/api/v1/opening-balances/parties/${id}`),
  setParty: (id: string, partyType: PartyRole, sides: Partial<Sides>) =>
    put<PartyOpening>(`/api/v1/opening-balances/parties/${id}`, { partyType, ...sides }),
  itemStock: (id: string) => apiFetchData<ItemOpening>(`/api/v1/items/${id}/opening-stock`),
  setItemStock: (id: string, lines: OpeningStockLine[]) =>
    put<ItemOpening>(`/api/v1/items/${id}/opening-stock`, { lines }),
};

/** Form value of one side: blank when zero. */
export const sideValue = (v?: string | null) => {
  const d = toDecimal(v);
  return d && !d.isZero() ? d.toString() : undefined;
};

/** What the API takes for a side: a plain decimal string, or nothing. */
const asSide = (v: unknown) => {
  const d = toDecimal(v as string | null | undefined);
  return d && d.gt(0) ? d.toString() : undefined;
};

export const toSides = (v?: { debit?: unknown; credit?: unknown }): Partial<Sides> => ({
  debit: asSide(v?.debit),
  credit: asSide(v?.credit),
});

/** True when the two balances are the same amount on the same side. */
export function sameSides(a: Partial<Sides>, b: Partial<Sides>): boolean {
  const n = (s: Partial<Sides>) => dec(s.debit ?? 0).minus(dec(s.credit ?? 0));
  return n(a).eq(n(b));
}

const positive = (v: unknown) => {
  const d = toDecimal(v as string | null | undefined);
  return !!d && d.gt(0);
};

/** Debit and credit inputs for `name` (e.g. ['opening']); one side only. */
export function OpeningSideFields({ name, disabled }: { name: (string | number)[]; disabled?: boolean }) {
  const { t } = useTranslation();
  const debit: NamePath = [...name, 'debit'];
  const credit: NamePath = [...name, 'credit'];
  return (
    <>
      <Form.Item name={debit} label={t('journal.debit')}>
        <InputNumber<string> stringMode min="0" step="0.001" disabled={disabled} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        name={credit}
        label={t('journal.credit')}
        dependencies={[debit]}
        rules={[
          ({ getFieldValue }) => ({
            validator: (_, v) =>
              positive(v) && positive(getFieldValue(debit))
                ? Promise.reject(new Error(t('opening.oneSide')))
                : Promise.resolve(),
          }),
        ]}
      >
        <InputNumber<string> stringMode min="0" step="0.001" disabled={disabled} style={{ width: '100%' }} />
      </Form.Item>
    </>
  );
}

/** One muted line under an opening section (when it posts, or why it's locked). */
export function OpeningNote({ children }: { children: React.ReactNode }) {
  return (
    <Typography.Text type="secondary" className="span-all" style={{ fontSize: 12 }}>
      {children}
    </Typography.Text>
  );
}
