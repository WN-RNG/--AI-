/** Small, explicit UI dictionary. User-authored titles, names and captions are never translated. */
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { translateUi, type Language, type TranslationValues } from './uiTranslations';

const storageKey = 'guangying.language';
export type { Language } from './uiTranslations';
type I18nContext = {
  language: Language;
  t: (source: string, values?: TranslationValues) => string;
};
const context = createContext<I18nContext>({
  language: 'en',
  t: (source, values) => translateUi('en', source, values),
});
const englishInterface: I18nContext = {
  language: 'en',
  t: (source, values) => translateUi('en', source, values),
};
export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = 'en';
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Storage may be unavailable in private browsing. */
    }
  }, []);
  return <context.Provider value={englishInterface}>{children}</context.Provider>;
}
export function useI18n() {
  return useContext(context);
}
