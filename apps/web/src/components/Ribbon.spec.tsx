import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS, type Permission } from '../auth/permissions';
import type { ProcurementLevel } from '../auth/procurementLevel';
import i18n from '../i18n';
import { Ribbon, type RibbonProps } from './Ribbon';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FOLDED_KEY = 'erp.ribbonFolded';
const everything = () => true;
const nothing = () => false;

let root: Root;
let container: HTMLDivElement;
let pathname = '';

function LocationProbe() {
  pathname = useLocation().pathname;
  return null;
}

/** Renders the ribbon at `path`; later calls on the same root re-render with new props. */
function render(path: string, props: Partial<RibbonProps> = {}): void {
  const full: RibbonProps = {
    can: everything,
    procurementLevel: 'FULL' as ProcurementLevel,
    noCompany: false,
    isPlatformAdmin: false,
    pendingInvitations: 0,
    compact: false,
    ...props,
  };
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Ribbon {...full} />
        <LocationProbe />
      </MemoryRouter>,
    );
  });
}

const t = (key: string) => i18n.t(key);
const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const tabLabels = () => tabs().map((b) => b.textContent);
const tabNamed = (key: string) => tabs().find((b) => b.textContent === t(key))!;
const lastTab = () => tabs()[tabs().length - 1];
const selectedTab = () => tabs().find((b) => b.getAttribute('aria-selected') === 'true')?.textContent;
const strip = () => container.querySelector<HTMLElement>('[role="tabpanel"]');
const links = () => [...container.querySelectorAll<HTMLAnchorElement>('.ribbon-link')];
const linkLabels = () => links().map((a) => a.querySelector('.ribbon-label')?.textContent);
const foldButton = () => container.querySelector<HTMLButtonElement>('.ribbon-fold')!;
const floating = () => container.querySelector<HTMLElement>('.ribbon-float');

async function click(el: HTMLElement): Promise<void> {
  await act(async () => el.click());
}

function keyDown(el: HTMLElement, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  window.localStorage.removeItem(FOLDED_KEY);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.removeItem(FOLDED_KEY);
});

describe('tabs follow the allowed groups', () => {
  it('shows one tab per module group, in ribbon order, for a role with everything', () => {
    render('/');
    expect(tabLabels()).toEqual(
      [
        'nav.home',
        'nav.groupPayroll',
        'nav.groupAccounting',
        'nav.groupTreasury',
        'nav.groupSales',
        'nav.groupPurchases',
        'nav.groupInventory',
        'nav.groupReports',
        'nav.groupAdmin',
        'nav.groupAccount',
      ].map(t),
    );
  });

  it('hides tabs whose screens the role cannot open, and keeps the rest', async () => {
    render('/', { can: (p: Permission) => p === PERMISSIONS.SALES_MANAGE || p === PERMISSIONS.TENANT_READ });
    expect(tabLabels()).toContain(t('nav.groupSales'));
    expect(tabLabels()).not.toContain(t('nav.groupReports'));
    // Health needs no permission and branches needs only TENANT_READ; users and settings are hidden.
    await click(tabNamed('nav.groupAdmin'));
    expect(linkLabels()).toEqual([t('nav.branches'), t('nav.health')]);
    expect(tabLabels()).toContain(t('nav.groupAccount')); // invitations need no permission
  });

  it('keeps only the account tab for a user without a company', () => {
    render('/invitations', { can: nothing, noCompany: true });
    expect(tabLabels()).toEqual([t('nav.groupAccount')]);
    expect(linkLabels()).toEqual([t('nav.invitations')]);
  });

  it('drops the procurement screens below their level, as the side menu did', () => {
    render('/purchases', { procurementLevel: 'SIMPLE' });
    expect(linkLabels()).not.toContain(t('nav.purchaseRequests'));
    expect(linkLabels()).toContain(t('nav.purchases'));
  });

  it('lists the platform console in the admin tab for a platform admin', () => {
    render('/users', { isPlatformAdmin: true });
    expect(linkLabels()).toContain(t('platform.nav'));
    const platform = links().find((a) => a.querySelector('.ribbon-label')?.textContent === t('platform.nav'))!;
    expect(platform.getAttribute('href')).toBe('/platform');
  });

  it('shows the pending invitations count on the invitations button', async () => {
    render('/invitations', { pendingInvitations: 3 });
    const invitations = links().find((a) => a.getAttribute('href') === '/invitations')!;
    expect(invitations.querySelector('.ant-badge')?.textContent).toBe('3');
  });

  it('shows no badge when nothing is pending', () => {
    render('/invitations', { pendingInvitations: 0 });
    expect(container.querySelector('.ribbon .ant-badge')).toBeNull();
  });
});

describe('the active tab follows the page', () => {
  it('selects the tab of the current screen', () => {
    render('/treasury');
    expect(selectedTab()).toBe(t('nav.groupTreasury'));
    expect(tabNamed('nav.groupTreasury').tabIndex).toBe(0);
    expect(tabNamed('nav.groupSales').tabIndex).toBe(-1);
  });

  it('selects home on the home path', () => {
    render('/');
    expect(selectedTab()).toBe(t('nav.home'));
  });

  it('marks the current page with aria-current', () => {
    render('/sales');
    const current = links().filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/sales']);
  });

  it('switching tabs shows the other strip without navigating', async () => {
    render('/sales');
    await click(tabNamed('nav.groupReports'));
    expect(selectedTab()).toBe(t('nav.groupReports'));
    expect(linkLabels()).toEqual([t('nav.reports'), t('nav.consumption'), t('nav.recipeSales')]);
    expect(pathname).toBe('/sales');
  });
});

describe('links are real anchors', () => {
  it('gives every button an href, so Ctrl+click opens a new tab', () => {
    render('/sales');
    for (const a of links()) expect(a.getAttribute('href')).toMatch(/^\//);
    expect(links().map((a) => a.getAttribute('href'))).toEqual(expect.arrayContaining(['/sales', '/einvoice', '/parties']));
  });

  it('gives a "new" button a path that opens the create form', () => {
    render('/sales');
    expect(container.querySelector('a[href="/sales?new=1"]')).not.toBeNull();
    const badge = container.querySelector('a[href="/sales?new=1"] .ribbon-new');
    expect(badge?.textContent).toBe('+');
  });

  it('names the document on a "new" button', () => {
    render('/sales');
    expect(container.querySelector('a[href="/sales?new=1"] .ribbon-label')?.textContent).toBe(t('ribbon.new.sales'));
  });

  it('offers no "new" button to a role that cannot create the document (review #55)', () => {
    render('/sales', { can: (p: Permission) => p === PERMISSIONS.TENANT_READ || p === PERMISSIONS.REPORTS_VIEW });
    expect(container.querySelector('a[href="/sales"]')).not.toBeNull();
    expect(container.querySelector('a[href="/sales?new=1"]')).toBeNull();
  });

  it('offers only the quick actions the role can use on the home tab', () => {
    render('/', { can: (p: Permission) => p === PERMISSIONS.SALES_MANAGE });
    expect(linkLabels()).toEqual([t('nav.home'), t('sales.newInvoice')]);
  });
});

describe('folding', () => {
  it('folds the strip, remembers it, and unfolds it again', async () => {
    render('/sales');
    expect(strip()).not.toBeNull();
    expect(foldButton().getAttribute('aria-expanded')).toBe('true');

    await click(foldButton());
    expect(strip()).toBeNull();
    expect(foldButton().getAttribute('aria-expanded')).toBe('false');
    expect(window.localStorage.getItem(FOLDED_KEY)).toBe('1');

    // A fresh mount reads the saved state.
    act(() => root.unmount());
    root = createRoot(container);
    render('/sales');
    expect(strip()).toBeNull();

    await click(foldButton());
    expect(strip()).not.toBeNull();
    expect(window.localStorage.getItem(FOLDED_KEY)).toBe('0');
  });

  it('folds on a double click of a tab', async () => {
    render('/sales');
    await act(async () => {
      tabNamed('nav.groupSales').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(strip()).toBeNull();
  });

  it('opens the folded strip over the page from a tab, and closes it on Escape', async () => {
    render('/sales');
    await click(foldButton());
    await click(tabNamed('nav.groupPurchases'));
    expect(floating()).not.toBeNull();
    expect(linkLabels()).toContain(t('nav.purchases'));

    keyDown(tabNamed('nav.groupPurchases'), 'Escape');
    expect(floating()).toBeNull();
  });

  it('closes the floating strip on a click outside the ribbon', async () => {
    render('/sales');
    await click(foldButton());
    await click(tabNamed('nav.groupSales'));
    expect(floating()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(floating()).toBeNull();
  });

  it('closes the floating strip after a button is chosen', async () => {
    render('/sales');
    await click(foldButton());
    await click(tabNamed('nav.groupSales'));
    const einvoice = links().find((a) => a.getAttribute('href') === '/einvoice')!;
    // The click closes the strip; the anchor's navigation is jsdom's concern, not the ribbon's.
    await act(async () => {
      einvoice.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(floating()).toBeNull();
  });
});

describe('keyboard', () => {
  it('moves between tabs with the arrows, Home and End', () => {
    render('/sales');
    const sales = tabNamed('nav.groupSales');
    sales.focus();

    keyDown(sales, 'ArrowRight');
    expect(document.activeElement).toBe(tabNamed('nav.groupPurchases'));
    expect(selectedTab()).toBe(t('nav.groupPurchases'));

    keyDown(tabNamed('nav.groupPurchases'), 'ArrowLeft');
    expect(document.activeElement).toBe(tabNamed('nav.groupSales'));

    keyDown(tabNamed('nav.groupSales'), 'End');
    expect(document.activeElement).toBe(lastTab());

    keyDown(lastTab(), 'Home');
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it('wraps around from the last tab to the first', () => {
    render('/invitations');
    const last = lastTab();
    last.focus();
    keyDown(last, 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it('mirrors the arrows in Arabic: ArrowLeft goes to the next tab', async () => {
    await i18n.changeLanguage('ar');
    render('/sales');
    const sales = tabNamed('nav.groupSales');
    sales.focus();
    keyDown(sales, 'ArrowLeft');
    expect(document.activeElement).toBe(tabNamed('nav.groupPurchases'));
    keyDown(tabNamed('nav.groupPurchases'), 'ArrowRight');
    expect(document.activeElement).toBe(tabNamed('nav.groupSales'));
  });

  it('gives the tab row a labelled tablist and the strip a labelled tabpanel', () => {
    render('/sales');
    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(t('ribbon.tabs'));
    const panel = strip()!;
    expect(panel.getAttribute('aria-labelledby')).toBe(tabNamed('nav.groupSales').id);
    expect(tabNamed('nav.groupSales').getAttribute('aria-controls')).toBe(panel.id);
  });
});

describe('layout', () => {
  it('uses the compact tiles on tablets', () => {
    render('/sales', { compact: true });
    expect(container.querySelector('.ribbon.is-compact')).not.toBeNull();
  });

  it('is a labelled region', () => {
    render('/sales');
    expect(container.querySelector('section.ribbon')?.getAttribute('aria-label')).toBe(t('ribbon.label'));
  });
});

describe('sales cycle "new" buttons (ADR-027 §7)', () => {
  it('offers a new quotation and a new sales order to a role with sales.manage', () => {
    render('/sales', { can: (p: Permission) => p === PERMISSIONS.TENANT_READ || p === PERMISSIONS.SALES_MANAGE });
    expect(container.querySelector('a[href="/sales-quotes?new=1"] .ribbon-label')?.textContent).toBe(t('ribbon.new.salesQuotes'));
    expect(container.querySelector('a[href="/sales-orders?new=1"] .ribbon-label')?.textContent).toBe(t('ribbon.new.salesOrders'));
  });

  it('hides both new buttons from a role without sales.manage, and keeps the screens', () => {
    render('/sales', { can: (p: Permission) => p === PERMISSIONS.TENANT_READ });
    expect(container.querySelector('a[href="/sales-quotes?new=1"]')).toBeNull();
    expect(container.querySelector('a[href="/sales-orders?new=1"]')).toBeNull();
    expect(container.querySelector('a[href="/sales-quotes"]')).not.toBeNull();
    expect(container.querySelector('a[href="/sales-orders"]')).not.toBeNull();
  });
});

describe('bill of materials and production "new" buttons (ADR-031 §5, §7)', () => {
  it('offers a new formula to a role with item.manage, and a new voucher to a role with stock.movement', () => {
    render('/items', {
      can: (p: Permission) => p === PERMISSIONS.TENANT_READ || p === PERMISSIONS.ITEM_MANAGE || p === PERMISSIONS.STOCK_MOVEMENT,
    });
    expect(container.querySelector('a[href="/boms?new=1"] .ribbon-label')?.textContent).toBe(t('ribbon.new.boms'));
    expect(container.querySelector('a[href="/production?new=1"] .ribbon-label')?.textContent).toBe(t('ribbon.new.production'));
  });

  it('hides each new button from a role without its own permission, and keeps the screens', () => {
    render('/items', { can: (p: Permission) => p === PERMISSIONS.TENANT_READ || p === PERMISSIONS.STOCK_MOVEMENT });
    expect(container.querySelector('a[href="/boms?new=1"]')).toBeNull();
    expect(container.querySelector('a[href="/production?new=1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/boms"]')).not.toBeNull();
    expect(container.querySelector('a[href="/production"]')).not.toBeNull();
  });
});
