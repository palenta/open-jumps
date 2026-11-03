// Localisation (plan 1.5, 2.2): one dictionary per locale with the SAME keys, equestrian terms from terms.ts
// referenced as `{term:id}`, parameters as `{name}`. Pure functions, shared by client and server (captions).
import { en } from './en.js';
import { es } from './es.js';
import type { Locale } from './locale.js';
import { TERMS, isTermId } from './terms.js';

export type MessageKey = keyof typeof en;
export const MESSAGES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, es };

/** Parameter values; numbers are written as-is (no locale number formatting in this version). */
export type Params = Readonly<Record<string, string | number>>;

/** The placeholders a template uses: parameter names and term ids (as written, even if unknown). */
export interface Placeholders {
  params: string[];
  terms: string[];
}

/** Every message key, in dictionary order (the en dictionary defines the set). */
export function messageKeys(): MessageKey[] {
  return Object.keys(en) as MessageKey[];
}

/** True for a key both dictionaries know. */
export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(en, value);
}

/**
 * A placeholder is a brace pair with no brace inside: group 1 is a term id (`{term:id}`), group 2 a parameter
 * name (`{name}`). A fresh RegExp per call keeps the global `lastIndex` state out of the pure functions.
 */
const placeholderPattern = (): RegExp => /\{term:([^{}]+)\}|\{([^{}]+)\}/g;

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** Parse `{name}` and `{term:id}` placeholders of a template, in order of appearance, without duplicates. */
export function placeholdersOf(template: string): Placeholders {
  const params: string[] = [];
  const terms: string[] = [];
  for (const match of template.matchAll(placeholderPattern())) {
    const [, termId, param] = match;
    if (termId !== undefined) {
      if (!terms.includes(termId)) terms.push(termId);
    } else if (param !== undefined && !params.includes(param)) {
      params.push(param);
    }
  }
  return { params, terms };
}

/**
 * One pass over the template: a known term id becomes the Spanish term, a given parameter its value (numbers
 * as-is); anything else stays as written. One pass, so a value never gets expanded again.
 */
function fill(template: string, params: Params): string {
  return template.replace(placeholderPattern(), (written: string, termId: string | undefined, param: string | undefined) => {
    if (termId !== undefined) return isTermId(termId) ? TERMS[termId] : written;
    if (param !== undefined && hasOwn(params, param)) {
      const value = params[param];
      if (value !== undefined) return String(value);
    }
    return written;
  });
}

/**
 * The message for `key` in `locale` with `{term:id}` replaced by the Spanish term and `{name}` by params.name.
 * Never throws for data problems (a game must not crash on a missing string): a missing parameter leaves its
 * placeholder in place, an unknown term id leaves `{term:id}` in place.
 */
export function translate(locale: Locale, key: MessageKey, params: Params = {}): string {
  const dictionary: Readonly<Record<string, string>> = MESSAGES[locale] ?? en;
  // The dictionaries share one key set, but a key built at runtime may still miss: the key itself is shown.
  const template = hasOwn(dictionary, key) ? dictionary[key] : hasOwn(en, key) ? en[key] : undefined;
  return typeof template === 'string' ? fill(template, params) : key;
}

/** translate() for a key built at runtime (captions, errors): an unknown key returns the key itself. */
export function translateKey(locale: Locale, key: string, params: Params = {}): string {
  return isMessageKey(key) ? translate(locale, key, params) : key;
}

export { type Locale, LOCALES, DEFAULT_LOCALE, isLocale } from './locale.js';
export { TERMS, term, isTermId, type TermId } from './terms.js';
export { caption, formatRoundTime, type CaptionEvent, type CaptionNames } from './captions.js';
