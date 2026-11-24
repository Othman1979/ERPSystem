import { describe, expect, it } from 'vitest';
import { goodsNoteWarehouses } from './goods/goodsNoteWarehouses';

const warehouses = [
  { id: 'owned', consignmentSupplierId: null },
  { id: 'consignment', consignmentSupplierId: 'supplier-1' },
];

describe('GoodsNotesPage consignment warehouse options', () => {
  it('pairs owned notes with owned warehouses and consignment notes with consignment warehouses', () => {
    expect(goodsNoteWarehouses('GRN', warehouses, true).map((row) => row.id)).toEqual(['owned']);
    expect(goodsNoteWarehouses('GIN', warehouses, true).map((row) => row.id)).toEqual(['owned']);
    expect(goodsNoteWarehouses('CONSIGNMENT_IN', warehouses, true).map((row) => row.id)).toEqual(['consignment']);
    expect(goodsNoteWarehouses('CONSIGNMENT_OUT', warehouses, true).map((row) => row.id)).toEqual(['consignment']);
  });

  it('offers only owned warehouses and no consignment notes while the feature is disabled', () => {
    expect(goodsNoteWarehouses('GRN', warehouses, false).map((row) => row.id)).toEqual(['owned']);
    expect(goodsNoteWarehouses('CONSIGNMENT_IN', warehouses, false)).toEqual([]);
    expect(goodsNoteWarehouses('CONSIGNMENT_OUT', warehouses, false)).toEqual([]);
  });
});
