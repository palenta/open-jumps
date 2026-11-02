// Shared test fixtures for the server: a controllable clock, seeded randomness and a wired service set.
import { createRng } from '@open-jumps/shared';
import { AccountService } from '../src/auth/accounts.js';
import { SessionService } from '../src/auth/sessions.js';
import { ClubService } from '../src/clubs/clubs.js';
import { RoomDirectory } from '../src/http/rooms.js';
import { createMemoryRepositories } from '../src/storage/memory.js';
import type { Repositories } from '../src/storage/repositories.js';

export const ADMIN_KEY = 'test-admin-key-do-not-use-in-production';

export interface TestClock {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
}

export function makeClock(start = 1_700_000_000_000): TestClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

export interface Services {
  repos: Repositories;
  clock: TestClock;
  sessions: SessionService;
  accounts: AccountService;
  clubs: ClubService;
  rooms: RoomDirectory;
}

export function buildServices(repos: Repositories = createMemoryRepositories(), clock: TestClock = makeClock()): Services {
  const sessions = new SessionService({ repos, clock: clock.now });
  const accounts = new AccountService({ repos, sessions, clock: clock.now, adminKey: ADMIN_KEY });
  const clubs = new ClubService({ repos, clock: clock.now, rng: createRng('clubs') });
  const rooms = new RoomDirectory({ clock: clock.now, rng: createRng('rooms'), clubs, accounts });
  return { repos, clock, sessions, accounts, clubs, rooms };
}

/**
 * A rider name that is unique per call AND unique after normalizeName (digits are dropped or mapped by the
 * filter, so a numeric suffix would collide): the counter is spelled with letters only (a, b, …, z, ba, bb, …).
 */
let riderCounter = 0;
export function uniqueRiderName(prefix = 'Rider'): string {
  riderCounter += 1;
  let n = riderCounter;
  let suffix = '';
  while (n > 0) {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26);
  }
  return `${prefix}${suffix}`;
}

/** Register a rider with sane defaults; throws if registration fails (tests that expect failure call register directly). */
export async function registerRider(services: Services, riderName: string, pin = '1234', ponyName = 'Dakota') {
  const result = await services.accounts.register({
    riderName,
    pin,
    riderGender: 'girl',
    ponyName,
    ponyGender: 'yegua',
  });
  if (!result.ok) throw new Error(`registration failed: ${result.error}`);
  return result.value;
}
