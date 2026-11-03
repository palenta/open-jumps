// The two interface locales (plan 1.5): English and Spanish, chosen at first launch and in settings. No Russian.
export type Locale = 'en' | 'es';
export const LOCALES: readonly Locale[] = ['en', 'es'];
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'es';
}
