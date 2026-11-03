// Localisation (plan 1.5, 2.2; matrix row 16): the two locales are complete and carry the same keys, the
// equestrian terms live in terms.ts only and the dictionaries reach them as `{term:id}`, translate never throws
// on a data problem, captions speak rider vocabulary with the pony's name first, and the round clock reads in
// tenths that have actually passed. No Russian anywhere.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGES,
  TERMS,
  caption,
  formatRoundTime,
  isLocale,
  isMessageKey,
  isTermId,
  messageKeys,
  placeholdersOf,
  term,
  translate,
  translateKey,
  type CaptionNames,
  type Locale,
  type MessageKey,
} from '../src/index.js';

const en = MESSAGES.en;
const es = MESSAGES.es;
const keys = Object.keys(en) as MessageKey[];
const locales: Locale[] = ['en', 'es'];
const names: CaptionNames = { rider: 'Maria', pony: 'Dakota', ponyGender: 'yegua' };

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `literal` occurs in `text` as a whole word or phrase, never inside a longer word ("Categoría" holds "ría"). */
const containsPhrase = (text: string, literal: string): boolean =>
  new RegExp(`(^|[^\\p{L}])${escapeRegExp(literal)}([^\\p{L}]|$)`, 'u').test(text);

/** A term that is a single plain ASCII word ("manga", "vertical") may legitimately occur as an English or Spanish word. */
const isPlainAsciiWord = (value: string): boolean => /^[a-z]+$/i.test(value);

describe('locales', () => {
  it('offers English and Spanish, in that order, with English as the default', () => {
    expect(LOCALES).toEqual(['en', 'es']);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('isLocale accepts exactly the two locale codes', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('es')).toBe(true);
    for (const value of ['ru', 'EN', 'es-ES', '', 'de', 42, null, undefined, {}]) expect(isLocale(value)).toBe(false);
  });
});

describe('dictionaries', () => {
  it('es has exactly the key set of en', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it('messageKeys lists the en keys in dictionary order; isMessageKey knows them and nothing else', () => {
    expect(messageKeys()).toEqual(Object.keys(en));
    for (const key of keys) expect(isMessageKey(key)).toBe(true);
    expect(isMessageKey('nope')).toBe(false);
    expect(isMessageKey('')).toBe(false);
    expect(isMessageKey(7)).toBe(false);
  });

  it('no string is empty in either locale', () => {
    for (const locale of locales) {
      for (const key of keys) expect(MESSAGES[locale][key].trim().length, `${locale} ${key}`).toBeGreaterThan(0);
    }
  });

  it('no string contains Cyrillic (plan 1.5: no Russian in the game)', () => {
    for (const locale of locales) {
      for (const key of keys) expect(MESSAGES[locale][key], `${locale} ${key}`).not.toMatch(/[Ѐ-ӿ]/);
    }
  });

  it('every {term:id} references a term in terms.ts and every {param} is a plain identifier', () => {
    for (const locale of locales) {
      for (const key of keys) {
        const { params, terms } = placeholdersOf(MESSAGES[locale][key]);
        for (const id of terms) expect(isTermId(id), `${locale} ${key} {term:${id}}`).toBe(true);
        for (const param of params) expect(param, `${locale} ${key}`).toMatch(/^[a-zA-Z]\w*$/);
      }
    }
  });

  it('per key, es uses the same terms as en and only parameters en has (a locale may omit a parameter)', () => {
    for (const key of keys) {
      const enPlaceholders = placeholdersOf(en[key]);
      const esPlaceholders = placeholdersOf(es[key]);
      expect([...esPlaceholders.terms].sort(), key).toEqual([...enPlaceholders.terms].sort());
      for (const param of esPlaceholders.params) expect(enPlaceholders.params, `${key} {${param}}`).toContain(param);
    }
  });

  it('term literals stay in terms.ts: no multi-word or accented term is spelled out in a dictionary string', () => {
    const literals = Object.values(TERMS).filter((value) => !isPlainAsciiWord(value));
    expect(literals).toContain('rehúse');
    expect(literals).toContain('batida corta');
    expect(literals).toContain('¡Recto!');
    for (const locale of locales) {
      for (const key of keys) {
        for (const literal of literals) {
          expect(containsPhrase(MESSAGES[locale][key], literal), `${locale} ${key} spells out "${literal}"`).toBe(false);
        }
      }
    }
  });
});

/** The keys K1.1 adds (step 8): the reasons a touch did nothing, the gear and line toasts, the walk map's captions. */
const K1_1_KEYS = [
  'hud.pressNote.not-armed',
  'hud.pressNote.already-tapped',
  'hud.pressNote.cannot-send',
  'hud.pressNote.too-old',
  'hud.toast.gear.collected',
  'hud.toast.gear.extended',
  'hud.toast.gear.gallop',
  'hud.toast.line.center',
  'hud.toast.line.angle',
  'walk.map.label',
  'walk.map.start',
  'walk.map.finish',
];

describe('the K1.1 strings (step 8)', () => {
  it.each(K1_1_KEYS)('%s is a key of both locales, non-empty, without Cyrillic', (key) => {
    expect(isMessageKey(key), key).toBe(true);
    for (const locale of locales) {
      const text = translateKey(locale, key);
      expect(text, `${locale} ${key}`).not.toBe(key);
      expect(text.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
      expect(text, `${locale} ${key}`).not.toMatch(/[Ѐ-ӿ]/);
    }
  });

  it('the gear toasts name the gear by its term in both locales', () => {
    for (const locale of locales) {
      expect(translateKey(locale, 'hud.toast.gear.collected'), locale).toContain(TERMS.galope_reunido);
      expect(translateKey(locale, 'hud.toast.gear.extended'), locale).toContain(TERMS.galope_largo);
      expect(translateKey(locale, 'hud.toast.gear.gallop'), locale).toContain(TERMS.a_toda_carrera);
    }
  });

  it('the reasons of an ignored touch differ from each other and between the locales', () => {
    const reasons = ['not-armed', 'already-tapped', 'cannot-send', 'too-old'].map((reason) => `hud.pressNote.${reason}`);
    for (const locale of locales) expect(new Set(reasons.map((key) => translateKey(locale, key))).size, locale).toBe(4);
    for (const key of reasons) expect(translateKey('es', key), key).not.toBe(translateKey('en', key));
  });

  it('negative: no reason for the two outcomes that say nothing (not-riding, no-control)', () => {
    expect(isMessageKey('hud.pressNote.not-riding')).toBe(false);
    expect(isMessageKey('hud.pressNote.no-control')).toBe(false);
  });
});

describe('TERMS', () => {
  it('values are Spanish lowercase words or phrases, or a shout opening with ¡', () => {
    for (const [id, value] of Object.entries(TERMS)) {
      expect(value, id).toMatch(/^[¡a-záéíóúñü ]+!?$/i);
      expect(value.trim(), id).toBe(value);
    }
    expect(term('rehuse')).toBe('rehúse');
    expect(term('recto')).toBe('¡Recto!');
  });

  it('isTermId knows the ids and nothing else', () => {
    expect(isTermId('rehuse')).toBe(true);
    expect(isTermId('batida_corta')).toBe(true);
    expect(isTermId('nope')).toBe(false);
    expect(isTermId('rehúse')).toBe(false);
    expect(isTermId(123)).toBe(false);
    expect(isTermId(undefined)).toBe(false);
  });
});

describe('placeholdersOf', () => {
  it('lists parameters and term ids in order of appearance, without duplicates', () => {
    expect(placeholdersOf('{pony}: {term:rehuse} at fence {fence} — {term:rehuse}')).toEqual({
      params: ['pony', 'fence'],
      terms: ['rehuse'],
    });
  });

  it('a template without placeholders has none', () => {
    expect(placeholdersOf('Open Jumps')).toEqual({ params: [], terms: [] });
    expect(placeholdersOf('')).toEqual({ params: [], terms: [] });
  });

  it('an unknown term id is listed as written (the dictionary test decides whether it exists)', () => {
    expect(placeholdersOf('{term:nope} then {term:nope} and {x}')).toEqual({ params: ['x'], terms: ['nope'] });
  });
});

describe('translate', () => {
  it('fills parameters in the locale', () => {
    expect(translate('en', 'home.hello', { rider: 'Maria', pony: 'Dakota' })).toBe('Maria on Dakota');
    expect(translate('es', 'home.hello', { rider: 'Maria', pony: 'Dakota' })).toBe('Maria con Dakota');
  });

  it('substitutes the Spanish term in both locales', () => {
    expect(translate('en', 'hud.gear.collected')).toBe('galope reunido');
    expect(translate('es', 'hud.gear.collected')).toBe('galope reunido');
    expect(translate('en', 'hud.gear.gallop')).toBe('a toda carrera');
    expect(translate('es', 'walk.title')).toBe('reconocimiento');
  });

  it('replaces several terms in one string', () => {
    expect(translate('en', 'results.eliminated.refusals')).toBe('eliminada — three rehúse');
    expect(translate('es', 'results.eliminated.refusals')).toBe('eliminada — tres rehúse');
    expect(translate('en', 'results.eliminated.disconnected')).toBe('eliminada — sin conexión');
  });

  it('writes numbers as-is', () => {
    expect(translate('en', 'lobby.heightCm', { cm: 70 })).toBe('70 cm');
    expect(translate('en', 'hud.phase.riding', { heat: 1 })).toBe('manga 1');
    expect(translate('en', 'walk.time', { allowed: 24, limit: 48 })).toBe('Time allowed 24 s · limit 48 s');
  });

  it('a missing parameter leaves its placeholder in place and never throws', () => {
    expect(translate('en', 'lobby.heightCm', {})).toBe('{cm} cm');
    expect(translate('en', 'lobby.heightCm')).toBe('{cm} cm');
    expect(() => translate('en', 'caption.takeoff.rehuse')).not.toThrow();
    expect(translate('en', 'caption.takeoff.rehuse')).toBe("{pony}: rehúse at fence {fence} — {she}'s fine");
  });

  it('every string of both locales renders without a term reference left behind', () => {
    for (const locale of locales) {
      for (const key of keys) {
        const text = translate(locale, key);
        expect(text.length, `${locale} ${key}`).toBeGreaterThan(0);
        expect(text, `${locale} ${key}`).not.toMatch(/\{term:/);
      }
    }
  });
});

describe('translateKey', () => {
  it('translates a key built at runtime like translate', () => {
    expect(translateKey('en', 'caption.takeoff.perfecta', { pony: 'Dakota', fence: 3 })).toBe('Dakota: perfecta at fence 3!');
    expect(translateKey('es', 'caption.takeoff.perfecta', { pony: 'Dakota', fence: 3 })).toBe('Dakota: ¡perfecta en el salto 3!');
    expect(translateKey('en', 'caption.refused.other', { error: 'x' })).toBe('Not allowed: x');
    expect(translateKey('es', 'caption.refused.other', { error: 'x' })).toBe('No permitido: x');
  });

  it('an unknown key returns the key itself, never throws', () => {
    expect(translateKey('en', 'no.such.key')).toBe('no.such.key');
    expect(translateKey('es', 'no.such.key', { pony: 'Dakota' })).toBe('no.such.key');
    expect(translateKey('en', '')).toBe('');
  });
});

describe('caption', () => {
  it('a take-off with a known label: the pony first, the term, the fence, the pronoun for the pony', () => {
    expect(caption('en', { type: 'takeoff', label: 'rehuse', fence: 3 }, names)).toBe("Dakota: rehúse at fence 3 — she's fine");
    expect(caption('en', { type: 'takeoff', label: 'rehuse', fence: 3 }, { ...names, ponyGender: 'macho' })).toBe("Dakota: rehúse at fence 3 — he's fine");
    expect(caption('es', { type: 'takeoff', label: 'rehuse', fence: 3 }, names)).toBe('Dakota: rehúse en el salto 3 — está bien');
  });

  it('take-off labels from the judge: perfecta, batida_corta, caida', () => {
    expect(caption('en', { type: 'takeoff', label: 'perfecta', fence: 1 }, names)).toBe('Dakota: perfecta at fence 1!');
    expect(caption('es', { type: 'takeoff', label: 'perfecta', fence: 1 }, names)).toBe('Dakota: ¡perfecta en el salto 1!');
    expect(caption('en', { type: 'takeoff', label: 'batida_corta', fence: 2 }, names)).toBe('Dakota: batida corta at fence 2 — derribo');
    expect(caption('en', { type: 'takeoff', label: 'caida', fence: 4 }, names)).toBe('Dakota: caída at fence 4 — Maria is back in the saddle');
  });

  it('an unknown take-off label is shown as written through the other key', () => {
    expect(caption('en', { type: 'takeoff', label: 'mystery', fence: 5 }, names)).toBe('Dakota: mystery at fence 5');
    expect(caption('es', { type: 'takeoff', label: 'mystery', fence: 5 }, names)).toBe('Dakota: mystery en el salto 5');
  });

  it('turn labels: the term, or the label as written when unknown', () => {
    expect(caption('en', { type: 'turn', label: 'giro_cerrado' }, names)).toBe('Dakota: giro cerrado');
    expect(caption('en', { type: 'turn', label: 'giro_abierto' }, names)).toBe('Dakota: giro abierto');
    expect(caption('en', { type: 'turn', label: 'zzz' }, names)).toBe('Dakota: zzz');
  });

  it('the two turns that stop the horse say why in words of the locale, after the pony and the term (K1.1 step 8)', () => {
    const recto = { en: caption('en', { type: 'turn', label: 'recto' }, names), es: caption('es', { type: 'turn', label: 'recto' }, names) };
    expect(recto.en.startsWith('Dakota: ¡Recto!')).toBe(true);
    expect(recto.en).toContain('missed the turn');
    expect(recto.es.startsWith('Dakota: ¡Recto!')).toBe(true);
    expect(recto.es).toContain('se pasó el giro');
    const wrong = {
      en: caption('en', { type: 'turn', label: 'recorrido_equivocado' }, names),
      es: caption('es', { type: 'turn', label: 'recorrido_equivocado' }, names),
    };
    expect(wrong.en.startsWith('Dakota: recorrido equivocado')).toBe(true);
    expect(wrong.en).toContain('wrong way');
    expect(wrong.es.startsWith('Dakota: recorrido equivocado')).toBe(true);
    expect(wrong.es).toContain('hacia el otro lado');
  });

  it('negative: the terms stay terms — reached as {term:…} in both locales, never spelled out', () => {
    for (const locale of locales) {
      expect(MESSAGES[locale]['caption.turn.recto']).toContain('{term:recto}');
      expect(MESSAGES[locale]['caption.turn.recorrido_equivocado']).toContain('{term:recorrido_equivocado}');
    }
  });

  it('the finish shows the round time in tenths', () => {
    expect(caption('en', { type: 'finish', elapsedMs: 62_340 }, names)).toBe('Dakota: finished in 1:02.3');
    expect(caption('es', { type: 'finish', elapsedMs: 62_340 }, names)).toBe('Dakota: meta en 1:02.3');
  });

  it('eliminations name the reason', () => {
    expect(caption('en', { type: 'eliminated', reason: 'refusals' }, names)).toBe('Dakota: eliminada — three rehúse');
    expect(caption('en', { type: 'eliminated', reason: 'time' }, names)).toBe('Dakota: eliminada — time');
    expect(caption('en', { type: 'eliminated', reason: 'disconnected' }, names)).toBe('Dakota: sin conexión');
    expect(caption('es', { type: 'eliminated', reason: 'refusals' }, names)).toBe('Dakota: eliminada — tres rehúse');
  });

  it('autopilot on and off, a restart, and a refused action', () => {
    expect(caption('en', { type: 'autopilot', on: true }, names)).toBe('Dakota: autopilot — Maria lost connection');
    expect(caption('en', { type: 'autopilot', on: false }, names)).toBe('Dakota: Maria is back');
    expect(caption('en', { type: 'restart', fence: 2 }, names)).toBe('Dakota: again at fence 2');
    expect(caption('en', { type: 'refused', error: 'clock-not-ready' }, names)).toBe('Clock not ready yet');
    expect(caption('en', { type: 'refused', error: 'weird' }, names)).toBe('Not allowed: weird');
    expect(caption('es', { type: 'refused', error: 'not-riding' }, names)).toBe('Ahora no te toca montar');
  });
});

describe('formatRoundTime', () => {
  it('below a minute: seconds and a tenth', () => {
    expect(formatRoundTime(0)).toBe('0.0');
    expect(formatRoundTime(42_349)).toBe('42.3');
    expect(formatRoundTime(59_999)).toBe('59.9');
  });

  it('truncates to the tenth that has passed, never rounds up', () => {
    expect(formatRoundTime(42_399)).toBe('42.3');
    expect(formatRoundTime(59_999)).toBe('59.9');
    expect(formatRoundTime(99)).toBe('0.0');
  });

  it('from a minute: minutes, two-digit seconds and a tenth', () => {
    expect(formatRoundTime(60_000)).toBe('1:00.0');
    expect(formatRoundTime(62_340)).toBe('1:02.3');
    expect(formatRoundTime(600_000)).toBe('10:00.0');
  });

  it('negative or non-finite input reads 0.0', () => {
    expect(formatRoundTime(-5)).toBe('0.0');
    expect(formatRoundTime(Number.NaN)).toBe('0.0');
    expect(formatRoundTime(Number.POSITIVE_INFINITY)).toBe('0.0');
    expect(formatRoundTime(Number.NEGATIVE_INFINITY)).toBe('0.0');
  });
});
