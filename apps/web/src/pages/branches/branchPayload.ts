import type { CreateBranchDto, UpdateBranchDto } from '@erp/api-client';

/**
 * The branch form's values, as antd's `onFinish` hands them over. A cleared
 * input is `''`. `code` is only shown when creating.
 */
export interface BranchFormValues {
  code?: string;
  nameAr: string;
  nameEn?: string | null;
  address?: string | null;
}

/** Trimmed text, or undefined when the input is empty or only spaces. */
const text = (v: string | null | undefined): string | undefined => {
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The body of PATCH /branches/:id. An emptied optional field is sent as null,
 * so an edit clears it; sending undefined would leave the stored value.
 */
export function branchUpdateBody(v: BranchFormValues): UpdateBranchDto {
  return {
    nameAr: v.nameAr.trim(),
    nameEn: text(v.nameEn) ?? null,
    address: text(v.address) ?? null,
  };
}

/** The body of POST /branches: an empty optional field is left out. */
export function branchCreateBody(v: BranchFormValues): CreateBranchDto {
  return {
    code: (v.code ?? '').trim(),
    nameAr: v.nameAr.trim(),
    nameEn: text(v.nameEn),
    address: text(v.address),
  };
}
