import type { TFunction } from 'i18next';

export interface EntryDescriptionRow {
  description?: string | null;
  descriptionKey?: string | null;
  descriptionParams?: unknown;
}

export function entryDescription(t: TFunction, row: EntryDescriptionRow): string {
  if (!row.descriptionKey) return row.description ?? '';
  const params =
    row.descriptionParams &&
    typeof row.descriptionParams === 'object' &&
    !Array.isArray(row.descriptionParams)
      ? (row.descriptionParams as Record<string, unknown>)
      : {};
  return t(row.descriptionKey, params);
}
