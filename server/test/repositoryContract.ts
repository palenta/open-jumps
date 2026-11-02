// The contract every repository implementation must satisfy (memory and SQLite run the same suite).
import { describe, expect, it } from 'vitest';
import type { AccountRecord, ClubRecord, MembershipRecord, Repositories, SessionRecord } from '../src/storage/repositories.js';

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
  });
}
