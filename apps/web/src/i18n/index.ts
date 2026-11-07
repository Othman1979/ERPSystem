import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ar, en } from './locales';

export const SUPPORTED_LANGUAGES = ['ar', 'en'] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

void i18n.use(initReactI18next).init({
  resources: {
    ar: { translation: ar },
    en: { translation: en },
  },
  lng: 'ar',
  fallbackLng: 'ar',
  interpolation: { escapeValue: false },
});

export function applyDirection(language: string): void {
  const dir = language === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.lang = language;
  document.documentElement.dir = dir;
}

applyDirection(i18n.language);
i18n.on('languageChanged', applyDirection);

export default i18n;
