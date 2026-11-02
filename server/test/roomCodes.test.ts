// Matrix row 1 (codes): unambiguous 6-character codes, unique while open, never reused, guessing rate-limited.
import { createRng } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { JOIN_RATE_LIMIT, JoinRateLimiter, ROOM_CODE, RoomCodeRegistry, generateRoomCode } from '../src/rooms/codes.js';
import { makeClock } from './helpers.js';

describe('generateRoomCode', () => {
  it('is 6 characters from an alphabet without I, L, O, 0 and 1', () => {
    expect(ROOM_CODE.length).toBe(6);
    for (const ambiguous of ['I', 'L', 'O', '0', '1']) expect(ROOM_CODE.alphabet).not.toContain(ambiguous);
    const rng = createRng('codes');
    for (let i = 0; i < 200; i += 1) {
      expect(generateRoomCode(rng)).toMatch(new RegExp(`^[${ROOM_CODE.alphabet}]{6}$`));
    }
  });

  it('is deterministic for a seeded rng', () => {
    expect(generateRoomCode(createRng(7))).toBe(generateRoomCode(createRng(7)));
  });
});

describe('RoomCodeRegistry', () => {
  it('allocates unique codes for open rooms and resolves them', () => {
    const registry = new RoomCodeRegistry(createRng('registry'));
    const codes = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const code = registry.allocate(`room-${i}`);
      expect(codes.has(code)).toBe(false);
      codes.add(code);
      expect(registry.lookup(code)).toBe(`room-${i}`);
    }
  });

  /** An rng that replays scripted values (each code consumes ROOM_CODE.length values), then falls back to a seed. */
  const scripted = (codes: string[]) => {
    const values: number[] = [];
    for (const code of codes) {
      for (const char of code) values.push((ROOM_CODE.alphabet.indexOf(char) + 0.5) / ROOM_CODE.alphabet.length);
    }
    const fallback = createRng('fallback');
    return () => (values.length ? values.shift()! : fallback());
  };

  it('the scripted rng really drives the code', () => {
    expect(generateRoomCode(scripted(['ABCDEF']))).toBe('ABCDEF');
  });

  it('a released code stops resolving and is skipped when the rng offers it again', () => {
    const registry = new RoomCodeRegistry(scripted(['AAAAAA', 'AAAAAA', 'BBBBBB']));
    const first = registry.allocate('room-1');
    expect(first).toBe('AAAAAA');
    registry.release(first);
    expect(registry.lookup(first)).toBeUndefined();
    expect(registry.allocate('room-2')).toBe('BBBBBB');
    expect(registry.lookup('AAAAAA')).toBeUndefined();
  });

  it('a code still open for another room is skipped too', () => {
    const registry = new RoomCodeRegistry(scripted(['AAAAAA', 'AAAAAA', 'CCCCCC']));
    expect(registry.allocate('room-1')).toBe('AAAAAA');
    expect(registry.allocate('room-2')).toBe('CCCCCC');
    expect(registry.lookup('AAAAAA')).toBe('room-1');
    expect(registry.lookup('CCCCCC')).toBe('room-2');
  });

  it('lookup is case-insensitive so a child may type lower-case', () => {
    const registry = new RoomCodeRegistry(createRng('case'));
    const code = registry.allocate('room-1');
    expect(registry.lookup(code.toLowerCase())).toBe('room-1');
  });
});

describe('JoinRateLimiter', () => {
  it('allows five attempts per minute per device, then refuses with a retry delay', () => {
    const clock = makeClock();
    const limiter = new JoinRateLimiter(clock.now);
    expect(JOIN_RATE_LIMIT).toEqual({ maxAttempts: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) expect(limiter.attempt('device-a')).toEqual({ allowed: true });
    const refused = limiter.attempt('device-a');
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(limiter.attempt('device-b')).toEqual({ allowed: true });
  });

  it('the window slides: after a minute the device may try again', () => {
    const clock = makeClock();
    const limiter = new JoinRateLimiter(clock.now);
    for (let i = 0; i < 5; i += 1) limiter.attempt('d');
    clock.advance(59_999);
    expect(limiter.attempt('d').allowed).toBe(false);
    clock.advance(2);
    expect(limiter.attempt('d').allowed).toBe(true);
  });

  it('reset clears the counter after a successful request', () => {
    const clock = makeClock();
    const limiter = new JoinRateLimiter(clock.now);
    for (let i = 0; i < 5; i += 1) limiter.attempt('d');
    limiter.reset('d');
    expect(limiter.attempt('d')).toEqual({ allowed: true });
  });
});
