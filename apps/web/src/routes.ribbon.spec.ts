import { describe, expect, it } from 'vitest';
import { ALL_ROUTES, APP_GROUPS } from './routes';

describe('reports in module ribbon groups', () => {
  it('removes the standalone Reports group and keeps the reports route in Accounting', () => {
    expect(APP_GROUPS.map((group) => group.label)).not.toContain('nav.groupReports');
    const accounting = APP_GROUPS.find((group) => group.label === 'nav.groupAccounting')!;
    expect(accounting.routes.find((route) => route.key === 'reports')?.ribbon).toBe(false);
    expect(ALL_ROUTES.find((route) => route.key === 'reports')?.path).toBe('/reports');
  });

  it('keeps consumption and recipe sales inside Inventory', () => {
    const inventory = APP_GROUPS.find((group) => group.label === 'nav.groupInventory')!;
    expect(inventory.routes.map((route) => route.key)).toEqual(expect.arrayContaining(['consumption', 'recipeSales']));
    expect(inventory.routes.find((route) => route.key === 'consumption')?.section).toBe('nav.sectionReports');
    expect(inventory.routes.find((route) => route.key === 'recipeSales')?.section).toBe('nav.sectionReports');
  });

  it('defines only report links for the requested module tabs', () => {
    const reports = APP_GROUPS.flatMap((group) => group.links ?? []).map((link) => link.to);
    expect(reports).toEqual(expect.arrayContaining([
      '/reports?tab=tb', '/reports?tab=is', '/reports?tab=bs', '/reports?tab=cf',
      '/reports?tab=gl', '/reports?tab=cc', '/reports?tab=tax',
      '/reports?tab=sales', '/reports?tab=statement', '/reports?tab=aging',
      '/reports?tab=purchases', '/reports?tab=items',
      '/stock?tab=movements', '/stock?tab=valuation', '/payroll?tab=reports',
    ]));
    expect(reports).not.toContain('/sales?tab=invoices');
    expect(reports).not.toContain('/treasury?tab=balances');
  });
});
