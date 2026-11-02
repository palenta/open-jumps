// Accounts and profiles (plan 1.5, 2.3): rider name + PIN, unique names, owner-only edits, admin PIN reset.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { PonyCategory } from '@open-jumps/shared';
import { KeyedLock } from '../concurrency/keyedLock.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { checkName, normalizeName } from '../names/filter.js';
import type { AccountRecord, PonyGender, Repositories, RiderGender } from '../storage/repositories.js';
import { PIN_RULES, hashPin, validatePin, verifyPin } from './pin.js';
import type { SessionService } from './sessions.js';

export interface RegisterInput {
  riderName: string;
  pin: string;
  riderGender: RiderGender;
  ponyName: string;
  ponyGender: PonyGender;
  /** Optional at start (plan 1.5); defaults to 'C'. */
  ponyCategory?: PonyCategory;
}

export type RegisterError =
  | 'rider-name-not-allowed'
  | 'rider-name-taken'
  | 'pony-name-not-allowed'
  | 'pin-format'
  | 'rider-gender'
  | 'pony-gender'
  | 'pony-category';

export type LoginError = 'invalid-credentials' | 'locked';

export interface ProfilePatch {
  riderName?: string;
  ponyName?: string;
  ponyGender?: PonyGender;
  ponyCategory?: PonyCategory;
}

export type ProfileError = 'forbidden' | 'not-found' | 'rider-name-not-allowed' | 'rider-name-taken' | 'pony-name-not-allowed' | 'pony-gender' | 'pony-category';

export type ResetPinError = 'forbidden' | 'not-found' | 'pin-format';

/** What anyone may see about an account: never the hash, generation, lock state or club requests. */
export interface PublicProfile {
  id: string;
  riderName: string;
  riderGender: RiderGender;
  ponyName: string;
  ponyGender: PonyGender;
  ponyCategory: PonyCategory;
  clubId: string | null;
}

export interface AccountServiceDeps {
  repos: Repositories;
  sessions: SessionService;
  clock: () => number;
  /** The owner's admin key (from the environment, never in code); compared in constant time. */
  adminKey: string;
  newId?: () => string;
}

const RIDER_GENDERS: readonly RiderGender[] = ['girl', 'boy'];
const PONY_GENDERS: readonly PonyGender[] = ['yegua', 'macho'];
const PONY_CATEGORIES: readonly PonyCategory[] = ['A', 'B', 'C', 'D'];

function isRiderGender(value: unknown): value is RiderGender {
  return RIDER_GENDERS.includes(value as RiderGender);
}

function isPonyGender(value: unknown): value is PonyGender {
  return PONY_GENDERS.includes(value as PonyGender);
}

function isPonyCategory(value: unknown): value is PonyCategory {
  return PONY_CATEGORIES.includes(value as PonyCategory);
}

/** Constant-time string equality (length leaks only whether the lengths match, which an attacker can learn anyway). */
function secretsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function isLocked(account: AccountRecord, now: number): boolean {
  return account.lockedUntil !== null && now < account.lockedUntil;
}

/** The fields one operation may write; `patch` leaves every other column to the service that owns it. */
type AccountFields = Partial<Omit<AccountRecord, 'id'>>;

export class AccountService {
  private readonly repos: Repositories;
  private readonly sessions: SessionService;
  private readonly clock: () => number;
  private readonly adminKey: string;
  private readonly newId: () => string;
  /**
   * Per-account mutex: every mutating step (login counters, PIN reset, profile edits) runs inside it, so a
   * slow `verifyPin` or `hashPin` can never interleave with another write to the same account at an `await`.
   */
  private readonly accountLocks = new KeyedLock();

  constructor(deps: AccountServiceDeps) {
    this.repos = deps.repos;
    this.sessions = deps.sessions;
    this.clock = deps.clock;
    this.adminKey = deps.adminKey;
    this.newId = deps.newId ?? randomUUID;
  }

  /** Run `work` after every earlier call for the same account has finished, holding the lock until it settles. */
  private withAccountLock<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    return this.accountLocks.run(accountId, work);
  }

  /** Create the account and sign the new rider in. */
  async register(input: RegisterInput): Promise<Result<{ account: AccountRecord; token: string }, RegisterError>> {
    const rider = checkName(input.riderName, 'rider');
    if (!rider.ok) return err('rider-name-not-allowed');
    if (await this.repos.accounts.getByNameKey(rider.key)) return err('rider-name-taken');
    const pony = checkName(input.ponyName, 'pony');
    if (!pony.ok) return err('pony-name-not-allowed');
    if (!validatePin(input.pin).ok) return err('pin-format');
    if (!isRiderGender(input.riderGender)) return err('rider-gender');
    if (!isPonyGender(input.ponyGender)) return err('pony-gender');
    const ponyCategory = input.ponyCategory ?? 'C';
    if (!isPonyCategory(ponyCategory)) return err('pony-category');

    const account: AccountRecord = {
      id: this.newId(),
      riderName: rider.display,
      riderNameKey: rider.key,
      riderGender: input.riderGender,
      ponyName: pony.display,
      ponyGender: input.ponyGender,
      ponyCategory,
      pinHash: await hashPin(input.pin),
      sessionGeneration: 0,
      failedLogins: 0,
      lockedUntil: null,
      clubId: null,
      createdAt: this.clock(),
    };
    await this.repos.accounts.create(account);
    const session = await this.sessions.issue(account);
    return ok({ account, token: session.token });
  }

  /**
   * Name (case-insensitive) + PIN; five failures lock the account for 15 minutes, even for the right PIN.
   * The name lookup runs outside the account lock (it only yields the id and may be stale); everything that
   * reads the lock state, verifies the PIN or writes counters runs inside it against a fresh copy, so
   * concurrent attempts are counted one by one and a login can never outlive a PIN reset.
   */
  async login(riderName: string, pin: string): Promise<Result<{ account: AccountRecord; token: string }, LoginError>> {
    const found = await this.repos.accounts.getByNameKey(normalizeName(riderName));
    if (!found) return err('invalid-credentials');

    return this.withAccountLock(found.id, async () => {
      const account = await this.repos.accounts.getById(found.id);
      if (!account) return err('invalid-credentials');
      const now = this.clock();
      if (isLocked(account, now)) return err('locked');

      if (!(await verifyPin(pin, account.pinHash))) {
        const failedLogins = account.failedLogins + 1;
        const locked = failedLogins >= PIN_RULES.maxFailedAttempts;
        await this.repos.accounts.patch(account.id, {
          failedLogins: locked ? 0 : failedLogins,
          lockedUntil: locked ? now + PIN_RULES.lockoutMs : account.lockedUntil,
        });
        return err('invalid-credentials');
      }

      // Re-read after the slow verify: the session must carry the generation and lock state as they are now
      // (a revocation from outside this service may have landed while scrypt ran).
      const fresh = await this.repos.accounts.getById(account.id);
      if (!fresh) return err('invalid-credentials');
      if (isLocked(fresh, this.clock())) return err('locked');
      await this.repos.accounts.patch(fresh.id, { failedLogins: 0, lockedUntil: null });
      const signedIn: AccountRecord = { ...fresh, failedLogins: 0, lockedUntil: null };
      const session = await this.sessions.issue(signedIn);
      return ok({ account: signedIn, token: session.token });
    });
  }

  /** Only the owner edits their own profile; names pass the filter and uniqueness. Writes only the changed fields. */
  async updateProfile(actorId: string, accountId: string, patch: ProfilePatch): Promise<Result<AccountRecord, ProfileError>> {
    if (actorId !== accountId) return err('forbidden');

    return this.withAccountLock(accountId, async () => {
      const account = await this.repos.accounts.getById(accountId);
      if (!account) return err('not-found');
      const fields: AccountFields = {};

      if (patch.riderName !== undefined) {
        const rider = checkName(patch.riderName, 'rider');
        if (!rider.ok) return err('rider-name-not-allowed');
        const existing = await this.repos.accounts.getByNameKey(rider.key);
        if (existing && existing.id !== account.id) return err('rider-name-taken');
        fields.riderName = rider.display;
        fields.riderNameKey = rider.key;
      }
      if (patch.ponyName !== undefined) {
        const pony = checkName(patch.ponyName, 'pony');
        if (!pony.ok) return err('pony-name-not-allowed');
        fields.ponyName = pony.display;
      }
      if (patch.ponyGender !== undefined) {
        if (!isPonyGender(patch.ponyGender)) return err('pony-gender');
        fields.ponyGender = patch.ponyGender;
      }
      if (patch.ponyCategory !== undefined) {
        if (!isPonyCategory(patch.ponyCategory)) return err('pony-category');
        fields.ponyCategory = patch.ponyCategory;
      }

      if (Object.keys(fields).length > 0) await this.repos.accounts.patch(accountId, fields);
      const updated: AccountRecord = { ...account, ...fields };
      return ok(updated);
    });
  }

  /** Admin key only: set a new PIN, clear the lock, revoke every session of the account. */
  async resetPin(providedAdminKey: string, accountId: string, newPin: string): Promise<Result<void, ResetPinError>> {
    if (!secretsEqual(providedAdminKey, this.adminKey)) return err('forbidden');
    if (!validatePin(newPin).ok) return err('pin-format');

    return this.withAccountLock(accountId, async () => {
      if (!(await this.repos.accounts.getById(accountId))) return err('not-found');
      // Only the PIN-owned fields; the generation is bumped atomically by revokeAll, never written from a copy.
      await this.repos.accounts.patch(accountId, { pinHash: await hashPin(newPin), failedLogins: 0, lockedUntil: null });
      await this.sessions.revokeAll(accountId);
      return ok(undefined);
    });
  }

  async getPublicProfile(accountId: string): Promise<PublicProfile | null> {
    const account = await this.repos.accounts.getById(accountId);
    if (!account) return null;
    return {
      id: account.id,
      riderName: account.riderName,
      riderGender: account.riderGender,
      ponyName: account.ponyName,
      ponyGender: account.ponyGender,
      ponyCategory: account.ponyCategory,
      clubId: account.clubId,
    };
  }
}
