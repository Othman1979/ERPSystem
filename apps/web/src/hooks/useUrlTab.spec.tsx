import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUrlTab } from './useUrlTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const validTabs = ['invoices', 'returns'] as const;

function TabProbe() {
  const [tab, setTab] = useUrlTab(validTabs, 'invoices');
  const location = useLocation();
  return (
    <>
      <span data-testid="tab">{tab}</span>
      <span data-testid="search">{location.search}</span>
      <button type="button" onClick={() => setTab('returns')}>switch</button>
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

function render(path: string) {
  act(() => {
    root.render(<MemoryRouter initialEntries={[path]}><TabProbe /></MemoryRouter>);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useUrlTab', () => {
  it('updates the active view when the URL tab changes', async () => {
    render('/sales?tab=invoices');
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('[data-testid="tab"]')?.textContent).toBe('returns');
  });

  it('falls back to the default for an unknown tab', () => {
    render('/sales?tab=unknown');
    expect(container.querySelector('[data-testid="tab"]')?.textContent).toBe('invoices');
  });

  it('preserves other search parameters when switching tabs', async () => {
    render('/sales?from=2026-01-01&tab=invoices&partyId=party-1');
    await act(async () => container.querySelector('button')?.click());
    const params = new URLSearchParams(container.querySelector('[data-testid="search"]')?.textContent);
    expect(params.get('from')).toBe('2026-01-01');
    expect(params.get('partyId')).toBe('party-1');
    expect(params.get('tab')).toBe('returns');
  });
});
