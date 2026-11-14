import { describe, expect, it } from 'vitest';
import { partyCreateBody, partyUpdateBody, type PartyFormValues } from './partyPayload';

/** An edit with every optional field emptied the way its control empties it. */
const emptied: PartyFormValues = {
  code: 'C1',
  nameAr: 'عميل',
  nameEn: '',
  partyType: 'CUSTOMER',
  taxNumber: '',
  nationalId: undefined,
  nationalIdKind: 'NIN',
  phone: '',
  creditLimit: null,
  paymentTermsDays: null,
  isCashCustomer: false,
  isActive: true,
};

const sent = (body: object) => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

describe('party form bodies', () => {
  it('an edit sends every emptied optional field as null, so it is cleared, and never the code', () => {
    expect(sent(partyUpdateBody(emptied))).toEqual({
      nameAr: 'عميل',
      nameEn: null,
      partyType: 'CUSTOMER',
      taxNumber: null,
      nationalId: null,
      nationalIdKind: 'NIN',
      phone: null,
      creditLimit: null,
      paymentTermsDays: null,
      isCashCustomer: false,
      isActive: true,
    });
  });

  it('an edit keeps filled values, including 0 days of terms', () => {
    const body = sent(partyUpdateBody({ ...emptied, nameEn: 'Customer', creditLimit: '500.000', paymentTermsDays: 0 }));
    expect(body).toMatchObject({ nameEn: 'Customer', creditLimit: '500.000', paymentTermsDays: 0 });
  });

  it('a create sends the code and leaves empty optional fields out', () => {
    expect(sent(partyCreateBody(emptied))).toEqual({
      code: 'C1',
      nameAr: 'عميل',
      partyType: 'CUSTOMER',
      nationalIdKind: 'NIN',
      isCashCustomer: false,
      isActive: true,
    });
  });
});
