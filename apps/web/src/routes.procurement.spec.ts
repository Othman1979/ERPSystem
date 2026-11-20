import { describe, expect, it } from 'vitest';
import { meetsProcurementLevel } from './auth/procurementLevel';
import { ALL_ROUTES, allowedGroups, allowedRoute, APP_GROUPS, canOpenPath, type AppGroup, type AppRoute } from './routes';

const canAll = () => true;
const route = (key: string, extra: Partial<AppRoute> = {}): AppRoute => ({
  key,
  path: `/${key}`,
  label: `nav.${key}`,
  icon: null,
  element: null,
  ...extra,
});

describe('minProcurementLevel on routes and menu items (ADR-024 §2.3)', () => {
  it('hides payroll navigation when membership does not cover all branches', () => {
    const payroll = APP_GROUPS.find((group) => group.label === 'nav.groupPayroll');
    expect(payroll).toBeDefined();
    expect(allowedGroups([payroll!], canAll, undefined, false)).toEqual([]);
    expect(allowedGroups([payroll!], canAll, undefined, true)).toHaveLength(1);
  });

  it('orders SIMPLE < MEDIUM < FULL; no minimum always passes; unknown counts as SIMPLE', () => {
    expect(meetsProcurementLevel('SIMPLE', undefined)).toBe(true);
    expect(meetsProcurementLevel('SIMPLE', 'MEDIUM')).toBe(false);
    expect(meetsProcurementLevel('MEDIUM', 'MEDIUM')).toBe(true);
    expect(meetsProcurementLevel('FULL', 'MEDIUM')).toBe(true);
    expect(meetsProcurementLevel('MEDIUM', 'FULL')).toBe(false);
    expect(meetsProcurementLevel(undefined, 'MEDIUM')).toBe(false);
    expect(meetsProcurementLevel(undefined, undefined)).toBe(true);
  });

  it('hides a cycle screen below its level, and still needs the permission above it', () => {
    const orders = route('orders', { minProcurementLevel: 'MEDIUM', permission: 'purchase.manage' });
    expect(allowedRoute(orders, canAll, 'SIMPLE')).toBe(false);
    expect(allowedRoute(orders, canAll, 'MEDIUM')).toBe(true);
    expect(allowedRoute(orders, canAll, 'FULL')).toBe(true);
    expect(allowedRoute(orders, () => false, 'FULL')).toBe(false);
    expect(allowedRoute(orders, canAll)).toBe(false); // level not known yet
  });

  it('drops hidden entries from the menu groups, and a group left empty', () => {
    const groups: AppGroup[] = [
      { label: 'g1', tone: 'sales', routes: [route('purchases'), route('orders', { minProcurementLevel: 'MEDIUM' })] },
      { label: 'g2', tone: 'inventory', routes: [route('issues', { minProcurementLevel: 'FULL' })] },
    ];
    const keys = (level: 'SIMPLE' | 'MEDIUM' | 'FULL') =>
      allowedGroups(groups, canAll, level).map((g) => [g.label, g.routes.map((r) => r.key)]);
    expect(keys('SIMPLE')).toEqual([['g1', ['purchases']]]);
    expect(keys('MEDIUM')).toEqual([['g1', ['purchases', 'orders']]]);
    expect(keys('FULL')).toEqual([
      ['g1', ['purchases', 'orders']],
      ['g2', ['issues']],
    ]);
  });

  it('gates only the phase 12 and 13 screens: orders from MEDIUM, requests, quotes and issue requests at FULL (ADR-025, ADR-026)', () => {
    expect(ALL_ROUTES.filter((r) => r.minProcurementLevel !== undefined).map((r) => [r.key, r.minProcurementLevel])).toEqual([
      ['purchaseRequests', 'FULL'],
      ['purchaseQuotes', 'FULL'],
      ['purchaseOrders', 'MEDIUM'],
      ['issueRequests', 'FULL'],
    ]);
    // parties sits in two tabs (sales and purchases): each screen counted once.
    const all = (level: 'SIMPLE' | 'MEDIUM' | 'FULL') => [
      ...new Set(allowedGroups(APP_GROUPS, canAll, level).flatMap((g) => g.routes.map((r) => r.key))),
    ];
    const cycle = ['purchaseRequests', 'purchaseQuotes', 'purchaseOrders', 'issueRequests'];
    expect(all('SIMPLE')).toEqual(ALL_ROUTES.map((r) => r.key).filter((k) => !cycle.includes(k)));
    expect(all('MEDIUM')).toEqual(
      ALL_ROUTES.map((r) => r.key).filter((k) => k !== 'purchaseRequests' && k !== 'purchaseQuotes' && k !== 'issueRequests'),
    );
    expect(all('FULL')).toEqual(ALL_ROUTES.map((r) => r.key));
    // The existing screens stay at every level.
    for (const path of ['/purchases', '/goods-notes', '/stock']) expect([path, canOpenPath(path, canAll, 'SIMPLE')]).toEqual([path, true]);
    expect(canOpenPath('/purchase-orders', canAll, 'SIMPLE')).toBe(false);
    expect(canOpenPath('/purchase-orders/12', canAll, 'MEDIUM')).toBe(true);
    expect(canOpenPath('/purchase-requests', canAll, 'MEDIUM')).toBe(false);
    expect(canOpenPath('/purchase-quotes', canAll, 'FULL')).toBe(true);
  });
});
