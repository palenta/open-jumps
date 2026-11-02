// Matrix rows 2 (server side) and 13: a year-long sliding session, only its hash stored, revoked by generation.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SESSION, SessionService } from '../src/auth/sessions.js';
import { createMemoryRepositories } from '../src/storage/memory.js';
import type { AccountRecord } from '../src/storage/repositories.js';
import { makeClock } from './helpers.js';

const account = (): AccountRecord => ({
  id: 'acc-1',
  riderName: 'María',
  riderNameKey: 'maria',
  riderGender: 'girl',
  ponyName: 'Dakota',
  ponyGender: 'yegua',
  ponyCategory: 'C',
  pinHash: 'scrypt$x$y',
  sessionGeneration: 1,
  failedLogins: 0,
  lockedUntil: null,
  clubId: null,
  createdAt: 0,
});

async function setup() {
  const repos = createMemoryRepositories();
  const clock = makeClock();
  await repos.accounts.create(account());
  const sessions = new SessionService({ repos, clock: clock.now });
  return { repos, clock, sessions };
}

describe('SessionService', () => {
  it('constants: one year, 32 random bytes, cookie name oj_session', () => {
    expect(SESSION.ttlMs).toBe(365 * 24 * 60 * 60 * 1000);
    expect(SESSION.tokenBytes).toBe(32);
    expect(SESSION.cookieName).toBe('oj_session');
  });

  it('issues a token that resolves to the account and expires a year later', async () => {
    const { clock, sessions } = await setup();
    const issued = await sessions.issue(account());
    expect(issued.expiresAt).toBe(clock.now() + SESSION.ttlMs);
    expect((await sessions.resolve(issued.token))?.id).toBe('acc-1');
  });

  it('tokens are long, random and unique', async () => {
    const { sessions } = await setup();
    const a = (await sessions.issue(account())).token;
    const b = (await sessions.issue(account())).token;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes in base64url
  });

  it('stores only the SHA-256 of the token, never the token', async () => {
    const { repos, sessions } = await setup();
    const { token } = await sessions.issue(account());
    const hash = createHash('sha256').update(token).digest('hex');
    expect(await repos.sessions.getByTokenHash(hash)).not.toBeNull();
    expect(await repos.sessions.getByTokenHash(token)).toBeNull();
  });

  it('an unknown or malformed token resolves to null', async () => {
    const { sessions } = await setup();
    expect(await sessions.resolve('nope')).toBeNull();
    expect(await sessions.resolve('')).toBeNull();
  });

  it('an expired token resolves to null', async () => {
    const { clock, sessions } = await setup();
    const { token } = await sessions.issue(account());
    clock.advance(SESSION.ttlMs + 1);
    expect(await sessions.resolve(token)).toBeNull();
  });

  it('refresh slides the expiry forward from now (a visit a month later keeps the kid signed in)', async () => {
    const { clock, sessions } = await setup();
    const { token } = await sessions.issue(account());
    clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(await sessions.refresh(token)).toBe(clock.now() + SESSION.ttlMs);
    clock.advance(SESSION.ttlMs - 1000);
    expect((await sessions.resolve(token))?.id).toBe('acc-1');
  });

  it('refresh of an invalid token returns null and creates nothing', async () => {
    const { sessions } = await setup();
    expect(await sessions.refresh('nope')).toBeNull();
  });

  it('revokeAll bumps the generation: every earlier token is dead, a new one works', async () => {
    const { repos, sessions } = await setup();
    const first = await sessions.issue(account());
    const second = await sessions.issue(account());
    await sessions.revokeAll('acc-1');
    expect(await sessions.resolve(first.token)).toBeNull();
    expect(await sessions.resolve(second.token)).toBeNull();
    const updated = (await repos.accounts.getById('acc-1'))!;
    expect(updated.sessionGeneration).toBe(2);
    const fresh = await sessions.issue(updated);
    expect((await sessions.resolve(fresh.token))?.id).toBe('acc-1');
  });

  it('revokeAll bumps the generation atomically (concurrent calls both count) and notifies listeners until unsubscribed', async () => {
    const { repos, sessions } = await setup();
    const seen: [string, number][] = [];
    const stop = sessions.onRevoke((accountId, generation) => seen.push([accountId, generation]));
    await Promise.all([sessions.revokeAll('acc-1'), sessions.revokeAll('acc-1')]);
    expect((await repos.accounts.getById('acc-1'))?.sessionGeneration).toBe(3);
    expect(seen.map(([id]) => id)).toEqual(['acc-1', 'acc-1']);
    expect(seen.map(([, generation]) => generation).sort()).toEqual([2, 3]);
    stop();
    await sessions.revokeAll('acc-1');
    await sessions.revokeAll('missing'); // unknown account: no throw, no notification
    expect(seen).toHaveLength(2);
    expect((await repos.accounts.getById('acc-1'))?.sessionGeneration).toBe(4);
  });
});
