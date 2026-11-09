import i18n from './index';

/** Any record that carries a translated name pair. */
export interface Named {
  nameAr: string;
  nameEn?: string | null;
}

/**
 * Name to show for the current UI language: English when the UI is English and
 * an English name exists, otherwise the Arabic name (always present).
 */
export function displayName(entity: Named, lang?: string): string;
export function displayName(entity: Named | null | undefined, lang?: string): string | undefined;
export function displayName(entity: Named | null | undefined, lang = i18n.language): string | undefined {
  if (!entity) return undefined;
  const en = entity.nameEn?.trim();
  return lang === 'en' && en ? en : entity.nameAr;
}

/**
 * Localized name first, the other language in parentheses when it exists —
 * used where accountants expect to see both (chart of accounts, trial balance).
 */
export function bothNames(entity: Named, lang = i18n.language): string {
  const primary = displayName(entity, lang);
  const en = entity.nameEn?.trim();
  const other = primary === entity.nameAr ? en : entity.nameAr;
  return other && other !== primary ? `${primary} (${other})` : primary;
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
