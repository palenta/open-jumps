// Matrix rows 13 and 21: registration, unique names, lockout, admin PIN reset revoking sessions, owner-only edits.
import { describe, expect, it } from 'vitest';
import { PIN_RULES } from '../src/auth/pin.js';
import { createMemoryRepositories } from '../src/storage/memory.js';
import type { Repositories } from '../src/storage/repositories.js';
import { ADMIN_KEY, buildServices, registerRider } from './helpers.js';

describe('register', () => {
  it('creates the account, hashes the PIN and signs the rider in', async () => {
    const s = buildServices();
    const { account, token } = await registerRider(s, 'María', '1234', 'Dakota');
    expect(account.riderName).toBe('María');
    expect(account.ponyCategory).toBe('C');
    expect(account.pinHash).toMatch(/^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(account)).not.toContain('pin');
    expect((await s.sessions.resolve(token))?.id).toBe(account.id);
  });

  it('rider names are unique ignoring case and diacritics', async () => {
    const s = buildServices();
    await registerRider(s, 'María');
    const dup = await s.accounts.register({ riderName: 'maria', pin: '0000', riderGender: 'girl', ponyName: 'X', ponyGender: 'yegua' });
    expect(dup).toEqual({ ok: false, error: 'rider-name-taken' });
    const dup2 = await s.accounts.register({ riderName: 'MARIA', pin: '0000', riderGender: 'girl', ponyName: 'X', ponyGender: 'yegua' });
    expect(dup2).toEqual({ ok: false, error: 'rider-name-taken' });
  });

  it('refuses blocked or malformed names, a bad PIN and bad enumerations', async () => {
    const s = buildServices();
    const base = { pin: '1234', riderGender: 'girl' as const, ponyName: 'Dakota', ponyGender: 'yegua' as const };
    expect(await s.accounts.register({ ...base, riderName: 'puta' })).toEqual({ ok: false, error: 'rider-name-not-allowed' });
    expect(await s.accounts.register({ ...base, riderName: 'Mia', ponyName: 'mierda' })).toEqual({ ok: false, error: 'pony-name-not-allowed' });
    expect(await s.accounts.register({ ...base, riderName: 'Mia', pin: '12' })).toEqual({ ok: false, error: 'pin-format' });
    expect(await s.accounts.register({ ...base, riderName: 'Mia', riderGender: 'x' as never })).toEqual({ ok: false, error: 'rider-gender' });
    expect(await s.accounts.register({ ...base, riderName: 'Mia', ponyGender: 'mare' as never })).toEqual({ ok: false, error: 'pony-gender' });
    expect(await s.accounts.register({ ...base, riderName: 'Mia', ponyCategory: 'E' as never })).toEqual({ ok: false, error: 'pony-category' });
  });
});

describe('login', () => {
  it('name is matched case-insensitively; the PIN must match', async () => {
    const s = buildServices();
    await registerRider(s, 'María', '4321');
    const ok = await s.accounts.login('maría', '4321');
    expect(ok.ok).toBe(true);
    expect(await s.accounts.login('María', '0000')).toEqual({ ok: false, error: 'invalid-credentials' });
    expect(await s.accounts.login('Nadie', '4321')).toEqual({ ok: false, error: 'invalid-credentials' });
  });

  it('five wrong PINs lock the account for 15 minutes, even for the right PIN', async () => {
    const s = buildServices();
    await registerRider(s, 'María', '4321');
    for (let i = 0; i < PIN_RULES.maxFailedAttempts; i += 1) {
      expect(await s.accounts.login('María', '0000')).toEqual({ ok: false, error: 'invalid-credentials' });
    }
    expect(await s.accounts.login('María', '4321')).toEqual({ ok: false, error: 'locked' });
    s.clock.advance(PIN_RULES.lockoutMs - 1);
    expect(await s.accounts.login('María', '4321')).toEqual({ ok: false, error: 'locked' });
    s.clock.advance(1);
    expect((await s.accounts.login('María', '4321')).ok).toBe(true);
  });

  it('a successful login resets the failure counter', async () => {
    const s = buildServices();
    const { account } = await registerRider(s, 'María', '4321');
    await s.accounts.login('María', '0000');
    await s.accounts.login('María', '0000');
    await s.accounts.login('María', '4321');
    expect((await s.repos.accounts.getById(account.id))?.failedLogins).toBe(0);
  });

  it('a wrong PIN for an unknown name does not reveal whether the name exists', async () => {
    const s = buildServices();
    await registerRider(s, 'María', '4321');
    expect(await s.accounts.login('Nadie', '0000')).toEqual({ ok: false, error: 'invalid-credentials' });
    expect(await s.accounts.login('María', '0000')).toEqual({ ok: false, error: 'invalid-credentials' });
  });
});

describe('resetPin (admin key only)', () => {
  it('without the key → forbidden, nothing changes', async () => {
    const s = buildServices();
    const { account, token } = await registerRider(s, 'María', '4321');
    expect(await s.accounts.resetPin('wrong', account.id, '9999')).toEqual({ ok: false, error: 'forbidden' });
    expect(await s.accounts.resetPin('', account.id, '9999')).toEqual({ ok: false, error: 'forbidden' });
    expect((await s.sessions.resolve(token))?.id).toBe(account.id);
    expect((await s.accounts.login('María', '4321')).ok).toBe(true);
  });

  it('with the key: new PIN works, the lock is cleared and every old session is revoked', async () => {
    const s = buildServices();
    const { account, token } = await registerRider(s, 'María', '4321');
    for (let i = 0; i < PIN_RULES.maxFailedAttempts; i += 1) await s.accounts.login('María', '0000');
    expect(await s.accounts.resetPin(ADMIN_KEY, account.id, '9999')).toEqual({ ok: true, value: undefined });
    expect(await s.sessions.resolve(token)).toBeNull();
    expect((await s.accounts.login('María', '9999')).ok).toBe(true);
    expect(await s.accounts.login('María', '4321')).toEqual({ ok: false, error: 'invalid-credentials' });
  });

  it('validates the new PIN and the account', async () => {
    const s = buildServices();
    const { account } = await registerRider(s, 'María');
    expect(await s.accounts.resetPin(ADMIN_KEY, account.id, '12')).toEqual({ ok: false, error: 'pin-format' });
    expect(await s.accounts.resetPin(ADMIN_KEY, 'missing', '1234')).toEqual({ ok: false, error: 'not-found' });
  });
});

describe('updateProfile (owner only, row 21)', () => {
  it('another account cannot change my profile', async () => {
    const s = buildServices();
    const me = await registerRider(s, 'María');
    const other = await registerRider(s, 'Sofía');
    expect(await s.accounts.updateProfile(other.account.id, me.account.id, { ponyName: 'Hacked' })).toEqual({ ok: false, error: 'forbidden' });
    expect((await s.repos.accounts.getById(me.account.id))?.ponyName).toBe('Dakota');
  });

  it('the owner can rename within the filter and uniqueness', async () => {
    const s = buildServices();
    const me = await registerRider(s, 'María');
    await registerRider(s, 'Sofía');
    expect((await s.accounts.updateProfile(me.account.id, me.account.id, { ponyName: 'Buran', ponyCategory: 'B' })).ok).toBe(true);
    expect(await s.accounts.updateProfile(me.account.id, me.account.id, { riderName: 'sofia' })).toEqual({ ok: false, error: 'rider-name-taken' });
    expect(await s.accounts.updateProfile(me.account.id, me.account.id, { riderName: 'puta' })).toEqual({ ok: false, error: 'rider-name-not-allowed' });
    expect(await s.accounts.updateProfile(me.account.id, me.account.id, { ponyName: 'mierda' })).toEqual({ ok: false, error: 'pony-name-not-allowed' });
    expect(await s.accounts.updateProfile(me.account.id, 'missing', {})).toEqual({ ok: false, error: 'forbidden' });
  });

  it('the public profile never exposes the hash, generation, lock or counters', async () => {
    const s = buildServices();
    const { account } = await registerRider(s, 'María');
    const profile = await s.accounts.getPublicProfile(account.id);
    expect(profile).toEqual({
      id: account.id,
      riderName: 'María',
      riderGender: 'girl',
      ponyName: 'Dakota',
      ponyGender: 'yegua',
      ponyCategory: 'C',
      clubId: null,
    });
    expect(await s.accounts.getPublicProfile('missing')).toBeNull();
  });
});

/**
 * Memory repositories whose `accounts.getByNameKey` reads the record and then, once armed, parks on a
 * test-controlled gate before returning it: the caller holds a copy that may go stale while it waits.
 */
function gatedRepositories(): { repos: Repositories; arm: () => void; release: () => void } {
  const inner = createMemoryRepositories();
  let armed = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const repos: Repositories = {
    ...inner,
    accounts: {
      ...inner.accounts,
      async getByNameKey(nameKey) {
        const record = await inner.accounts.getByNameKey(nameKey);
        if (armed) {
          armed = false;
          await gate;
        }
        return record;
      },
    },
  };
  return {
    repos,
    arm: () => {
      armed = true;
    },
    release: () => release(),
  };
}

describe('login concurrency (audit P1: lockout bypass and stale whole-record writes)', () => {
  it('eight concurrent wrong PINs: exactly five are checked, the rest hit the lock', async () => {
    const s = buildServices();
    const { account } = await registerRider(s, 'María', '4321');
    const results = await Promise.all(Array.from({ length: 8 }, () => s.accounts.login('María', '0000')));
    const errors = results.map((r) => (r.ok ? 'ok' : r.error));
    expect(errors.filter((e) => e === 'invalid-credentials')).toHaveLength(PIN_RULES.maxFailedAttempts);
    expect(errors.filter((e) => e === 'locked')).toHaveLength(8 - PIN_RULES.maxFailedAttempts);
    const stored = await s.repos.accounts.getById(account.id);
    expect(stored?.lockedUntil).toBe(s.clock.now() + PIN_RULES.lockoutMs);
    expect(await s.accounts.login('María', '4321')).toEqual({ ok: false, error: 'locked' });
    s.clock.advance(PIN_RULES.lockoutMs);
    expect((await s.accounts.login('María', '4321')).ok).toBe(true);
  });

  it('three concurrent wrong PINs count as three failures, not one', async () => {
    const s = buildServices();
    const { account } = await registerRider(s, 'María', '4321');
    const results = await Promise.all(Array.from({ length: 3 }, () => s.accounts.login('María', '0000')));
    expect(results.every((r) => !r.ok && r.error === 'invalid-credentials')).toBe(true);
    expect((await s.repos.accounts.getById(account.id))?.failedLogins).toBe(3);
  });

  it('a login that finishes after resetPin cannot restore the old hash or resurrect revoked sessions', async () => {
    const gated = gatedRepositories();
    const s = buildServices(gated.repos);
    const { account, token } = await registerRider(s, 'María', '4321');

    gated.arm();
    const staleLogin = s.accounts.login('María', '4321'); // reads the record, then parks in the name lookup
    expect(await s.accounts.resetPin(ADMIN_KEY, account.id, '9999')).toEqual({ ok: true, value: undefined });
    gated.release();

    expect(await staleLogin).toEqual({ ok: false, error: 'invalid-credentials' });
    expect((await s.accounts.login('María', '9999')).ok).toBe(true);
    expect(await s.accounts.login('María', '4321')).toEqual({ ok: false, error: 'invalid-credentials' });
    expect(await s.sessions.resolve(token)).toBeNull();
    expect((await s.repos.accounts.getById(account.id))?.sessionGeneration).toBe(1);
  });

  it('a login running alongside updateProfile does not lose the profile change', async () => {
    const s = buildServices();
    const me = await registerRider(s, 'María', '4321');
    const [login, profile] = await Promise.all([
      s.accounts.login('María', '4321'),
      s.accounts.updateProfile(me.account.id, me.account.id, { ponyName: 'Buran' }),
    ]);
    expect(login.ok).toBe(true);
    expect(profile.ok).toBe(true);
    expect((await s.repos.accounts.getById(me.account.id))?.ponyName).toBe('Buran');
  });
});
