import { createContext, useContext } from 'react';
import { COPY, type Copy, type Language } from './copy';

export interface LanguageContextValue {
  language: Language;
  setLanguage(language: Language): void;
}

export const LanguageContext = createContext<LanguageContextValue>({
  language: 'ko',
  setLanguage: () => undefined,
});

export function useCopy(): Copy {
  return COPY[useContext(LanguageContext).language];
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
