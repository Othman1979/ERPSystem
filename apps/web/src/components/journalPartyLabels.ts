export type JournalDraftPartyLabel =
  | { label: string; partyType: 'CUSTOMER' | 'SUPPLIER' }
  | string;

export type JournalDraftPartyLabels = Record<string, JournalDraftPartyLabel>;

type PartyOption = { value: string; label: string };
type PartyOptions = Record<'CUSTOMER' | 'SUPPLIER' | 'ANY', PartyOption[]>;

export function partyOptionsWithDraftLabels(
  options: PartyOptions,
  labels: JournalDraftPartyLabels,
): PartyOptions {
  const result = {
    CUSTOMER: [...options.CUSTOMER],
    SUPPLIER: [...options.SUPPLIER],
    ANY: [...options.ANY],
  };
  for (const [id, saved] of Object.entries(labels)) {
    const label = typeof saved === 'string' ? saved : saved.label;
    const kinds = typeof saved === 'string' ? ['ANY'] as const : [saved.partyType, 'ANY'] as const;
    for (const kind of kinds) {
      if (!result[kind].some((option) => option.value === id)) {
        result[kind].push({ value: id, label });
      }
    }
  }
  return result;
}

export function partyLabelFromDraft(labels: JournalDraftPartyLabels, id: string | null | undefined) {
  const saved = id ? labels[id] : undefined;
  return typeof saved === 'string' ? saved : saved?.label;
}
