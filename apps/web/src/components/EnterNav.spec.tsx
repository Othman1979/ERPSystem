// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Select } from 'antd';
import { EnterNav } from './EnterNav';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  // jsdom lays nothing out, so every element would count as hidden.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const show = (node: ReactNode) => act(() => root!.render(node));
const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const field = (label: string) => <input aria-label={label} className="ant-input" />;

function pressEnter(el: HTMLElement): KeyboardEvent {
  act(() => el.focus());
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

describe('EnterNav', () => {
  it('moves to the next field on Enter, then to the submit button', () => {
    show(
      <EnterNav>
        <form>
          {field('first')}
          {field('second')}
          <button type="submit" aria-label="save" />
        </form>
      </EnterNav>,
    );
    expect(pressEnter(byLabel('first')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byLabel('second'));
    pressEnter(byLabel('second'));
    expect(document.activeElement).toBe(byLabel('save'));
  });

  it('moves once when two EnterNav wrappers are nested', () => {
    show(
      <EnterNav>
        <EnterNav>
          {field('a')}
          {field('b')}
          {field('c')}
        </EnterNav>
      </EnterNav>,
    );
    pressEnter(byLabel('a'));
    expect(document.activeElement).toBe(byLabel('b'));
  });

  it('still moves when the field itself prevented Enter (as antd Select does)', () => {
    show(
      <EnterNav>
        <div onKeyDown={(e) => e.preventDefault()}>{field('picked')}</div>
        {field('after')}
      </EnterNav>,
    );
    pressEnter(byLabel('picked'));
    expect(document.activeElement).toBe(byLabel('after'));
  });

  it('leaves Enter in a text area alone', () => {
    show(
      <EnterNav>
        <textarea aria-label="notes" className="ant-input" />
        {field('next')}
      </EnterNav>,
    );
    expect(pressEnter(byLabel('notes')).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byLabel('notes'));
  });
  it('moves past a closed list on Enter without opening it; ArrowDown opens it', async () => {
    show(
      <EnterNav>
        <Select aria-label="pick" showSearch options={[{ value: '1', label: 'One' }]} />
        {field('after')}
      </EnterNav>,
    );
    const pick = byLabel('pick');
    pressEnter(pick);
    expect(document.activeElement).toBe(byLabel('after'));
    expect(host.querySelector('.ant-select-open')).toBeNull();

    act(() => pick.focus());
    act(() => {
      pick.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(host.querySelector('.ant-select-open')).not.toBeNull();
  });
});
