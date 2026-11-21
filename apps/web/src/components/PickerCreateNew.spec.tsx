// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { SEARCH_DEBOUNCE_MS } from '../hooks/usePagedQuery';
import { GridSelect } from './GridSelect';
import { RemoteSelect } from './RemoteSelect';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

let root: Root | undefined;
let host: HTMLDivElement;
beforeAll(async () => {
  const { default: i18n } = await import('../i18n');
  await i18n.changeLanguage('en');
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = SEARCH_DEBOUNCE_MS + 80) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
function mount(node: ReactNode, remote = false, client?: QueryClient) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const content = remote ? (
    <QueryClientProvider
      client={client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>
  ) : node;
  act(() => root!.render(content));
}
function typeSearch(value: string) {
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}
function openPicker() {
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  act(() => input.focus());
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  return input;
}

describe('GridSelect create-new', () => {
  it('renders a footer action and sends its search text when clicked', async () => {
    const onCreateNew = vi.fn();
    mount(
      <GridSelect options={[]} onCreateNew={onCreateNew} createNewLabel="New account" />,
    );
    openPicker();
    typeSearch('Receivable');
    await settle(50);
    const action = document.querySelector<HTMLElement>('.grid-select-create-new')!;
    expect(action.textContent).toContain('New account');
    act(() => action.click());
    expect(onCreateNew).toHaveBeenCalledWith('Receivable');
  });

  it('creates on Enter for a nonmatching search', async () => {
    const onCreateNew = vi.fn();
    mount(
      <GridSelect
        options={[{ value: '1', label: 'Cash' }]}
        onCreateNew={onCreateNew}
      />,
    );
    const input = openPicker();
    typeSearch('Receivable');
    await settle(50);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onCreateNew).toHaveBeenCalledWith('Receivable');
  });

  it('does not create on Enter while searching', async () => {
    const onCreateNew = vi.fn();
    mount(<GridSelect options={[]} searching onCreateNew={onCreateNew} />);
    const input = openPicker();
    typeSearch('Receivable');
    await settle(50);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onCreateNew).not.toHaveBeenCalled();
  });

  it('does not create on Enter while loading', async () => {
    const onCreateNew = vi.fn();
    mount(<GridSelect options={[]} loading onCreateNew={onCreateNew} />);
    const input = openPicker();
    typeSearch('Receivable');
    await settle(50);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onCreateNew).not.toHaveBeenCalled();
  });

  it('keeps Enter behavior without an onCreateNew callback', async () => {
    const onChange = vi.fn();
    mount(<GridSelect options={[{ value: '1', label: 'Cash' }]} onChange={onChange} />);
    const input = openPicker();
    typeSearch('Missing');
    await settle(50);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('.grid-select-create-new')).toBeNull();
  });
});

describe('RemoteSelect create-new', () => {
  const fetchOptions = async () => [];

  it('renders a footer action and sends the remote search text when clicked', async () => {
    const onCreateNew = vi.fn();
    mount(
      <RemoteSelect
        queryKey={['remote-create']}
        fetchOptions={fetchOptions}
        onCreateNew={onCreateNew}
        createNewLabel="New party"
      />,
      true,
    );
    await settle();
    openPicker();
    typeSearch('Acme');
    await settle();
    const action = document.querySelector<HTMLElement>('.grid-select-create-new')!;
    expect(action.textContent).toContain('New party');
    act(() => action.click());
    expect(onCreateNew).toHaveBeenCalledWith('Acme');
  });

  it('creates on Enter for a nonmatching remote search', async () => {
    const onCreateNew = vi.fn();
    const onInputKeyDown = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['remote-create-enter', ''], []);
    client.setQueryData(['remote-create-enter', 'Acme'], []);
    mount(
      <RemoteSelect
        queryKey={['remote-create-enter']}
        fetchOptions={fetchOptions}
        onCreateNew={onCreateNew}
        onInputKeyDown={onInputKeyDown}
      />,
      true,
      client,
    );
    await settle();
    const input = openPicker();
    typeSearch('Acme');
    await settle(1000);
    expect(input.isConnected).toBe(true);
    expect(document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).not.toBeNull();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onInputKeyDown).toHaveBeenCalled();
    expect(onCreateNew).toHaveBeenCalledWith('Acme');
  });

  it('does not create on Enter while a remote search is loading', async () => {
    const onCreateNew = vi.fn();
    const fetchOptions = () => new Promise<[]>(() => {});
    mount(
      <RemoteSelect
        queryKey={['remote-create-loading']}
        fetchOptions={fetchOptions}
        onCreateNew={onCreateNew}
      />,
      true,
    );
    const input = openPicker();
    typeSearch('Acme');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onCreateNew).not.toHaveBeenCalled();
  });

  it('keeps Enter behavior without an onCreateNew callback', async () => {
    const onChange = vi.fn();
    mount(<RemoteSelect queryKey={['remote-no-create']} fetchOptions={fetchOptions} onChange={onChange} />, true);
    await settle();
    const input = openPicker();
    typeSearch('Missing');
    await settle();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('.grid-select-create-new')).toBeNull();
  });
});
