import { describe, expect, it } from 'vitest';
import { convertQuoteBody, defaultValidUntil, isQuoteExpired, salesQuoteBody, type SalesQuoteForm } from './quotePayload';

const form: SalesQuoteForm = {
  customerId: '5',
  quoteDate: '2026-11-15',
  validUntil: undefined,
  description: '  valid for stock on hand  ',
  lines: [{ itemId: 'i1', qty: '2', unitPrice: '12.500' }],
};

describe('sales quote body', () => {
  it('omits blank optional fields, trims the description, and sends an empty validity as null', () => {
    expect(salesQuoteBody(form)).toEqual({
      quoteDate: '2026-11-15',
      validUntil: null,
      customerId: '5',
      description: 'valid for stock on hand',
      lines: [{ itemId: 'i1', qty: '2', unitPrice: '12.500' }],
    });
  });

  it('sends the warehouse, the cost centre and the validity when set', () => {
    const body = salesQuoteBody({ ...form, warehouseId: '3', costCenterId: '8', validUntil: '2026-12-15' });
    expect(body).toMatchObject({ warehouseId: '3', costCenterId: '8', validUntil: '2026-12-15' });
  });
});

describe('default validity of a new quote (ADR-027 §1)', () => {
  it('adds the company validity in days to the quote date', () => {
    expect(defaultValidUntil('2026-11-15', 30)).toBe('2026-12-15');
    expect(defaultValidUntil('2026-12-20', 15)).toBe('2027-01-04');
  });

  it('has no default expiry at zero days', () => {
    expect(defaultValidUntil('2026-11-15', 0)).toBeUndefined();
  });
});

describe('quote expiry (ADR-027 §2)', () => {
  it('is expired when sent and its validity is before today', () => {
    expect(isQuoteExpired('SENT', '2026-11-14', '2026-11-15')).toBe(true);
  });

  it('is not expired on its last day, nor without a validity, nor in another status', () => {
    expect(isQuoteExpired('SENT', '2026-11-15', '2026-11-15')).toBe(false);
    expect(isQuoteExpired('SENT', null, '2026-11-15')).toBe(false);
    expect(isQuoteExpired('DRAFT', '2026-11-01', '2026-11-15')).toBe(false);
    expect(isQuoteExpired('ACCEPTED', '2026-11-01', '2026-11-15')).toBe(false);
  });
});

describe('convert body', () => {
  it('sends the warehouse only when one was given', () => {
    expect(convertQuoteBody('3')).toEqual({ warehouseId: '3' });
    expect(convertQuoteBody(undefined)).toEqual({});
  });
});
