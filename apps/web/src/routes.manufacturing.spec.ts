import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from './auth/permissions';
import { ALL_ROUTES, APP_GROUPS, canOpenPath, routeForPath } from './routes';

const inventoryTab = () => APP_GROUPS.find((g) => g.label === 'nav.groupInventory')!;
const routeOf = (key: string) => ALL_ROUTES.find((r) => r.key === key)!;

describe('bill of materials and production screens (ADR-031 §5, §7)', () => {
  it('lists the formulas beside the items and the vouchers beside the stock movements', () => {
    expect(inventoryTab().routes.map((r) => r.key)).toEqual([
      'items', 'warehouses', 'boms', 'stock', 'consignment', 'production', 'issueRequests', 'consumption', 'recipeSales',
    ]);
    expect(routeOf('boms').section).toBe('nav.sectionCatalog');
    expect(routeOf('production').section).toBe('nav.sectionMovements');
    expect(routeOf('consumption').section).toBe('nav.sectionReports');
    expect(routeOf('recipeSales').section).toBe('nav.sectionReports');
  });

  it('reads both with the tenant permission and does not gate them by procurement level', () => {
    for (const key of ['boms', 'production']) {
      expect(routeOf(key).permission).toBe(PERMISSIONS.TENANT_READ);
      expect(routeOf(key).minProcurementLevel).toBeUndefined();
    }
    expect(canOpenPath('/boms', () => true, 'SIMPLE')).toBe(true);
    expect(canOpenPath('/production', () => true, 'SIMPLE')).toBe(true);
  });

  it('offers a new formula only to item.manage, and a new voucher only to stock.movement', () => {
    expect(routeOf('boms').newPath).toBe('/boms?new=1');
    expect(routeOf('boms').newPermission).toBe(PERMISSIONS.ITEM_MANAGE);
    expect(routeOf('production').newPath).toBe('/production?new=1');
    expect(routeOf('production').newPermission).toBe(PERMISSIONS.STOCK_MOVEMENT);
  });

  it('opens each screen from its own path, and hides it from a role without tenant read', () => {
    expect(routeForPath('/boms/12')?.key).toBe('boms');
    expect(routeForPath('/production')?.key).toBe('production');
    expect(routeForPath('/stock')?.key).toBe('stock');
    expect(canOpenPath('/boms', () => false)).toBe(false);
    expect(canOpenPath('/production', () => false)).toBe(false);
  });
});
