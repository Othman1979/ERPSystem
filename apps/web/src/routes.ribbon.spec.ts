import { describe, expect, it } from 'vitest';
import { ALL_ROUTES, APP_GROUPS } from './routes';

describe('ribbon module navigation', () => {
  it('orders the module groups without a standalone reports group', () => {
    expect(APP_GROUPS.map((group) => group.label)).toEqual([
      'nav.groupAccounting',
      'nav.groupTreasury',
      'nav.groupSales',
      'nav.groupPurchases',
      'nav.groupInventory',
      'nav.groupPayroll',
      'nav.groupAdmin',
      'nav.groupAccount',
    ]);
  });

  it('keeps view-backed pages registered while hiding their route tiles from the ribbon', () => {
    const viewRoutes = ['reports', 'treasury', 'sales', 'purchases', 'stock', 'payroll', 'consignment', 'items'];
    for (const key of viewRoutes) {
      expect(ALL_ROUTES.find((route) => route.key === key)?.ribbon).toBe(false);
    }
    expect(ALL_ROUTES.map((route) => route.key)).toEqual(expect.arrayContaining(viewRoutes));
  });

  it('keeps stock consumption reports in the inventory group', () => {
    const inventory = APP_GROUPS.find((group) => group.label === 'nav.groupInventory')!;
    expect(inventory.routes.map((route) => route.key)).toEqual(expect.arrayContaining(['consumption', 'recipeSales']));
  });
});
