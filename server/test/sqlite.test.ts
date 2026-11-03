// Matrix rows 13, 21 (storage): both repository implementations satisfy one contract; SQLite persists across reopen.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createMemoryRepositories } from '../src/storage/memory.js';
import type { ResultRecord } from '../src/storage/repositories.js';
import { createSqliteRepositories } from '../src/storage/sqlite.js';
import { repositoryContract } from './repositoryContract.js';

repositoryContract('memory', async () => createMemoryRepositories());
repositoryContract('sqlite (in-memory database)', async () => createSqliteRepositories(':memory:'));

describe('sqlite on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-jumps-db-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps every account, session, club and membership field across close and reopen (plan 1.5)', async () => {
    const path = join(dir, 'open-jumps.sqlite');
    const first = createSqliteRepositories(path);
    const account = {
      id: 'acc-1',
      riderName: 'María',
      riderNameKey: 'maria',
      riderGender: 'girl' as const,
      ponyName: 'Dakota',
      ponyGender: 'yegua' as const,
      ponyCategory: 'C' as const,
      pinHash: 'scrypt$salt$hash',
      sessionGeneration: 3,
      failedLogins: 2,
      lockedUntil: 777_000,
      clubId: 'club-1',
      createdAt: 1000,
    };
    const session = { tokenHash: 'hash-1', accountId: 'acc-1', generation: 3, createdAt: 1000, expiresAt: 9000 };
    const club = { id: 'club-1', name: 'Open Sports Barcelona', nameKey: 'opensportsbarcelona', code: 'ABCDEFGH', adminAccountId: 'acc-1', createdAt: 1000 };
    const pending = { clubId: 'club-1', accountId: 'acc-2', status: 'pending' as const, requestedAt: 1200, confirmedAt: null };
    const member = { clubId: 'club-1', accountId: 'acc-1', status: 'member' as const, requestedAt: 1000, confirmedAt: 1000 };
    await first.accounts.create(account);
    await first.accounts.create({ ...account, id: 'acc-2', riderName: 'Sofía', riderNameKey: 'sofia', clubId: null });
    await first.sessions.insert(session);
    await first.clubs.create(club);
    await first.clubs.upsertMembership(member);
    await first.clubs.upsertMembership(pending);
    await first.close();

    const second = createSqliteRepositories(path);
    try {
      expect(await second.accounts.getById('acc-1')).toEqual(account);
      expect(await second.sessions.getByTokenHash('hash-1')).toEqual(session);
      expect(await second.clubs.getById('club-1')).toEqual(club);
      expect(await second.clubs.getByCode('ABCDEFGH')).toEqual(club);
      expect(await second.clubs.getMembership('club-1', 'acc-1')).toEqual(member);
      expect(await second.clubs.getMembership('club-1', 'acc-2')).toEqual(pending);
      expect((await second.clubs.listMemberships('club-1', 'pending')).map((m) => m.accountId)).toEqual(['acc-2']);
    } finally {
      await second.close();
    }
  });

  it('keeps a round result — its seed exactly — across close and reopen, and still refuses a second row for the same (round, rider), even under another seed (plans 2.3, 2.5)', async () => {
    const path = join(dir, 'results.sqlite');
    const first = createSqliteRepositories(path);
    const account = {
      id: 'acc-1',
      riderName: 'María',
      riderNameKey: 'maria',
      riderGender: 'girl' as const,
      ponyName: 'Dakota',
      ponyGender: 'yegua' as const,
      ponyCategory: 'C' as const,
      pinHash: 'scrypt$salt$hash',
      sessionGeneration: 1,
      failedLogins: 0,
      lockedUntil: null,
      clubId: null,
      createdAt: 1000,
    };
    const result: ResultRecord = {
      roundId: 'round-1',
      accountId: 'acc-1',
      courseId: 'course-1',
      courseVersion: 2,
      rulesVersion: 1,
      heightClass: 60,
      faults: 4,
      timeMs: 58_430,
      status: 'finished',
      eliminationReason: null,
      autopilot: false,
      schoolmaster: true,
      mode: 'ranked',
      // The round seed (plan 2.3) is part of the stored result; it must come back byte for byte.
      seed: 'round-1|5eed-0f-the-r0und',
      recordedAt: 1_700_000_123_456,
    };
    await first.accounts.create(account);
    expect(await first.results.insertOnce(result)).toBe(true);
    await first.close();

    const second = createSqliteRepositories(path);
    try {
      expect(await second.results.get('round-1', 'acc-1')).toEqual(result);
      expect((await second.results.get('round-1', 'acc-1'))?.seed).toBe('round-1|5eed-0f-the-r0und');
      expect(await second.results.listByRound('round-1')).toEqual([result]);
      expect(await second.results.listByAccount('acc-1')).toEqual([result]);
      // The uniqueness of (roundId, accountId) is a property of the stored data, not of one process's memory.
      expect(await second.results.insertOnce({ ...result, faults: 0, timeMs: 40_000, recordedAt: 1_700_000_999_999 })).toBe(false);
      expect(await second.results.get('round-1', 'acc-1')).toEqual(result);
      // A different seed does not make it a different result: the pair is the key, and the first seed stays.
      expect(await second.results.insertOnce({ ...result, seed: 'round-1|another-seed', recordedAt: 1_700_001_000_000 })).toBe(false);
      expect((await second.results.get('round-1', 'acc-1'))?.seed).toBe('round-1|5eed-0f-the-r0und');
      expect(await second.results.get('round-1', 'acc-1')).toEqual(result);
    } finally {
      await second.close();
    }
  });

  it('through reopened services, a token issued before a PIN reset stays dead', async () => {
    const path = join(dir, 'services.sqlite');
    const { buildServices, ADMIN_KEY } = await import('./helpers.js');
    const before = buildServices(createSqliteRepositories(path));
    const registered = await before.accounts.register({ riderName: 'María', pin: '1234', riderGender: 'girl', ponyName: 'Dakota', ponyGender: 'yegua' });
    if (!registered.ok) throw new Error(registered.error);
    const oldToken = registered.value.token;
    expect(await before.accounts.resetPin(ADMIN_KEY, registered.value.account.id, '9999')).toEqual({ ok: true, value: undefined });
    await before.repos.close();

    const after = buildServices(createSqliteRepositories(path));
    try {
      expect(await after.sessions.resolve(oldToken)).toBeNull();
      expect(await after.accounts.login('María', '1234')).toEqual({ ok: false, error: 'invalid-credentials' });
      expect((await after.accounts.login('María', '9999')).ok).toBe(true);
    } finally {
      await after.repos.close();
    }
  });

  it('never stores a PIN in clear: the only PIN column is the hash', async () => {
    const path = join(dir, 'schema.sqlite');
    const repos = createSqliteRepositories(path);
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path, { readOnly: true });
      const columns = db.prepare('PRAGMA table_info(accounts)').all().map((row) => String((row as { name: string }).name));
      expect(columns).toContain('pin_hash');
      expect(columns.filter((c) => c.includes('pin'))).toEqual(['pin_hash']);
      db.close();
    } finally {
      await repos.close();
    }
  });
});
