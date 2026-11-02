// Matrix rows 20 and 21: malformed messages dropped, non-participants ignored, host-only actions enforced;
// an emote is accepted only as an id of the closed shared list (audit finding A: no free text between kids).
import { EMOTES } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { RoomAdmission } from '../src/rooms/admission.js';
import { HOST_ONLY_MESSAGES, MESSAGE_LIMITS, authorizeRoomMessage, validateRoomMessage } from '../src/rooms/authz.js';

describe('validateRoomMessage', () => {
  it('accepts well-formed messages of every type', () => {
    const good = [
      { type: 'admit', accountId: 'acc-1' },
      { type: 'deny', accountId: 'acc-1' },
      { type: 'kick', accountId: 'acc-1' },
      { type: 'unblock', accountId: 'acc-1' },
      { type: 'set-entry', open: false },
      { type: 'set-auto-admit', on: true },
      { type: 'start-class', order: 'lowest-class-first' },
      { type: 'emote', emote: 'bravo' },
    ];
    for (const message of good) expect(validateRoomMessage(message)).toEqual({ ok: true, value: message });
  });

  it('accepts every emote id of the closed list', () => {
    for (const { id } of EMOTES) {
      expect(validateRoomMessage({ type: 'emote', emote: id })).toEqual({ ok: true, value: { type: 'emote', emote: id } });
    }
  });

  it('rejects unknown types, wrong field types, extra fields, non-objects and oversized strings', () => {
    const bad: unknown[] = [
      null,
      'admit',
      42,
      { type: 'nuke' },
      { type: 'admit' },
      { type: 'admit', accountId: 5 },
      { type: 'admit', accountId: 'a', extra: true },
      { type: 'set-entry', open: 'yes' },
      { type: 'start-class', order: 'fastest-first' },
      { type: 'emote', emote: 'x'.repeat(MESSAGE_LIMITS.maxStringLength + 1) },
      { type: 'emote' },
      { type: ['admit'], accountId: 'a' },
    ];
    for (const message of bad) expect(validateRoomMessage(message)).toEqual({ ok: false, error: 'malformed' });
  });

  it('rejects an emote that is not a known id: free text, an unknown id, the emoji or shout itself, non-strings', () => {
    const bad: unknown[] = [
      { type: 'emote', emote: 'hola, ¿quedamos luego?' },
      { type: 'emote', emote: 'side-eye' },
      { type: 'emote', emote: 'Bravo' },
      { type: 'emote', emote: '¡Bravo!' },
      { type: 'emote', emote: '👏' },
      { type: 'emote', emote: '' },
      { type: 'emote', emote: 3 },
      { type: 'emote', emote: ['bravo'] },
      { type: 'emote', emote: 'bravo', extra: true },
    ];
    for (const message of bad) expect(validateRoomMessage(message)).toEqual({ ok: false, error: 'malformed' });
  });

  it('lists the host-only types', () => {
    expect([...HOST_ONLY_MESSAGES].sort()).toEqual(['admit', 'deny', 'kick', 'set-auto-admit', 'set-entry', 'start-class', 'unblock']);
  });
});

describe('authorizeRoomMessage', () => {
  const setup = () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null });
    room.requestJoin('member', { confirmedClubMember: false });
    room.admit('host', 'member');
    room.requestJoin('pending', { confirmedClubMember: false });
    return room;
  };

  it('a non-participant (pending, kicked or unknown) is not heard at all, not even for an emote', () => {
    const room = setup();
    const emote = { type: 'emote', emote: 'bravo' } as const;
    expect(authorizeRoomMessage(room, 'pending', emote)).toEqual({ ok: false, error: 'not-participant' });
    expect(authorizeRoomMessage(room, 'stranger', emote)).toEqual({ ok: false, error: 'not-participant' });
    room.kick('host', 'member');
    expect(authorizeRoomMessage(room, 'member', emote)).toEqual({ ok: false, error: 'not-participant' });
  });

  it('host-only types from an admitted non-host are refused; emotes are allowed', () => {
    const room = setup();
    for (const type of HOST_ONLY_MESSAGES) {
      const message = type === 'set-entry' ? { type, open: true } : type === 'set-auto-admit' ? { type, on: true } : type === 'start-class' ? { type, order: 'random' } : { type, accountId: 'pending' };
      expect(authorizeRoomMessage(room, 'member', message as never)).toEqual({ ok: false, error: 'host-only' });
    }
    expect(authorizeRoomMessage(room, 'member', { type: 'emote', emote: 'bravo' })).toEqual({ ok: true, value: undefined });
  });

  it('the current host may send everything; after a host transfer the old host may not', () => {
    const room = setup();
    expect(authorizeRoomMessage(room, 'host', { type: 'admit', accountId: 'pending' })).toEqual({ ok: true, value: undefined });
    room.leave('host');
    expect(room.hostId).toBe('member');
    expect(authorizeRoomMessage(room, 'member', { type: 'admit', accountId: 'pending' })).toEqual({ ok: true, value: undefined });
    expect(authorizeRoomMessage(room, 'host', { type: 'admit', accountId: 'pending' })).toEqual({ ok: false, error: 'not-participant' });
  });
});
