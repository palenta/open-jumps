// Name filter (plan 1.7а, matrix row 14): every visible name — rider, pony, club — passes it on the server.
import { BLOCKED_TERMS } from './blocklist.js';

export type NameKind = 'rider' | 'pony' | 'club';

export const NAME_RULES = {
  minLength: 2,
  maxLength: { rider: 16, pony: 16, club: 32 } as Record<NameKind, number>,
} as const;

export type NameCheck =
  | { ok: true; display: string; key: string }
  | { ok: false; reason: 'too-short' | 'too-long' | 'bad-characters' | 'blocked' };

/** Leet digits and symbols that stand in for letters. */
const LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

/** Letters of any script (with their combining marks), decimal digits, spaces, apostrophes (straight or typographic) and hyphens. */
const ALLOWED_CHARACTERS = /^[\p{L}\p{M}\p{Nd} '’-]+$/u;

/** Anything that is not a letter, mark, digit or leet symbol separates words for the whole-word check. */
const WORD_SEPARATOR = /[^\p{L}\p{M}\p{N}@$]+/u;

/**
 * Normalise for matching and uniqueness: Unicode NFKD, strip diacritics, lower-case, map leet digits and
 * symbols to letters (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s), drop everything that is not a letter.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => LEET[c] ?? c)
    .replace(/\P{L}/gu, '');
}

/**
 * Trim and collapse spaces; allow letters of any script, digits, spaces, apostrophes and hyphens;
 * enforce length per kind; reject when the normalised name contains a blocked term (whole word for
 * 'word' entries, anywhere for 'substring' entries), also after removing separators ("p.u.t.a").
 */
export function checkName(name: string, kind: NameKind): NameCheck {
  const display = name.trim().replace(/\s+/g, ' ');
  const length = [...display].length;
  if (length < NAME_RULES.minLength) return { ok: false, reason: 'too-short' };
  if (length > NAME_RULES.maxLength[kind]) return { ok: false, reason: 'too-long' };
  const key = normalizeName(display);
  if (containsBlockedTerm(display, key)) return { ok: false, reason: 'blocked' };
  if (!ALLOWED_CHARACTERS.test(display)) return { ok: false, reason: 'bad-characters' };
  return { ok: true, display, key };
}

function containsBlockedTerm(display: string, key: string): boolean {
  const words = display.split(WORD_SEPARATOR).map(normalizeName).filter((word) => word !== '');
  return BLOCKED_TERMS.some(({ term, mode }) =>
    mode === 'substring' ? key.includes(term) : key === term || words.includes(term),
  );
}
