import i18n from './index';

/** Any record that carries a translated name pair. */
export interface Named {
  nameAr: string;
  nameEn?: string | null;
}

/**
 * Name to show for the UI language, falling back to the other language.
 */
export function displayName(entity: Named, lang?: string): string;
export function displayName(entity: Named | null | undefined, lang?: string): string | undefined;
export function displayName(entity: Named | null | undefined, lang = i18n.language): string | undefined {
  if (!entity) return undefined;
  const ar = entity.nameAr?.trim();
  const en = entity.nameEn?.trim();
  return lang === 'en' ? en || ar || '' : ar || en || '';
}

/**
 * Kept for callers that previously used a combined name; displays one language.
 */
export function bothNames(entity: Named, lang = i18n.language): string {
  return displayName(entity, lang) ?? '';
}

/** "CODE — Name" label used in selects and lookup columns. */
export function codeAndName(entity: Named & { code: string }, lang?: string): string;
export function codeAndName(
  entity: (Named & { code: string }) | null | undefined,
  lang?: string,
): string | undefined;
export function codeAndName(
  entity: (Named & { code: string }) | null | undefined,
  lang = i18n.language,
): string | undefined {
  if (!entity) return undefined;
  return `${entity.code} — ${displayName(entity, lang)}`;
}
