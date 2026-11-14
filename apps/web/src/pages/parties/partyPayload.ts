import type { CreatePartyDto, NationalIdKind, PartyType, UpdatePartyDto } from '@erp/api-client';

/**
 * The party form's values, as antd's `onFinish` hands them over. The edit
 * form loads a missing value as undefined; a cleared input is `''`, a
 * cleared number `null`.
 */
export interface PartyFormValues {
  code: string;
  nameAr: string;
  nameEn?: string | null;
  partyType: PartyType;
  taxNumber?: string | null;
  nationalId?: string | null;
  nationalIdKind: NationalIdKind;
  phone?: string | null;
  creditLimit?: string | null;
  paymentTermsDays?: number | null;
  isCashCustomer: boolean;
  isActive: boolean;
}

const cleared = (v: string | null | undefined): string | null => (v === undefined || v === null || v === '' ? null : v);
const absent = (v: string | null | undefined): string | undefined => (v === undefined || v === null || v === '' ? undefined : v);

/**
 * The body of PUT /parties/:id. The edit form holds every field, so an empty
 * optional field is sent as null and clears it (UpdatePartyDto takes null for
 * each); the code is fixed after creation and not sent.
 */
export function partyUpdateBody(v: PartyFormValues): UpdatePartyDto {
  const body: UpdatePartyDto = {
    nameAr: v.nameAr,
    nameEn: cleared(v.nameEn),
    partyType: v.partyType,
    taxNumber: cleared(v.taxNumber),
    nationalId: cleared(v.nationalId),
    nationalIdKind: v.nationalIdKind,
    phone: cleared(v.phone),
    creditLimit: cleared(v.creditLimit),
    paymentTermsDays: v.paymentTermsDays ?? null,
    isCashCustomer: v.isCashCustomer,
    isActive: v.isActive,
  };
  return body;
}

/** The body of POST /parties: empty optional fields absent. */
export function partyCreateBody(v: PartyFormValues): CreatePartyDto {
  const body: CreatePartyDto = {
    code: v.code,
    nameAr: v.nameAr,
    nameEn: absent(v.nameEn),
    partyType: v.partyType,
    taxNumber: absent(v.taxNumber),
    nationalId: absent(v.nationalId),
    nationalIdKind: v.nationalIdKind,
    phone: absent(v.phone),
    creditLimit: absent(v.creditLimit),
    paymentTermsDays: v.paymentTermsDays ?? undefined,
    isCashCustomer: v.isCashCustomer,
    isActive: v.isActive,
  };
  return body;
}
