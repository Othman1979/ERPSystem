import { describe, expect, it } from 'vitest';
import { warehouseSearchMatches, warehouseSearchText } from './warehouseSearch';

describe('sales warehouse search text', () => {
  it('matches warehouse code and either name while keeping labels independent', () => {
    const searchText = warehouseSearchText({ code: 'WH-01', nameAr: 'المستودع', nameEn: 'Main warehouse' });
    expect(warehouseSearchMatches('WH-01', searchText)).toBe(true);
    expect(warehouseSearchMatches('main', searchText)).toBe(true);
    expect(warehouseSearchMatches('المستودع', searchText)).toBe(true);
    expect(warehouseSearchMatches('not found', searchText)).toBe(false);
  });
});
