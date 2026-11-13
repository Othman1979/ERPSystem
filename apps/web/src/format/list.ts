/**
 * Joins names into one list in the UI language: «أ وب وج» in Arabic, "A, B, and C"
 * in English (WEB-21). Use it instead of `.join('، ')`, which shows the Arabic
 * comma in the English UI.
 */
export function formatList(items: readonly string[], language: string): string {
  const locale = language === 'en' ? 'en' : 'ar';
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    // Very old browsers without Intl.ListFormat: the language's own comma.
    return items.join(locale === 'en' ? ', ' : '، ');
  }
}
