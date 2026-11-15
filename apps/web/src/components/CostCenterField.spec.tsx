// @vitest-environment jsdom
import { App as AntApp } from 'antd';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import type { CostCenterRow } from '../hooks/useCostCenters';
import { CostCenterLabel, CostCenterSelect } from './CostCenterField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no matchMedia; antd's responsive hooks ask for it.
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

const centre = (id: string, code: string, extra: Partial<CostCenterRow> = {}): CostCenterRow =>
  ({
    id,
    code,
    nameAr: `c${code}`,
    nameEn: `Centre ${code}`,
    parentId: null,
    isPostable: true,
    isActive: true,
    ...extra,
  }) as CostCenterRow;

const ROWS: CostCenterRow[] = [
  centre('1', 'CC1'),
  centre('2', 'CC2', { isActive: false }), // inactive: not offered
  centre('3', 'CC3', { isPostable: false }), // a group: not offered
  centre('4', 'OLD', { isActive: false }), // inactive but saved on the document: kept
];

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 50) => act(() => new Promise((r) => setTimeout(r, ms)));

function render(node: ReactNode) {
  act(() => root!.render(<AntApp>{node}</AntApp>));
}

describe('CostCenterLabel', () => {
  it('names the field and gives the hint a focusable info icon', () => {
    render(<CostCenterLabel />);
    const hint = i18n.t('costCenters.documentHint');
    const icon = host.querySelector<HTMLElement>(`[aria-label="${hint}"]`);
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute('tabindex')).toBe('0');
    expect(host.textContent).toContain(i18n.t('costCenters.documentField'));
  });

  it('shows the hint on keyboard focus, not only on hover', async () => {
    render(<CostCenterLabel />);
    const hint = i18n.t('costCenters.documentHint');
    const icon = host.querySelector<HTMLElement>(`[aria-label="${hint}"]`)!;
    act(() => icon.focus());
    await settle(150);
    const tooltips = [...document.querySelectorAll('.ant-tooltip')].map((n) => n.textContent);
    expect(tooltips).toContain(hint);
  });
});

describe('CostCenterSelect', () => {
  it('is named by the field name and offers only postable active centres plus the saved one', async () => {
    const onChange = vi.fn();
    render(<CostCenterSelect rows={ROWS} value="4" onChange={onChange} />);
    const combo = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    expect(combo.getAttribute('aria-label')).toBe(i18n.t('costCenters.documentField'));

    act(() => combo.focus());
    act(() => {
      combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await settle();
    const open = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!;
    const texts = [...open.querySelectorAll('.ant-select-item-option')].map((o) => o.textContent ?? '');
    expect(texts.some((t) => t.includes('CC1'))).toBe(true);
    expect(texts.some((t) => t.includes('OLD'))).toBe(true);
    expect(texts.some((t) => t.includes('CC2'))).toBe(false);
    expect(texts.some((t) => t.includes('CC3'))).toBe(false);
  });

  it('reports the picked centre by id', async () => {
    const onChange = vi.fn();
    render(<CostCenterSelect rows={ROWS} value={undefined} onChange={onChange} />);
    const combo = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => combo.focus());
    act(() => {
      combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await settle();
    const open = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!;
    const option = [...open.querySelectorAll<HTMLElement>('.ant-select-item-option')].find((o) =>
      o.textContent?.includes('CC1'),
    )!;
    act(() => option.click());
    await settle();
    expect(onChange).toHaveBeenCalledWith('1');
  });
});
