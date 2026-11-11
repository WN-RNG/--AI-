/** Small, explicit UI dictionary. User-authored titles, names and captions are never translated. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translateUi, type Language, type TranslationValues } from './uiTranslations';

const storageKey = 'guangying.language';
export type { Language } from './uiTranslations';
type I18nContext = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (source: string, values?: TranslationValues) => string;
};
const context = createContext<I18nContext>({
  language: 'en',
  setLanguage: () => {},
  t: (source, values) => translateUi('en', source, values),
});
function rememberedLanguage(): Language {
  try {
    return localStorage.getItem(storageKey) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(rememberedLanguage);
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    try {
      localStorage.setItem(storageKey, language);
    } catch {
      /* Storage may be unavailable in private browsing. */
    }
  }, [language]);
  const value = useMemo(
    () => ({
      language,
      setLanguage,
      t: (source: string, values?: TranslationValues) => translateUi(language, source, values),
    }),
    [language],
  );
  return <context.Provider value={value}>{children}</context.Provider>;
}
export function useI18n() {
  return useContext(context);
}
