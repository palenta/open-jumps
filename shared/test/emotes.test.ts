// Emotes are a closed list (audit finding A): spectators send an id, the room relays only ids, so no free text
// ever travels between kids. Ids are plain lowercase ASCII; shouts are Spanish crowd shouts opening with "¡".
import { describe, expect, it } from 'vitest';
import { EMOTES, EMOTE_IDS, isEmoteId } from '../src/rules/emotes.js';

describe('EMOTES', () => {
  it('is a short closed list of crowd shouts (about ten)', () => {
    expect(EMOTES.length).toBeGreaterThanOrEqual(8);
    expect(EMOTES.length).toBeLessThanOrEqual(16);
  });

  it('ids are unique and lowercase ASCII letters only', () => {
    const ids = EMOTES.map((emote) => emote.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });

  it('every emote carries an emoji and a non-empty Spanish shout that opens with "¡" and closes with "!"', () => {
    for (const { emoji, shout } of EMOTES) {
      expect(emoji.length).toBeGreaterThan(0);
      expect(shout.startsWith('¡')).toBe(true);
      // Spanish letters (with accents and ñ), spaces and the two exclamation marks; nothing else.
      expect(shout).toMatch(/^¡[A-Za-zÁÉÍÓÚÑÜáéíóúñü ]+!$/);
    }
  });

  it('EMOTE_IDS holds exactly the ids of the list', () => {
    expect([...EMOTE_IDS].sort()).toEqual(EMOTES.map((emote) => emote.id).sort());
  });
});

describe('isEmoteId', () => {
  it('accepts every id of the list', () => {
    for (const { id } of EMOTES) expect(isEmoteId(id)).toBe(true);
  });

  it('rejects other strings (free text, near misses, the emoji or the shout itself) and non-strings', () => {
    const rejected: unknown[] = [
      '',
      'BRAVO',
      'bravo ',
      ' bravo',
      'side-eye',
      'hola amigos',
      '¡Bravo!',
      '👏',
      'x'.repeat(64),
      42,
      null,
      undefined,
      {},
      ['bravo'],
      true,
      Symbol('bravo'),
    ];
    for (const value of rejected) expect(isEmoteId(value)).toBe(false);
  });
});
