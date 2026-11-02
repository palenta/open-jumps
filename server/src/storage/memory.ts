// In-memory repositories: the reference implementation used by tests and by the repository contract.
import type {
  AccountRecord,
  ClubRecord,
  MembershipRecord,
  MembershipStatus,
  Repositories,
  SessionRecord,
} from './repositories.js';

const membershipKey = (clubId: string, accountId: string): string => `${clubId}\u0000${accountId}`;

/** Records are copied on the way in and out so callers never share state with the store. */
const copy = <T extends object>(record: T | undefined): T | null => (record ? { ...record } : null);

export function createMemoryRepositories(): Repositories {
  const accounts = new Map<string, AccountRecord>();
  const sessions = new Map<string, SessionRecord>();
  const clubs = new Map<string, ClubRecord>();
  const memberships = new Map<string, MembershipRecord>();

  const findAccountByNameKey = (nameKey: string): AccountRecord | undefined =>
    [...accounts.values()].find((a) => a.riderNameKey === nameKey);
  const findClub = (predicate: (club: ClubRecord) => boolean): ClubRecord | undefined =>
    [...clubs.values()].find(predicate);

  return {
    accounts: {
      async create(record) {
        if (accounts.has(record.id)) throw new Error(`account id already exists: ${record.id}`);
        if (findAccountByNameKey(record.riderNameKey)) throw new Error(`rider name already taken: ${record.riderNameKey}`);
        accounts.set(record.id, { ...record });
      },
      async getById(id) {
        return copy(accounts.get(id));
      },
      async getByNameKey(nameKey) {
        return copy(findAccountByNameKey(nameKey));
      },
      async update(record) {
        if (!accounts.has(record.id)) throw new Error(`unknown account: ${record.id}`);
        accounts.set(record.id, { ...record });
      },
      async patch(id, fields) {
        const current = accounts.get(id);
        if (!current) throw new Error(`unknown account: ${id}`);
        const next: AccountRecord = { ...current };
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined && key !== 'id') (next as unknown as Record<string, unknown>)[key] = value;
        }
        accounts.set(id, next);
      },
      async bumpSessionGeneration(id) {
        const current = accounts.get(id);
        if (!current) return null;
        current.sessionGeneration += 1; // the stored object itself: one synchronous step, nothing can interleave
        return current.sessionGeneration;
      },
    },
    sessions: {
      async insert(record) {
        if (sessions.has(record.tokenHash)) throw new Error('session token hash already exists');
        sessions.set(record.tokenHash, { ...record });
      },
      async getByTokenHash(tokenHash) {
        return copy(sessions.get(tokenHash));
      },
      async update(record) {
        if (!sessions.has(record.tokenHash)) throw new Error('unknown session');
        sessions.set(record.tokenHash, { ...record });
      },
      async deleteExpired(now) {
        let deleted = 0;
        for (const [tokenHash, session] of sessions) {
          if (session.expiresAt <= now) {
            sessions.delete(tokenHash);
            deleted += 1;
          }
        }
        return deleted;
      },
    },
    clubs: {
      async create(record) {
        if (clubs.has(record.id)) throw new Error(`club id already exists: ${record.id}`);
        if (findClub((c) => c.nameKey === record.nameKey)) throw new Error(`club name already taken: ${record.nameKey}`);
        if (findClub((c) => c.code === record.code)) throw new Error(`club code already taken: ${record.code}`);
        clubs.set(record.id, { ...record });
      },
      async getById(id) {
        return copy(clubs.get(id));
      },
      async getByCode(code) {
        return copy(findClub((c) => c.code === code));
      },
      async getByNameKey(nameKey) {
        return copy(findClub((c) => c.nameKey === nameKey));
      },
      async update(record) {
        if (!clubs.has(record.id)) throw new Error(`unknown club: ${record.id}`);
        clubs.set(record.id, { ...record });
      },
      async upsertMembership(record) {
        memberships.set(membershipKey(record.clubId, record.accountId), { ...record });
      },
      async getMembership(clubId, accountId) {
        return copy(memberships.get(membershipKey(clubId, accountId)));
      },
      async deleteMembership(clubId, accountId) {
        memberships.delete(membershipKey(clubId, accountId));
      },
      async listMemberships(clubId, status?: MembershipStatus) {
        return [...memberships.values()]
          .filter((m) => m.clubId === clubId && (status === undefined || m.status === status))
          .sort((a, b) => a.requestedAt - b.requestedAt || a.accountId.localeCompare(b.accountId))
          .map((m) => ({ ...m }));
      },
    },
    async close() {
      // Nothing to release.
    },
  };
}
