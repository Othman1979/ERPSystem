import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ar, en } from './locales';
// Levantine Arabic month names for dayjs and the date pickers.
import './dayjsLocale';

export const SUPPORTED_LANGUAGES = ['ar', 'en'] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const LANGUAGE_STORAGE_KEY = 'erp.language';

/** Last language the user picked on this browser; Arabic by default. */
export function storedLanguage(): AppLanguage {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return SUPPORTED_LANGUAGES.find((l) => l === saved) ?? 'ar';
  } catch {
    // Storage can be blocked (private mode, site data disabled).
    return 'ar';
  }
}

function rememberLanguage(language: string): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Not critical: the choice just won't survive a reload.
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    ar: { translation: ar },
    en: { translation: en },
  },
  lng: storedLanguage(),
  fallbackLng: 'ar',
  interpolation: { escapeValue: false },
});

export function applyDirection(language: string): void {
  const dir = language === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.lang = language;
  document.documentElement.dir = dir;
}

applyDirection(i18n.language);
i18n.on('languageChanged', (language) => {
  applyDirection(language);
  rememberLanguage(language);
});

export default i18n;
