// Matrix row 14: every visible name passes the server filter, including leet, dots and diacritics bypasses.
import { describe, expect, it } from 'vitest';
import { NAME_RULES, checkName, normalizeName } from '../src/names/filter.js';

describe('normalizeName', () => {
  it('lower-cases, strips diacritics, maps leet digits/symbols and drops everything that is not a letter', () => {
    expect(normalizeName('Lucía')).toBe('lucia');
    expect(normalizeName('P.U.T.A')).toBe('puta');
    expect(normalizeName('sh1t')).toBe('shit');
    expect(normalizeName('m13rd4')).toBe('mierda');
    expect(normalizeName('@$$')).toBe('ass');
    expect(normalizeName('Sofía-María')).toBe('sofiamaria');
  });
});

describe('checkName: innocent names pass', () => {
  it.each(['Dakota', 'Lucía', 'Sofía-María', 'Buran', "O'Neil", 'Cassandra', 'Pepe', 'Luna 2', 'Открытые Прыжки', 'Mia'])(
    'allows %s',
    (name) => {
      const result = checkName(name, 'rider');
      expect(result.ok).toBe(true);
    },
  );

  it('returns a trimmed, space-collapsed display name and the normalised key', () => {
    expect(checkName('  Sofía   María ', 'rider')).toEqual({ ok: true, display: 'Sofía María', key: 'sofiamaria' });
  });

  it('"Cassandra" is not blocked by the whole-word entry "ass"', () => {
    expect(checkName('Cassandra', 'pony').ok).toBe(true);
    expect(checkName('Assassin', 'pony').ok).toBe(true);
  });
});

describe('checkName: blocked words in English and Spanish', () => {
  it.each(['puta', 'Puta123', 'mierda', 'Hijo de puta', 'cabrón', 'gilipollas', 'fuck', 'Shit Pony', 'bitch', 'nigger'])(
    'blocks %s',
    (name) => {
      expect(checkName(name, 'pony')).toEqual({ ok: false, reason: 'blocked' });
    },
  );

  it('blocks bypasses with separators, leet and diacritics', () => {
    for (const name of ['p.u.t.a', 'p u t a', 'P-u-t-a', 'sh1t', 'm1erda', 'putá', 'f u c k', 'c@brón', '5hit']) {
      expect(checkName(name, 'rider')).toEqual({ ok: false, reason: 'blocked' });
    }
  });

  it('whole-word entries block the word itself but not longer innocent words', () => {
    expect(checkName('ass', 'rider')).toEqual({ ok: false, reason: 'blocked' });
    expect(checkName('culo', 'rider')).toEqual({ ok: false, reason: 'blocked' });
    expect(checkName('Culoca', 'rider').ok).toBe(true);
  });

  it('applies to riders, ponies and clubs alike', () => {
    for (const kind of ['rider', 'pony', 'club'] as const) {
      expect(checkName('joder', kind)).toEqual({ ok: false, reason: 'blocked' });
    }
  });
});

describe('checkName: length and characters', () => {
  it('too short (one letter or blank) and too long per kind', () => {
    expect(checkName('A', 'rider')).toEqual({ ok: false, reason: 'too-short' });
    expect(checkName('   ', 'rider')).toEqual({ ok: false, reason: 'too-short' });
    expect(checkName('A'.repeat(17), 'rider')).toEqual({ ok: false, reason: 'too-long' });
    expect(checkName('A'.repeat(17), 'pony')).toEqual({ ok: false, reason: 'too-long' });
    expect(checkName('A'.repeat(32), 'club').ok).toBe(true);
    expect(checkName('A'.repeat(33), 'club')).toEqual({ ok: false, reason: 'too-long' });
    expect(NAME_RULES.maxLength).toEqual({ rider: 16, pony: 16, club: 32 });
  });

  it('rejects emoji, angle brackets and control characters', () => {
    for (const name of ['Dakota 🐎', '<script>', 'Mia\u0000', 'a=b', 'x/y']) {
      expect(checkName(name, 'rider')).toEqual({ ok: false, reason: 'bad-characters' });
    }
  });
});
