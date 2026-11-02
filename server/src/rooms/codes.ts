// Room codes (plan 1.5 "Комната и допуск"): 6 unambiguous characters, unique while the room is open,
// never reused, and guessing is rate-limited per device.

export const ROOM_CODE = {
  length: 6,
  /** No I, L, O, 0 or 1: they are confused on a phone screen. */
  alphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
} as const;

export function generateRoomCode(rng: () => number, length: number = ROOM_CODE.length): string {
  const { alphabet } = ROOM_CODE;
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += alphabet.charAt(Math.floor(rng() * alphabet.length));
  }
  return code;
}

/** How many rng draws allocate() makes before giving up (31^6 codes exist; this never triggers in practice). */
const MAX_ALLOCATION_TRIES = 10_000;

/** Open codes map to room ids; a released code is retired for the life of the process. */
export class RoomCodeRegistry {
  private readonly open = new Map<string, string>();
  private readonly retired = new Set<string>();
  private readonly rng: () => number;

  constructor(rng: () => number) {
    this.rng = rng;
  }

  allocate(roomId: string): string {
    for (let i = 0; i < MAX_ALLOCATION_TRIES; i += 1) {
      const code = generateRoomCode(this.rng);
      if (this.open.has(code) || this.retired.has(code)) continue;
      this.open.set(code, roomId);
      return code;
    }
    throw new Error('RoomCodeRegistry: no free room code found');
  }

  lookup(code: string): string | undefined {
    return this.open.get(code.toUpperCase());
  }

  release(code: string): void {
    const key = code.toUpperCase();
    this.open.delete(key);
    this.retired.add(key);
  }
}

export const JOIN_RATE_LIMIT = { maxAttempts: 5, windowMs: 60 * 1000 } as const;

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Sliding-window limiter on join attempts per device key (plan 1.5: ограничение подбора кодов). */
export class JoinRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly clock: () => number;
  private readonly limits: { maxAttempts: number; windowMs: number };

  constructor(clock: () => number, limits?: { maxAttempts: number; windowMs: number }) {
    this.clock = clock;
    this.limits = limits ?? JOIN_RATE_LIMIT;
  }

  attempt(deviceKey: string): RateLimitDecision {
    const now = this.clock();
    const windowStart = now - this.limits.windowMs;
    const recent = (this.attempts.get(deviceKey) ?? []).filter((at) => at > windowStart);
    const oldest = recent[0];
    if (oldest !== undefined && recent.length >= this.limits.maxAttempts) {
      this.attempts.set(deviceKey, recent);
      return { allowed: false, retryAfterMs: oldest + this.limits.windowMs - now };
    }
    recent.push(now);
    this.attempts.set(deviceKey, recent);
    return { allowed: true };
  }

  /** A successful admission request clears the device's counter. */
  reset(deviceKey: string): void {
    this.attempts.delete(deviceKey);
  }
}
