import { ApiError } from '@erp/api-client';
import type { TFunction } from 'i18next';

/** The message for a failed request: the API's code when it has one, else the generic one. */
export function errorText(t: TFunction, err: unknown): string {
  return err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL');
}
