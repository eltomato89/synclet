import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from '@/locales/de.json';
import en from '@/locales/en.json';

export const SUPPORTED_LANGUAGES = ['de', 'en'] as const;

function detectLanguage(): 'de' | 'en' {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'de';
  return lang?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: { de: { translation: de }, en: { translation: en } },
    lng: detectLanguage(),
    fallbackLng: 'de',
    supportedLngs: SUPPORTED_LANGUAGES,
    interpolation: { escapeValue: false }, // React escapes already
    returnNull: false,
  });
  if (typeof document !== 'undefined') {
    document.documentElement.lang = i18n.language;
    i18n.on('languageChanged', (l) => { document.documentElement.lang = l; });
  }
}

export default i18n;
