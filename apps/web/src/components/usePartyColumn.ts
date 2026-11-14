import { useQuery } from '@tanstack/react-query';
import { partiesControllerList } from '@erp/api-client';
import { useMemo } from 'react';
import { codeAndName } from '../i18n/displayName';
import { partyKindOf, type PartyColumn, type PartyKind } from './JournalLinesGrid';

interface Party {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  partyType: PartyKind | 'BOTH';
  isActive?: boolean;
}

interface AccountLike {
  id: string;
  controlType?: string | null;
}

/**
 * Party column for JournalLinesGrid: which accounts are customer / supplier
 * control accounts, and the active parties to pick from. `partyName` labels
 * any party (inactive ones too) on a saved entry.
 */
export function usePartyColumn(accounts: AccountLike[] | undefined): {
  partyColumn: PartyColumn;
  partyName: (partyId: string | null | undefined) => string | undefined;
} {
  const parties = useQuery({
    queryKey: ['parties', 'all'],
    queryFn: ({ signal }) =>
      partiesControllerList({ partyType: '', isActive: '' }, { signal }).then((r) => r.data as unknown as Party[]),
  });

  return useMemo(() => {
    const kindByAccount = new Map<string, PartyKind>();
    for (const a of accounts ?? []) {
      const kind = partyKindOf(a.controlType);
      if (kind) kindByAccount.set(a.id, kind);
    }
    const all = parties.data ?? [];
    const optionsOf = (kind: PartyKind) =>
      all
        // A BOTH party is a customer and a supplier.
        .filter((p) => (p.partyType === kind || p.partyType === 'BOTH') && p.isActive !== false)
        .map((p) => ({ value: p.id, label: codeAndName(p) }));
    const byId = new Map(all.map((p) => [p.id, p]));
    return {
      partyColumn: {
        kindByAccount,
        options: { CUSTOMER: optionsOf('CUSTOMER'), SUPPLIER: optionsOf('SUPPLIER') },
      },
      partyName: (partyId) => (partyId ? codeAndName(byId.get(partyId)) : undefined),
    };
  }, [accounts, parties.data]);
}
