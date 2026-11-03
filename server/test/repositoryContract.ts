// The contract every repository implementation must satisfy (memory and SQLite run the same suite).
import { describe, expect, it } from 'vitest';
import type { AccountRecord, ClubRecord, MembershipRecord, Repositories, ResultRecord, SessionRecord } from '../src/storage/repositories.js';

const account = (over: Partial<AccountRecord> = {}): AccountRecord => ({
  id: 'acc-1',
  riderName: 'María',
  riderNameKey: 'maria',
  riderGender: 'girl',
  ponyName: 'Dakota',
  ponyGender: 'yegua',
  ponyCategory: 'C',
  pinHash: 'scrypt$salt$hash',
  sessionGeneration: 1,
  failedLogins: 0,
  lockedUntil: null,
  clubId: null,
  createdAt: 1000,
  ...over,
});

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  tokenHash: 'hash-1',
  accountId: 'acc-1',
  generation: 1,
  createdAt: 1000,
  expiresAt: 2000,
  ...over,
});

const club = (over: Partial<ClubRecord> = {}): ClubRecord => ({
  id: 'club-1',
  name: 'Open Sports Barcelona',
  nameKey: 'opensportsbarcelona',
  code: 'ABCDEFGH',
  adminAccountId: 'acc-1',
  createdAt: 1000,
  ...over,
});

const membership = (over: Partial<MembershipRecord> = {}): MembershipRecord => ({
  clubId: 'club-1',
  accountId: 'acc-2',
  status: 'pending',
  requestedAt: 1000,
  confirmedAt: null,
  ...over,
});

const result = (over: Partial<ResultRecord> = {}): ResultRecord => ({
  roundId: 'round-1',
  accountId: 'acc-1',
  courseId: 'course-1',
  courseVersion: 1,
  rulesVersion: 1,
  heightClass: 70,
  faults: 4,
  timeMs: 61_250,
  status: 'finished',
  eliminationReason: null,
  autopilot: false,
  schoolmaster: false,
  mode: 'ranked',
  // The round seed (plan 2.3): stored with the result so its chance outcomes stay reproducible.
  seed: 'round-1|a3f9c2e1',
  recordedAt: 1000,
  ...over,
});

export function repositoryContract(name: string, open: () => Promise<Repositories>): void {
  describe(`${name} repositories`, () => {
    it('accounts: create, get by id and by name key, update; duplicate name key is refused', async () => {
      const repos = await open();
      try {
        await repos.accounts.create(account());
        expect(await repos.accounts.getById('acc-1')).toEqual(account());
        expect(await repos.accounts.getByNameKey('maria')).toEqual(account());
        expect(await repos.accounts.getById('nope')).toBeNull();
        await expect(repos.accounts.create(account({ id: 'acc-9', riderName: 'MARIA' }))).rejects.toThrow();
        await repos.accounts.update(account({ failedLogins: 3, lockedUntil: 5000, sessionGeneration: 2, clubId: 'club-1' }));
        expect(await repos.accounts.getById('acc-1')).toMatchObject({ failedLogins: 3, lockedUntil: 5000, sessionGeneration: 2, clubId: 'club-1' });
      } finally {
        await repos.close();
      }
    });

    it('accounts: patch writes only the given fields; bumpSessionGeneration increments atomically (no lost update)', async () => {
      const repos = await open();
      try {
        await repos.accounts.create(account());
        await repos.accounts.patch('acc-1', { failedLogins: 4, lockedUntil: 7000 });
        expect(await repos.accounts.getById('acc-1')).toEqual(account({ failedLogins: 4, lockedUntil: 7000 }));
        await repos.accounts.patch('acc-1', { clubId: 'club-1' });
        expect(await repos.accounts.getById('acc-1')).toEqual(account({ failedLogins: 4, lockedUntil: 7000, clubId: 'club-1' }));
        await repos.accounts.patch('acc-1', {});
        expect(await repos.accounts.getById('acc-1')).toEqual(account({ failedLogins: 4, lockedUntil: 7000, clubId: 'club-1' }));
        await expect(repos.accounts.patch('nope', { failedLogins: 1 })).rejects.toThrow();
        // Ten concurrent bumps never lose an increment: each call is one atomic storage operation.
        const results = await Promise.all(Array.from({ length: 10 }, () => repos.accounts.bumpSessionGeneration('acc-1')));
        expect([...results].sort((a, b) => Number(a) - Number(b))).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        expect((await repos.accounts.getById('acc-1'))?.sessionGeneration).toBe(11);
        expect(await repos.accounts.bumpSessionGeneration('nope')).toBeNull();
      } finally {
        await repos.close();
      }
    });

    it('sessions: insert, get by token hash, update expiry, delete expired', async () => {
      const repos = await open();
      try {
        await repos.accounts.create(account());
        await repos.sessions.insert(session());
        await repos.sessions.insert(session({ tokenHash: 'hash-2', expiresAt: 9000 }));
        expect(await repos.sessions.getByTokenHash('hash-1')).toEqual(session());
        expect(await repos.sessions.getByTokenHash('missing')).toBeNull();
        await repos.sessions.update(session({ expiresAt: 3000 }));
        expect((await repos.sessions.getByTokenHash('hash-1'))?.expiresAt).toBe(3000);
        expect(await repos.sessions.deleteExpired(3000)).toBe(1);
        expect(await repos.sessions.getByTokenHash('hash-1')).toBeNull();
        expect(await repos.sessions.getByTokenHash('hash-2')).not.toBeNull();
      } finally {
        await repos.close();
      }
    });

    it('clubs: create, get by id, code and name key, update admin, memberships upsert/get/list/delete', async () => {
      const repos = await open();
      try {
        await repos.accounts.create(account());
        await repos.accounts.create(account({ id: 'acc-2', riderName: 'Sofía', riderNameKey: 'sofia' }));
        await repos.clubs.create(club());
        expect(await repos.clubs.getById('club-1')).toEqual(club());
        expect(await repos.clubs.getByCode('ABCDEFGH')).toEqual(club());
        expect(await repos.clubs.getByNameKey('opensportsbarcelona')).toEqual(club());
        await expect(repos.clubs.create(club({ id: 'club-2', code: 'ZZZZZZZZ' }))).rejects.toThrow();
        await repos.clubs.update(club({ adminAccountId: 'acc-2' }));
        expect((await repos.clubs.getById('club-1'))?.adminAccountId).toBe('acc-2');
        await repos.clubs.upsertMembership(membership());
        expect(await repos.clubs.getMembership('club-1', 'acc-2')).toEqual(membership());
        await repos.clubs.upsertMembership(membership({ status: 'member', confirmedAt: 1500 }));
        expect(await repos.clubs.getMembership('club-1', 'acc-2')).toMatchObject({ status: 'member', confirmedAt: 1500 });
        expect(await repos.clubs.listMemberships('club-1', 'member')).toHaveLength(1);
        expect(await repos.clubs.listMemberships('club-1', 'pending')).toHaveLength(0);
        await repos.clubs.deleteMembership('club-1', 'acc-2');
        expect(await repos.clubs.getMembership('club-1', 'acc-2')).toBeNull();
      } finally {
        await repos.close();
      }
    });

    // Results (plan 2.5): one row per (roundId, accountId), never a second one — the first write wins.
    it('results: insertOnce stores the first row per (roundId, accountId) and refuses a second one even with different fields; get returns every field, the seed exactly', async () => {
      const repos = await open();
      try {
        await repos.accounts.create(account());
        await repos.accounts.create(account({ id: 'acc-2', riderName: 'Sofía', riderNameKey: 'sofia' }));
        expect(await repos.results.insertOnce(result())).toBe(true);
        expect(await repos.results.get('round-1', 'acc-1')).toEqual(result());
        expect((await repos.results.get('round-1', 'acc-1'))?.seed).toBe('round-1|a3f9c2e1');
        // A retry with other numbers (a late duplicate from the room) is refused and leaves the first row untouched.
        expect(await repos.results.insertOnce(result({ faults: 0, timeMs: 50_000, recordedAt: 2000 }))).toBe(false);
        expect(await repos.results.get('round-1', 'acc-1')).toEqual(result());
        // A retry under a different seed is still the same (round, rider) pair: refused, and the first seed stays (plan 2.3).
        expect(await repos.results.insertOnce(result({ seed: 'round-1|ffffffff', faults: 0, recordedAt: 3000 }))).toBe(false);
        expect(await repos.results.get('round-1', 'acc-1')).toEqual(result());
        expect((await repos.results.get('round-1', 'acc-1'))?.seed).toBe('round-1|a3f9c2e1');
        // The key is the pair: the same rider in another round, and another rider in the same round, both insert —
        // each row keeps its own seed.
        expect(await repos.results.insertOnce(result({ roundId: 'round-2', seed: 'round-2|0badf00d', recordedAt: 2000 }))).toBe(true);
        expect(await repos.results.insertOnce(result({ accountId: 'acc-2', recordedAt: 2000 }))).toBe(true);
        expect((await repos.results.get('round-2', 'acc-1'))?.seed).toBe('round-2|0badf00d');
        expect((await repos.results.get('round-1', 'acc-2'))?.seed).toBe('round-1|a3f9c2e1');
        expect(await repos.results.get('round-1', 'nope')).toBeNull();
        expect(await repos.results.get('nope', 'acc-1')).toBeNull();
      } finally {
        await repos.close();
      }
    });

    it('results: an eliminated rider (disconnected, autopilot, schoolmaster, training) round-trips with timeMs null', async () => {
      const repos = await open();
      try {
        await repos.accounts.create(account());
        const eliminated = result({
          heightClass: 50,
          faults: 8,
          timeMs: null,
          status: 'eliminated',
          eliminationReason: 'disconnected',
          autopilot: true,
          schoolmaster: true,
          mode: 'training',
          seed: 'round-1|training-7e3',
        });
        expect(await repos.results.insertOnce(eliminated)).toBe(true);
        expect(await repos.results.get('round-1', 'acc-1')).toEqual(eliminated);
        expect(await repos.results.listByRound('round-1')).toEqual([eliminated]);
        expect(await repos.results.listByAccount('acc-1')).toEqual([eliminated]);
      } finally {
        await repos.close();
      }
    });

    it('results: listByRound returns only that round; listByAccount returns only that rider, newest first by recordedAt', async () => {
      const repos = await open();
      try {
        await repos.accounts.create(account());
        await repos.accounts.create(account({ id: 'acc-2', riderName: 'Sofía', riderNameKey: 'sofia' }));
        // Inserted out of time order on purpose: the order must come from recordedAt, not from insertion.
        await repos.results.insertOnce(result({ roundId: 'round-1', accountId: 'acc-1', recordedAt: 3000 }));
        await repos.results.insertOnce(result({ roundId: 'round-2', accountId: 'acc-1', recordedAt: 1000 }));
        await repos.results.insertOnce(result({ roundId: 'round-1', accountId: 'acc-2', recordedAt: 1500, faults: 0 }));
        await repos.results.insertOnce(result({ roundId: 'round-3', accountId: 'acc-1', recordedAt: 2000 }));

        const round1 = (await repos.results.listByRound('round-1')).sort((x, y) => x.accountId.localeCompare(y.accountId));
        expect(round1).toEqual([
          result({ roundId: 'round-1', accountId: 'acc-1', recordedAt: 3000 }),
          result({ roundId: 'round-1', accountId: 'acc-2', recordedAt: 1500, faults: 0 }),
        ]);
        expect(await repos.results.listByRound('round-2')).toEqual([result({ roundId: 'round-2', accountId: 'acc-1', recordedAt: 1000 })]);
        expect(await repos.results.listByRound('round-none')).toEqual([]);

        expect((await repos.results.listByAccount('acc-1')).map((r) => [r.roundId, r.recordedAt])).toEqual([
          ['round-1', 3000],
          ['round-3', 2000],
          ['round-2', 1000],
        ]);
        expect(await repos.results.listByAccount('acc-2')).toEqual([result({ roundId: 'round-1', accountId: 'acc-2', recordedAt: 1500, faults: 0 })]);
        expect(await repos.results.listByAccount('nope')).toEqual([]);
      } finally {
        await repos.close();
      }
    });
  });
}
