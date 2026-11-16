import { describe, expect, it } from 'vitest';
import { linesBelowOrder, missingSalesPriceLines, reservationShortfalls, salesLineBodies } from './salesLines';

describe('sales line bodies', () => {
  it('sends strings only and drops blank optional fields', () => {
    expect(
      salesLineBodies([{ itemId: 'i1', itemUnitId: ' ', qty: '2.5', unitPrice: '10.250', discountPct: '' }]),
    ).toEqual([{ itemId: 'i1', qty: '2.5', unitPrice: '10.250' }]);
  });

  it('keeps the unit and the discount when the line has them', () => {
    expect(salesLineBodies([{ itemId: 'i2', itemUnitId: '44', qty: '1', unitPrice: '3', discountPct: '5' }])).toEqual([
      { itemId: 'i2', itemUnitId: '44', qty: '1', unitPrice: '3', discountPct: '5' },
    ]);
  });

  it('drops lines without an item or a quantity', () => {
    expect(
      salesLineBodies([
        { qty: '4', unitPrice: '2' },
        { itemId: 'i3', qty: '', unitPrice: '2' },
        { itemId: 'i4', qty: '1', unitPrice: '5' },
      ]),
    ).toEqual([{ itemId: 'i4', qty: '1', unitPrice: '5' }]);
  });

  it('refuses a line with a quantity and no price rather than sending zero', () => {
    expect(() => salesLineBodies([{ itemId: 'i5', qty: '1', unitPrice: ' ' }])).toThrow();
  });
});

describe('missing sales prices', () => {
  it('lists the lines with an item and a quantity but no price; a price of 0 is a price', () => {
    expect(
      missingSalesPriceLines([
        { itemId: 'a', qty: '1', unitPrice: '' },
        { itemId: 'b', qty: '1', unitPrice: '0' },
        { itemId: 'c', qty: '1', unitPrice: null },
        { qty: '1' },
      ]),
    ).toEqual([0, 2]);
  });
});

describe('reservation shortfalls (ADR-027 §5)', () => {
  it('flags an item whose lines together exceed what is available', () => {
    const short = reservationShortfalls(
      [
        { itemId: 'a', qtyBase: '6' },
        { itemId: 'a', qtyBase: '5' },
        { itemId: 'b', qtyBase: '3' },
      ],
      [
        { itemId: 'a', available: '10' },
        { itemId: 'b', available: '3' },
      ],
    );
    expect([...short]).toEqual(['a']);
  });

  it('does not flag an item without an available figure', () => {
    expect([...reservationShortfalls([{ itemId: 'a', qtyBase: '99' }], [{ itemId: 'a', available: null }])]).toEqual([]);
  });
});

describe('invoice lines priced below their order (ADR-027 §4)', () => {
  const orderLines = [
    { id: 'o1', unitPrice: '10', discountPct: '0' },
    { id: 'o2', unitPrice: '20', discountPct: '5' },
  ];

  it('flags a lower price and a higher discount, and nothing at or above the order', () => {
    const below = linesBelowOrder(
      [
        { orderLineId: 'o1', unitPrice: '9.999', discountPct: '0' },
        { orderLineId: 'o2', unitPrice: '25', discountPct: '10' },
        { orderLineId: null, unitPrice: '1', discountPct: '0' },
      ],
      orderLines,
    );
    expect([...below]).toEqual(['o1', 'o2']);
    expect([
      ...linesBelowOrder([{ orderLineId: 'o2', unitPrice: '20', discountPct: '5' }], orderLines),
    ]).toEqual([]);
  });
});
