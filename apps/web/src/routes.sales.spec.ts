import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from './auth/permissions';
import { ALL_ROUTES, APP_GROUPS, canOpenPath, routeForPath } from './routes';

const salesTab = () => APP_GROUPS.find((g) => g.label === 'nav.groupSales')!;

describe('sales cycle screens (ADR-027 §7)', () => {
  it('lists quotations and sales orders in the sales tab, before the parties', () => {
    expect(salesTab().routes.map((r) => r.key)).toEqual(['sales', 'einvoice', 'salesQuotes', 'salesOrders', 'parties']);
  });

  it('reads them with the tenant permission, and offers each new document only to sales.manage', () => {
    const quotes = ALL_ROUTES.find((r) => r.key === 'salesQuotes')!;
    const orders = ALL_ROUTES.find((r) => r.key === 'salesOrders')!;
    for (const route of [quotes, orders]) {
      expect(route.permission).toBe(PERMISSIONS.TENANT_READ);
      expect(route.newPermission).toBe(PERMISSIONS.SALES_MANAGE);
      expect(route.section).toBe('nav.sectionSalesCycle');
    }
    expect(quotes.newPath).toBe('/sales-quotes?new=1');
    expect(orders.newPath).toBe('/sales-orders?new=1');
  });

  it('is not gated by the procurement level: sales works at every level', () => {
    const cycle = ALL_ROUTES.filter((r) => r.key === 'salesQuotes' || r.key === 'salesOrders');
    expect(cycle.every((r) => r.minProcurementLevel === undefined)).toBe(true);
    expect(canOpenPath('/sales-orders', () => true, 'SIMPLE')).toBe(true);
    expect(canOpenPath('/sales-quotes/12', () => true, 'SIMPLE')).toBe(true);
  });

  it('opens each screen from its own path, not from the sales module', () => {
    expect(routeForPath('/sales-quotes/12')?.key).toBe('salesQuotes');
    expect(routeForPath('/sales-orders')?.key).toBe('salesOrders');
    expect(routeForPath('/sales')?.key).toBe('sales');
    expect(routeForPath('/sales/anything')?.key).toBe('sales');
  });

  it('hides a screen from a role without the tenant read permission', () => {
    expect(canOpenPath('/sales-orders', () => false)).toBe(false);
    expect(canOpenPath('/sales-quotes', () => false)).toBe(false);
  });
});
