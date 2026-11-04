// Matrix rows 20 and 21: malformed messages dropped, non-participants ignored, host-only actions enforced;
// an emote is accepted only as an id of the closed shared list (audit finding A: no free text between kids).
import { EMOTES } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { RoomAdmission } from '../src/rooms/admission.js';
import { MESSAGE_NUMBER_LIMITS, RIDER_ONLY_MESSAGES, HOST_ONLY_MESSAGES, MESSAGE_LIMITS, authorizeRoomMessage, validateRoomMessage } from '../src/rooms/authz.js';

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

describe('part B2: rider commands and lobby settings', () => {
  const valid = [
    { type: 'tap', clientTime: 1_700_000_000_000, fence: 1, attempt: 1 },
    { type: 'tap', clientTime: 1_700_000_000_000, fence: 12, attempt: 4 }, // attempt 4 is legal: three falls do not eliminate
    { type: 'turn', choice: 'left', clientTime: 1_700_000_000_000 },
    { type: 'turn', choice: 'straight', clientTime: 5 },
    { type: 'gear', gear: 'gallop' },
    { type: 'line', line: 'angle' },
    { type: 'height', heightClass: 70 },
    { type: 'assists', schoolmaster: true, widerWindow: false },
    { type: 'clock-pong', serverSent: 1000, clientTime: 1500 },
  ];
  const malformed = [
    { type: 'tap', clientTime: 'now', fence: 1, attempt: 1 },
    { type: 'tap', clientTime: 1, fence: 0, attempt: 1 },
    { type: 'tap', clientTime: 1, fence: 13, attempt: 1 },
    { type: 'tap', clientTime: 1, fence: 1, attempt: 0 },
    { type: 'tap', clientTime: 1, fence: 1, attempt: 1.5 },
    { type: 'tap', clientTime: Number.NaN, fence: 1, attempt: 1 },
    { type: 'tap', clientTime: 1, fence: 1 },
    { type: 'tap', clientTime: 1, fence: 1, attempt: 1, riderId: 'someone-else' },
    { type: 'turn', choice: 'back', clientTime: 1 },
    { type: 'gear', gear: 'warp' },
    { type: 'line', line: 'left' },
    { type: 'height', heightClass: 65 },
    { type: 'height', heightClass: '70' },
    { type: 'assists', schoolmaster: 'yes', widerWindow: false },
    { type: 'assists', schoolmaster: true },
    { type: 'clock-pong', serverSent: 1000 },
    { type: 'clock-pong', serverSent: Number.POSITIVE_INFINITY, clientTime: 1 },
  ];

  it('accepts well-formed rider commands, settings and clock answers; strings are exact, numbers finite and bounded', () => {
    for (const raw of valid) expect(validateRoomMessage(raw)).toEqual({ ok: true, value: raw });
    expect(MESSAGE_NUMBER_LIMITS).toEqual({ maxFence: 12 }); // no cap on the attempt number: the server checks the current attempt
    expect([...RIDER_ONLY_MESSAGES].sort()).toEqual(['gear', 'line', 'tap', 'turn']);
  });

  it('rejects malformed ones (a horse id in the payload is malformed: commands are always about the sender\'s own horse)', () => {
    for (const raw of malformed) expect(validateRoomMessage(raw)).toEqual({ ok: false, error: 'malformed' });
  });

  it('rider commands and settings are participant messages, never host-only', () => {
    const admission = new RoomAdmission({ hostId: 'host', clubId: null });
    admission.requestJoin('bea', { confirmedClubMember: false });
    admission.admit('host', 'bea');
    for (const raw of valid) {
      const message = validateRoomMessage(raw);
      if (!message.ok) throw new Error('valid message expected');
      expect(authorizeRoomMessage(admission, 'bea', message.value)).toEqual({ ok: true, value: undefined });
      expect(authorizeRoomMessage(admission, 'stranger', message.value)).toEqual({ ok: false, error: 'not-participant' });
      expect(HOST_ONLY_MESSAGES.has(message.value.type)).toBe(false);
    }
  });
});

describe('K1.1 code audit r2: a gear or line command may carry its seq', () => {
  it('accepts a gear or a line with a seq — a safe integer from 0 — and keeps it in the message; without seq it is the older command', () => {
    for (const raw of [
      { type: 'gear', gear: 'gallop', seq: 0 },
      { type: 'gear', gear: 'extended', seq: 41 },
      { type: 'line', line: 'angle', seq: 7 },
      { type: 'line', line: 'center', seq: Number.MAX_SAFE_INTEGER },
      { type: 'gear', gear: 'collected' },
      { type: 'line', line: 'angle' },
    ]) {
      expect(validateRoomMessage(raw)).toEqual({ ok: true, value: raw });
    }
  });

  it('negative: a seq that is not a safe integer from 0 is malformed, and so is a seq on any other command', () => {
    for (const raw of [
      { type: 'gear', gear: 'gallop', seq: -1 },
      { type: 'gear', gear: 'gallop', seq: 1.5 },
      { type: 'gear', gear: 'gallop', seq: '3' },
      { type: 'gear', gear: 'gallop', seq: Number.NaN },
      { type: 'line', line: 'angle', seq: null },
      { type: 'line', line: 'angle', seq: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'gear', gear: 'warp', seq: 1 },
      { type: 'gear', gear: 'gallop', seq: 1, riderId: 'someone-else' },
      { type: 'tap', clientTime: 1, fence: 1, attempt: 1, seq: 1 },
      { type: 'turn', choice: 'left', clientTime: 1, seq: 1 },
    ]) {
      expect(validateRoomMessage(raw)).toEqual({ ok: false, error: 'malformed' });
    }
  });
});
