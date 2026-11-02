// Long-lived server sessions (plan 1.5, 2.2): random token in an HttpOnly cookie, only its hash on the server,
// a sliding one-year expiry, and revocation of every session through the account's session generation.
import { createHash, randomBytes } from 'node:crypto';
import type { AccountRecord, Repositories, SessionRecord } from '../storage/repositories.js';

export const SESSION = {
  ttlMs: 365 * 24 * 60 * 60 * 1000,
  tokenBytes: 32,
  cookieName: 'oj_session',
} as const;

export interface IssuedSession {
  token: string;
  expiresAt: number;
}

export interface SessionServiceDeps {
  repos: Repositories;
  /** Current time in ms; injectable for tests. */
  clock: () => number;
  /** Random bytes source; injectable for tests. */
  randomBytes?: (size: number) => Uint8Array;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Told once per revokeAll: the account and its new generation (live connections must drop at once). */
export type SessionRevokeListener = (accountId: string, generation: number) => void;

export class SessionService {
  private readonly repos: Repositories;
  private readonly clock: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly revokeListeners = new Set<SessionRevokeListener>();

  constructor(deps: SessionServiceDeps) {
    this.repos = deps.repos;
    this.clock = deps.clock;
    this.randomBytes = deps.randomBytes ?? ((size) => randomBytes(size));
  }

  /** Create a session for the account under its current generation. */
  async issue(account: AccountRecord): Promise<IssuedSession> {
    const token = Buffer.from(this.randomBytes(SESSION.tokenBytes)).toString('base64url');
    const now = this.clock();
    const expiresAt = now + SESSION.ttlMs;
    await this.repos.sessions.insert({
      tokenHash: hashToken(token),
      accountId: account.id,
      generation: account.sessionGeneration,
      createdAt: now,
      expiresAt,
    });
    return { token, expiresAt };
  }

  /** The account for a token, or null when unknown, expired or revoked (generation mismatch). */
  async resolve(token: string): Promise<AccountRecord | null> {
    return (await this.lookup(token))?.account ?? null;
  }

  /** Slide the expiry forward on a visit; returns the new expiry or null when the token is not valid. */
  async refresh(token: string): Promise<number | null> {
    const found = await this.lookup(token);
    if (!found) return null;
    const expiresAt = this.clock() + SESSION.ttlMs;
    await this.repos.sessions.update({ ...found.session, expiresAt });
    return expiresAt;
  }

  /**
   * Invalidate every session of the account by bumping its generation (PIN reset, plan 2.2): one atomic
   * storage increment, so concurrent revocations and in-flight logins can never write an older generation back.
   */
  async revokeAll(accountId: string): Promise<void> {
    const generation = await this.repos.accounts.bumpSessionGeneration(accountId);
    if (generation === null) return;
    for (const listener of this.revokeListeners) listener(accountId, generation);
  }

  /** Subscribe to revocations (the live room closes that account's connections); returns the unsubscribe. */
  onRevoke(listener: SessionRevokeListener): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
    };
  }

  /** The live session and its account, or null when the token is unknown, expired or from an older generation. */
  private async lookup(token: string): Promise<{ session: SessionRecord; account: AccountRecord } | null> {
    if (token === '') return null;
    const session = await this.repos.sessions.getByTokenHash(hashToken(token));
    if (!session || session.expiresAt <= this.clock()) return null;
    const account = await this.repos.accounts.getById(session.accountId);
    if (!account || account.sessionGeneration !== session.generation) return null;
    return { session, account };
  }
}
