import { useQueries, useQuery } from '@tanstack/react-query';
import {
  accountingControllerListMappings,
  partiesControllerGet,
  partiesControllerList,
  type AccountDto,
  type PartyDto,
} from '@erp/api-client';
import { codeAndName } from '../i18n/displayName';
import { PICKER_PAGE_SIZE, useRemoteOptions } from '../hooks/useRemoteOptions';
import type { PartyColumn } from './JournalLinesGrid';
import { partyNeedByAccount, type PartyKind, type PartyNeed } from './journalLineChecks';

type Party = PartyDto;

type AccountLike = Pick<AccountDto, 'id' | 'isControl' | 'controlType'>;

/** The one cache key of the account mappings (shared with the opening balances screen). */
const MAPPINGS_QUERY_KEY = ['account-mappings'] as const;

/**
 * Parties for one picker. A side's picker lists that side's parties plus BOTH
 * ones; the API matches partyType exactly, so this asks twice (ADR-022 §8).
 * 'ANY' (a control account of no side) lists every party in one request.
 */
function pickParties(need: PartyNeed, q: string | undefined, signal: AbortSignal): Promise<Party[]> {
  const base = { isActive: 'true', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) } as const;
  if (need === 'ANY') {
    return partiesControllerList(base, { signal }).then((r) => r.data.items);
  }
  const types = [need, 'BOTH'] as const;
  return Promise.all(
    types.map((partyType) =>
      partiesControllerList({ ...base, partyType }, { signal }).then((r) => r.data.items),
    ),
  ).then((pages) => pages.flat());
}

/**
 * Party column for JournalLinesGrid: which accounts need a customer or a
 * supplier (decision D-2, `partyNeedByAccount`), and the parties to pick from.
 * The picker searches on the server (ADR-022 §8); `partyName` labels any party
 * shown on a line, including inactive ones, and fetches the ones not seen yet
 * (a saved entry carries ids only).
 *
 * `shownPartyIds`: the party ids on the lines on screen, so a chosen party keeps its label.
 * `enabled`: fetch the picker options (false while no grid is shown).
 */
export function usePartyColumn(
  accounts: readonly AccountLike[] | undefined,
  {
    shownPartyIds,
    enabled = true,
  }: { shownPartyIds: readonly (string | null | undefined)[]; enabled?: boolean },
): {
  partyColumn: PartyColumn;
  partyName: (partyId: string | null | undefined) => string | undefined;
} {
  // A legacy chart maps CUSTOMERS_CONTROL / SUPPLIERS_CONTROL to an account
  // without control flags; the mappings say which one needs a party. Only
  // the grid needs this (a saved entry's lines already carry their party).
  const mappings = useQuery({
    queryKey: MAPPINGS_QUERY_KEY,
    queryFn: ({ signal }) => accountingControllerListMappings({ signal }).then((r) => r.data),
    enabled,
  });
  const kindByAccount = partyNeedByAccount(accounts, mappings.data);
  const anyNeeded = [...kindByAccount.values()].includes('ANY');

  const customers = useRemoteOptions<Party>({
    key: ['parties', 'pick-journal', 'CUSTOMER'],
    fetch: (q, signal) => pickParties('CUSTOMER', q, signal),
    enabled,
  });
  const suppliers = useRemoteOptions<Party>({
    key: ['parties', 'pick-journal', 'SUPPLIER'],
    fetch: (q, signal) => pickParties('SUPPLIER', q, signal),
    enabled,
  });
  // Only charts with a control account of no side need this list.
  const either = useRemoteOptions<Party>({
    key: ['parties', 'pick-journal', 'ANY'],
    fetch: (q, signal) => pickParties('ANY', q, signal),
    enabled: enabled && anyNeeded,
  });
  const pickers = { CUSTOMER: customers, SUPPLIER: suppliers, ANY: either } as const;

  const rememberedParty = (id: string | null | undefined): Party | undefined =>
    customers.byId(id) ?? suppliers.byId(id) ?? either.byId(id);
  // Parties on screen that no search has returned yet (e.g. a saved entry): one GET each.
  const unknownIds = [...new Set(shownPartyIds.filter((id): id is string => !!id))].filter(
    (id) => !rememberedParty(id),
  );
  const fetched = useQueries({
    queries: unknownIds.map((id) => ({
      queryKey: ['parties', 'detail', id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        partiesControllerGet(id, { signal }).then((r) => r.data),
    })),
  });
  const fetchedById = new Map<string, Party>();
  unknownIds.forEach((id, i) => {
    const row = fetched[i]?.data;
    if (row) fetchedById.set(id, row);
  });
  const partyOf = (id: string | null | undefined) =>
    id ? (rememberedParty(id) ?? fetchedById.get(id)) : undefined;

  const optionsOf = (need: PartyNeed) =>
    pickers[need].withSelected(shownPartyIds).map((p) => ({ value: p.id, label: codeAndName(p) }));

  return {
    partyColumn: {
      kindByAccount,
      options: { CUSTOMER: optionsOf('CUSTOMER'), SUPPLIER: optionsOf('SUPPLIER'), ANY: optionsOf('ANY') },
      onSearch: { CUSTOMER: customers.onSearch, SUPPLIER: suppliers.onSearch, ANY: either.onSearch },
      searching: { CUSTOMER: customers.pending, SUPPLIER: suppliers.pending, ANY: either.pending },
      // On an account of no side the line takes the party's own side; a BOTH party counts as a customer.
      sideOf: (partyId): PartyKind | undefined => {
        const party = partyOf(partyId);
        if (!party) return undefined;
        return party.partyType === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER';
      },
    },
    partyName: (partyId) => {
      const party = partyOf(partyId);
      return party ? codeAndName(party) : undefined;
    },
  };
}
