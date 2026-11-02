// SQLite repositories on Node's built-in node:sqlite (no native dependency). Same contract as memory.ts.
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type {
  AccountRecord,
  ClubRecord,
  MembershipRecord,
  MembershipStatus,
  PonyGender,
  Repositories,
  RiderGender,
  SessionRecord,
} from './repositories.js';
import type { PonyCategory } from '@open-jumps/shared';

// The only PIN-related column is pin_hash: the PIN itself is never written anywhere (plan 2.3).
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    rider_name TEXT NOT NULL,
    rider_name_key TEXT NOT NULL UNIQUE,
    rider_gender TEXT NOT NULL,
    pony_name TEXT NOT NULL,
    pony_gender TEXT NOT NULL,
    pony_category TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    session_generation INTEGER NOT NULL,
    failed_logins INTEGER NOT NULL,
    locked_until INTEGER,
    club_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
  CREATE TABLE IF NOT EXISTS clubs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    admin_account_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    club_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    PRIMARY KEY (club_id, account_id)
  );
`;

type Row = Record<string, SQLOutputValue>;

const str = (row: Row, column: string): string => String(row[column]);
const num = (row: Row, column: string): number => Number(row[column]);
const numOrNull = (row: Row, column: string): number | null => (row[column] === null ? null : Number(row[column]));
const strOrNull = (row: Row, column: string): string | null => (row[column] === null ? null : String(row[column]));

const toAccount = (row: Row): AccountRecord => ({
  id: str(row, 'id'),
  riderName: str(row, 'rider_name'),
  riderNameKey: str(row, 'rider_name_key'),
  riderGender: str(row, 'rider_gender') as RiderGender,
  ponyName: str(row, 'pony_name'),
  ponyGender: str(row, 'pony_gender') as PonyGender,
  ponyCategory: str(row, 'pony_category') as PonyCategory,
  pinHash: str(row, 'pin_hash'),
  sessionGeneration: num(row, 'session_generation'),
  failedLogins: num(row, 'failed_logins'),
  lockedUntil: numOrNull(row, 'locked_until'),
  clubId: strOrNull(row, 'club_id'),
  createdAt: num(row, 'created_at'),
});

const toSession = (row: Row): SessionRecord => ({
  tokenHash: str(row, 'token_hash'),
  accountId: str(row, 'account_id'),
  generation: num(row, 'generation'),
  createdAt: num(row, 'created_at'),
  expiresAt: num(row, 'expires_at'),
});

const toClub = (row: Row): ClubRecord => ({
  id: str(row, 'id'),
  name: str(row, 'name'),
  nameKey: str(row, 'name_key'),
  code: str(row, 'code'),
  adminAccountId: str(row, 'admin_account_id'),
  createdAt: num(row, 'created_at'),
});

/** AccountRecord field → column, for field-level patches. */
const ACCOUNT_COLUMNS: Record<keyof Omit<AccountRecord, 'id'>, string> = {
  riderName: 'rider_name',
  riderNameKey: 'rider_name_key',
  riderGender: 'rider_gender',
  ponyName: 'pony_name',
  ponyGender: 'pony_gender',
  ponyCategory: 'pony_category',
  pinHash: 'pin_hash',
  sessionGeneration: 'session_generation',
  failedLogins: 'failed_logins',
  lockedUntil: 'locked_until',
  clubId: 'club_id',
  createdAt: 'created_at',
};

const toMembership = (row: Row): MembershipRecord => ({
  clubId: str(row, 'club_id'),
  accountId: str(row, 'account_id'),
  status: str(row, 'status') as MembershipStatus,
  requestedAt: num(row, 'requested_at'),
  confirmedAt: numOrNull(row, 'confirmed_at'),
});

/** Open (and migrate) the database at `path`; ':memory:' gives a private in-memory database. */
export function createSqliteRepositories(path: string): Repositories {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const one = <T>(sql: string, params: SQLOutputValue[], map: (row: Row) => T): T | null => {
    const row = db.prepare(sql).get(...params);
    return row === undefined ? null : map(row as Row);
  };
  const run = (sql: string, params: SQLOutputValue[]): number => Number(db.prepare(sql).run(...params).changes);

  return {
    accounts: {
      async create(a) {
        run(
          `INSERT INTO accounts (id, rider_name, rider_name_key, rider_gender, pony_name, pony_gender, pony_category,
             pin_hash, session_generation, failed_logins, locked_until, club_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [a.id, a.riderName, a.riderNameKey, a.riderGender, a.ponyName, a.ponyGender, a.ponyCategory,
            a.pinHash, a.sessionGeneration, a.failedLogins, a.lockedUntil, a.clubId, a.createdAt],
        );
      },
      async getById(id) {
        return one('SELECT * FROM accounts WHERE id = ?', [id], toAccount);
      },
      async getByNameKey(nameKey) {
        return one('SELECT * FROM accounts WHERE rider_name_key = ?', [nameKey], toAccount);
      },
      async update(a) {
        const changed = run(
          `UPDATE accounts SET rider_name = ?, rider_name_key = ?, rider_gender = ?, pony_name = ?, pony_gender = ?,
             pony_category = ?, pin_hash = ?, session_generation = ?, failed_logins = ?, locked_until = ?, club_id = ?,
             created_at = ?
           WHERE id = ?`,
          [a.riderName, a.riderNameKey, a.riderGender, a.ponyName, a.ponyGender, a.ponyCategory, a.pinHash,
            a.sessionGeneration, a.failedLogins, a.lockedUntil, a.clubId, a.createdAt, a.id],
        );
        if (changed === 0) throw new Error(`unknown account: ${a.id}`);
      },
      async patch(id, fields) {
        const assignments: string[] = [];
        const params: SQLOutputValue[] = [];
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined) continue;
          const column = ACCOUNT_COLUMNS[key as keyof typeof ACCOUNT_COLUMNS];
          if (!column) throw new Error(`unknown account field: ${key}`);
          assignments.push(`${column} = ?`);
          params.push(value as SQLOutputValue);
        }
        if (assignments.length === 0) {
          if (!one('SELECT id FROM accounts WHERE id = ?', [id], (row) => row)) throw new Error(`unknown account: ${id}`);
          return;
        }
        const changed = run(`UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`, [...params, id]);
        if (changed === 0) throw new Error(`unknown account: ${id}`);
      },
      async bumpSessionGeneration(id) {
        const row = db.prepare('UPDATE accounts SET session_generation = session_generation + 1 WHERE id = ? RETURNING session_generation').get(id);
        return row === undefined ? null : num(row as Row, 'session_generation');
      },
    },
    sessions: {
      async insert(s) {
        run(
          'INSERT INTO sessions (token_hash, account_id, generation, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
          [s.tokenHash, s.accountId, s.generation, s.createdAt, s.expiresAt],
        );
      },
      async getByTokenHash(tokenHash) {
        return one('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash], toSession);
      },
      async update(s) {
        const changed = run(
          'UPDATE sessions SET account_id = ?, generation = ?, created_at = ?, expires_at = ? WHERE token_hash = ?',
          [s.accountId, s.generation, s.createdAt, s.expiresAt, s.tokenHash],
        );
        if (changed === 0) throw new Error('unknown session');
      },
      async deleteExpired(now) {
        return run('DELETE FROM sessions WHERE expires_at <= ?', [now]);
      },
    },
    clubs: {
      async create(c) {
        run(
          'INSERT INTO clubs (id, name, name_key, code, admin_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [c.id, c.name, c.nameKey, c.code, c.adminAccountId, c.createdAt],
        );
      },
      async getById(id) {
        return one('SELECT * FROM clubs WHERE id = ?', [id], toClub);
      },
      async getByCode(code) {
        return one('SELECT * FROM clubs WHERE code = ?', [code], toClub);
      },
      async getByNameKey(nameKey) {
        return one('SELECT * FROM clubs WHERE name_key = ?', [nameKey], toClub);
      },
      async update(c) {
        const changed = run(
          'UPDATE clubs SET name = ?, name_key = ?, code = ?, admin_account_id = ?, created_at = ? WHERE id = ?',
          [c.name, c.nameKey, c.code, c.adminAccountId, c.createdAt, c.id],
        );
        if (changed === 0) throw new Error(`unknown club: ${c.id}`);
      },
      async upsertMembership(m) {
        run(
          `INSERT INTO memberships (club_id, account_id, status, requested_at, confirmed_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (club_id, account_id) DO UPDATE SET
             status = excluded.status, requested_at = excluded.requested_at, confirmed_at = excluded.confirmed_at`,
          [m.clubId, m.accountId, m.status, m.requestedAt, m.confirmedAt],
        );
      },
      async getMembership(clubId, accountId) {
        return one('SELECT * FROM memberships WHERE club_id = ? AND account_id = ?', [clubId, accountId], toMembership);
      },
      async deleteMembership(clubId, accountId) {
        run('DELETE FROM memberships WHERE club_id = ? AND account_id = ?', [clubId, accountId]);
      },
      async listMemberships(clubId, status?: MembershipStatus) {
        const rows = status === undefined
          ? db.prepare('SELECT * FROM memberships WHERE club_id = ? ORDER BY requested_at, account_id').all(clubId)
          : db.prepare('SELECT * FROM memberships WHERE club_id = ? AND status = ? ORDER BY requested_at, account_id').all(clubId, status);
        return rows.map((row) => toMembership(row as Row));
      },
    },
    async close() {
      db.close();
    },
  };
}
