import { describe, expect, it } from 'vitest';
import { partyOptionsWithDraftLabels } from './journalPartyLabels';

const emptyOptions = () => ({ CUSTOMER: [], SUPPLIER: [], ANY: [] });

describe('journal draft party labels', () => {
  it('restores a typed label to its matching picker and ANY only', () => {
    const options = partyOptionsWithDraftLabels(emptyOptions(), {
      party1: { label: 'S-1 — Supplier', partyType: 'SUPPLIER' },
    });

    expect(options.CUSTOMER).toEqual([]);
    expect(options.SUPPLIER).toEqual([{ value: 'party1', label: 'S-1 — Supplier' }]);
    expect(options.ANY).toEqual([{ value: 'party1', label: 'S-1 — Supplier' }]);
  });

  it('restores legacy plain-string labels to ANY without crashing', () => {
    const options = partyOptionsWithDraftLabels(emptyOptions(), { party1: 'Legacy party label' });

    expect(options.CUSTOMER).toEqual([]);
    expect(options.SUPPLIER).toEqual([]);
    expect(options.ANY).toEqual([{ value: 'party1', label: 'Legacy party label' }]);
  });
});
