import { describe, expect, it } from 'vitest';
import type { PurchaseComparisonDto } from '@erp/api-client';
import { convertBody, defaultPicks, quoteBody, receiveBody } from './quotePayload';

const offer = (quoteLineId: string, lowest: boolean) =>
  ({ quoteId: `Q-${quoteLineId}`, quoteNo: null, quoteLineId, lowest }) as unknown as PurchaseComparisonDto['lines'][number]['offers'][number];

const comparison = {
  request: { id: 'R1', requestNo: 'PRQ-1', status: 'APPROVED', requestDate: '2026-11-01' },
  lines: [
    { requestLineId: 'rl-a', remainingQty: '5', offers: [offer('ql-a1', false), offer('ql-a2', true), offer('ql-a3', true)] },
    { requestLineId: 'rl-b', remainingQty: '0', offers: [offer('ql-b1', true)] },
    { requestLineId: 'rl-c', remainingQty: '2', offers: [offer('ql-c1', false)] },
    { requestLineId: 'rl-d', remainingQty: '1', offers: [] },
    { requestLineId: 'rl-e', remainingQty: '3', offers: [offer('ql-e1', true)] },
  ],
} as unknown as PurchaseComparisonDto;

describe('receiveBody', () => {
  it('sends the prices as strings and leaves out blank optional fields', () => {
    expect(
      receiveBody([
        { lineId: 'ql-1', unitPrice: '2.500', discountPct: '10' },
        { lineId: 'ql-2', unitPrice: '7', discountPct: '' },
      ]),
    ).toStrictEqual({
      lines: [
        { lineId: 'ql-1', unitPrice: '2.500', discountPct: '10' },
        { lineId: 'ql-2', unitPrice: '7' },
      ],
    });
  });

  it('keeps a typed zero discount and trims the reference', () => {
    expect(receiveBody([{ lineId: 'ql-1', unitPrice: '1', discountPct: '0' }], '  SUP-88 ', '2026-12-31')).toStrictEqual({
      supplierRef: 'SUP-88',
      validUntil: '2026-12-31',
      lines: [{ lineId: 'ql-1', unitPrice: '1', discountPct: '0' }],
    });
  });

  it('omits a blank supplier reference and a missing validity date', () => {
    const body = receiveBody([{ lineId: 'ql-1', unitPrice: '1' }], '   ', null);
    expect(body).toStrictEqual({ lines: [{ lineId: 'ql-1', unitPrice: '1' }] });
    expect('supplierRef' in body).toBe(false);
    expect('validUntil' in body).toBe(false);
  });
});

describe('convertBody', () => {
  const header = { orderDate: '2026-11-15', warehouseId: '3' };

  it('turns the picks into one selection per line, without quantities', () => {
    expect(convertBody(header, { 'rl-a': 'ql-a2', 'rl-c': 'ql-c1' })).toStrictEqual({
      orderDate: '2026-11-15',
      warehouseId: '3',
      selections: [{ quoteLineId: 'ql-a2' }, { quoteLineId: 'ql-c1' }],
    });
  });

  it('carries the optional header fields when they are filled', () => {
    expect(
      convertBody(
        { ...header, expectedDate: '2026-11-30', costCenterId: '9', notes: '  urgent  ' },
        { 'rl-a': 'ql-a2' },
      ),
    ).toStrictEqual({
      orderDate: '2026-11-15',
      expectedDate: '2026-11-30',
      warehouseId: '3',
      costCenterId: '9',
      notes: 'urgent',
      selections: [{ quoteLineId: 'ql-a2' }],
    });
  });

  it('leaves out blank optional fields and sends no selections when nothing is picked', () => {
    const body = convertBody({ ...header, expectedDate: '', costCenterId: null, notes: '   ' }, {});
    expect(body).toStrictEqual({ orderDate: '2026-11-15', warehouseId: '3', selections: [] });
  });
});

describe('defaultPicks', () => {
  it('picks the lowest offer of each line that still has quantity, the first one on a tie', () => {
    expect(defaultPicks(comparison)).toStrictEqual({ 'rl-a': 'ql-a2', 'rl-e': 'ql-e1' });
  });

  it('gives no pick to a line with nothing left, or with no lowest offer', () => {
    const picks = defaultPicks(comparison);
    expect(picks).not.toHaveProperty('rl-b');
    expect(picks).not.toHaveProperty('rl-c');
    expect(picks).not.toHaveProperty('rl-d');
  });
});

describe('quoteBody', () => {
  it('drops lines with no quantity and blank optional fields', () => {
    expect(
      quoteBody({
        supplierId: '5',
        quoteDate: '2026-11-15',
        validUntil: '',
        notes: '   ',
        lines: [
          { requestLineId: 'rl-a', qty: '4.000' },
          { requestLineId: 'rl-b', qty: '' },
          { requestLineId: 'rl-c', qty: '0' },
        ],
      }),
    ).toStrictEqual({
      supplierId: '5',
      quoteDate: '2026-11-15',
      lines: [{ requestLineId: 'rl-a', qty: '4.000' }],
    });
  });

  it('keeps the validity date and trimmed notes', () => {
    expect(
      quoteBody({
        supplierId: '5',
        quoteDate: '2026-11-15',
        validUntil: '2026-12-15',
        notes: ' net 30 ',
        lines: [{ requestLineId: 'rl-a', qty: '1' }],
      }),
    ).toStrictEqual({
      supplierId: '5',
      quoteDate: '2026-11-15',
      validUntil: '2026-12-15',
      notes: 'net 30',
      lines: [{ requestLineId: 'rl-a', qty: '1' }],
    });
  });
});
