import { useQueries } from '@tanstack/react-query';
import { partiesControllerGet, partiesControllerList, type PartyDto } from '@erp/api-client';
import { codeAndName } from '../i18n/displayName';
import { PICKER_PAGE_SIZE, useRemoteOptions } from '../hooks/useRemoteOptions';
import { partyKindOf, type PartyColumn, type PartyKind } from './JournalLinesGrid';

type Party = PartyDto;

interface AccountLike {
  id: string;
  controlType?: string | null;
}

/**
 * Parties of one side for the picker: the side's own parties plus BOTH ones.
 * The API matches partyType exactly, so this asks twice (ADR-022 §8).
 */
function pickParties(kind: PartyKind, q: string | undefined, signal: AbortSignal): Promise<Party[]> {
  const types = [kind, 'BOTH'] as const;
  return Promise.all(
    types.map((partyType) =>
      partiesControllerList(
        { partyType, isActive: 'true', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) },
        { signal },
      ).then((r) => r.data.items),
    ),
  ).then((pages) => pages.flat());
}

/**
 * Party column for JournalLinesGrid: which accounts are customer / supplier
 * control accounts, and the parties to pick from. The picker searches on the
 * server (ADR-022 §8); `partyName` labels any party shown on a line, including
 * inactive ones, and fetches the ones not seen yet (a saved entry carries ids only).
 *
 * `shownPartyIds`: the party ids on the lines on screen, so a chosen party keeps its label.
 * `enabled`: fetch the picker options (false while no grid is shown).
 */
export function usePartyColumn(
  accounts: AccountLike[] | undefined,
  {
    shownPartyIds,
    enabled = true,
  }: { shownPartyIds: readonly (string | null | undefined)[]; enabled?: boolean },
): {
  partyColumn: PartyColumn;
  partyName: (partyId: string | null | undefined) => string | undefined;
} {
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

  const kindByAccount = new Map<string, PartyKind>();
  for (const a of accounts ?? []) {
    const kind = partyKindOf(a.controlType);
    if (kind) kindByAccount.set(a.id, kind);
  }

  const rememberedParty = (id: string | null | undefined): Party | undefined =>
    customers.byId(id) ?? suppliers.byId(id);
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

  const optionsOf = (kind: PartyKind) =>
    (kind === 'CUSTOMER' ? customers : suppliers)
      .withSelected(shownPartyIds)
      .map((p) => ({ value: p.id, label: codeAndName(p) }));

  return {
    partyColumn: {
      kindByAccount,
      options: { CUSTOMER: optionsOf('CUSTOMER'), SUPPLIER: optionsOf('SUPPLIER') },
      onSearch: { CUSTOMER: customers.onSearch, SUPPLIER: suppliers.onSearch },
    },
    partyName: (partyId) => {
      if (!partyId) return undefined;
      const party = rememberedParty(partyId) ?? fetchedById.get(partyId);
      return party ? codeAndName(party) : undefined;
    },
  };
}
