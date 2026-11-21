// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { PartyDto } from '@erp/api-client';
import { usePartyColumn } from './usePartyColumn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const customer = {
  id: 'customer-1',
  code: 'C-1',
  nameAr: 'Customer',
  nameEn: 'Customer',
  partyType: 'CUSTOMER',
} as PartyDto;
const both = { ...customer, id: 'both-1', code: 'B-1', partyType: 'BOTH' } as PartyDto;

function PartyColumnProbe({ party }: { party: PartyDto }) {
  const { partyColumn, rememberParty } = usePartyColumn(undefined, {
    shownPartyIds: [party.id],
    enabled: false,
  });

  return (
    <>
      <button onClick={() => rememberParty(party)}>Remember</button>
      {(['CUSTOMER', 'SUPPLIER', 'ANY'] as const).map((kind) => (
        <output key={kind} data-kind={kind}>
          {partyColumn.options[kind].map((option) => option.value).join(',')}
        </output>
      ))}
    </>
  );
}

let root: Root | undefined;
let host: HTMLDivElement;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = '';
});

function render(party: PartyDto) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <PartyColumnProbe party={party} />
      </QueryClientProvider>,
    ),
  );
}

function options(kind: 'CUSTOMER' | 'SUPPLIER' | 'ANY') {
  return host.querySelector<HTMLOutputElement>(`[data-kind="${kind}"]`)!.textContent;
}

describe('usePartyColumn remembered parties', () => {
  it('remembers a customer in the customer picker and ANY only', () => {
    render(customer);
    act(() => host.querySelector('button')!.click());

    expect(options('CUSTOMER')).toBe(customer.id);
    expect(options('SUPPLIER')).toBe('');
    expect(options('ANY')).toBe(customer.id);
  });

  it('remembers a BOTH party in both sides and ANY', () => {
    render(both);
    act(() => host.querySelector('button')!.click());

    expect(options('CUSTOMER')).toBe(both.id);
    expect(options('SUPPLIER')).toBe(both.id);
    expect(options('ANY')).toBe(both.id);
  });
});
