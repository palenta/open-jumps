// Clubs (plan 1.5 "Клуб и членство"): the club code only creates a request; the club admin confirms members.
import { randomUUID } from 'node:crypto';
import { KeyedLock } from '../concurrency/keyedLock.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { checkName } from '../names/filter.js';
import type { ClubRecord, MembershipRecord, Repositories } from '../storage/repositories.js';

export const CLUB_CODE = { length: 8, alphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' } as const;

export type CreateClubError = 'name-not-allowed' | 'name-taken' | 'in-another-club';
export type JoinClubError = 'unknown-code' | 'already-member' | 'already-pending' | 'in-another-club';
export type ClubAdminError = 'forbidden' | 'no-request' | 'not-member' | 'cannot-remove-admin' | 'unknown-club' | 'in-another-club';

export interface ClubSummary {
  id: string;
  name: string;
}

/** What a confirmed member sees about their own club; the invitation code only for the admin. */
export interface ClubOverview {
  id: string;
  name: string;
  role: 'admin' | 'member';
  code: string | null;
  memberIds: string[];
  pendingCount: number;
}

export interface ClubServiceDeps {
  repos: Repositories;
  clock: () => number;
  rng: () => number;
  newId?: () => string;
}

export class ClubService {
  private readonly repos: Repositories;
  private readonly clock: () => number;
  private readonly rng: () => number;
  private readonly newId: () => string;
  /**
   * Two levels of mutex, always taken in the order club → rider (never the reverse, so no deadlock):
   * - clubLocks (by club id): every administrative change of a club — confirm, reject, remove, transfer — reads
   *   the current admin, checks the rule and writes inside it, so "remove B" and "make B admin" can never both
   *   succeed, and two transfers can never both win.
   * - riderLocks (by account id): every change of a rider's membership (create, request, confirm, reject, remove)
   *   checks "one club per rider" and writes inside it, so two confirmations, or a creation and a confirmation,
   *   that run at the same time can never both pass the check.
   */
  private readonly clubLocks = new KeyedLock();
  private readonly riderLocks = new KeyedLock();

  constructor(deps: ClubServiceDeps) {
    this.repos = deps.repos;
    this.clock = deps.clock;
    this.rng = deps.rng;
    this.newId = deps.newId ?? randomUUID;
  }

  /** The creator becomes the club's admin and its first confirmed member. */
  async createClub(adminAccountId: string, name: string): Promise<Result<ClubRecord, CreateClubError>> {
    const checked = checkName(name, 'club');
    if (!checked.ok) return err('name-not-allowed');
    if (await this.repos.clubs.getByNameKey(checked.key)) return err('name-taken');
    return this.riderLocks.run(adminAccountId, async () => {
      if (await this.confirmedClubOf(adminAccountId)) return err('in-another-club');
      const now = this.clock();
      const club: ClubRecord = {
        id: this.newId(),
        name: checked.display,
        nameKey: checked.key,
        code: await this.freshCode(),
        adminAccountId,
        createdAt: now,
      };
      await this.repos.clubs.create(club);
      await this.repos.clubs.upsertMembership({ clubId: club.id, accountId: adminAccountId, status: 'member', requestedAt: now, confirmedAt: now });
      await this.setAccountClub(adminAccountId, club.id);
      return ok(club);
    });
  }

  /** Entering the code creates a pending request, nothing more. */
  async requestJoin(accountId: string, clubCode: string): Promise<Result<MembershipRecord, JoinClubError>> {
    const club = await this.repos.clubs.getByCode(clubCode.trim().toUpperCase());
    if (!club) return err('unknown-code');
    return this.riderLocks.run(accountId, async () => {
      const existing = await this.repos.clubs.getMembership(club.id, accountId);
      if (existing?.status === 'member') return err('already-member');
      if (existing?.status === 'pending') return err('already-pending');
      if (await this.confirmedClubOf(accountId)) return err('in-another-club');
      const request: MembershipRecord = { clubId: club.id, accountId, status: 'pending', requestedAt: this.clock(), confirmedAt: null };
      await this.repos.clubs.upsertMembership(request);
      return ok(request);
    });
  }

  /** Admin only. */
  confirm(actorId: string, clubId: string, accountId: string): Promise<Result<MembershipRecord, ClubAdminError>> {
    return this.asAdminOf(clubId, actorId, async () =>
      this.riderLocks.run(accountId, async () => {
        const request = await this.repos.clubs.getMembership(clubId, accountId);
        if (request?.status !== 'pending') return err('no-request');
        // One club per rider: a request confirmed elsewhere (even a moment ago) stays pending here; the admin may reject it.
        if (await this.confirmedClubOf(accountId)) return err('in-another-club');
        const member: MembershipRecord = { ...request, status: 'member', confirmedAt: this.clock() };
        await this.repos.clubs.upsertMembership(member);
        await this.setAccountClub(accountId, clubId);
        return ok(member);
      }),
    );
  }

  /** Admin only: drop a pending request. */
  reject(actorId: string, clubId: string, accountId: string): Promise<Result<void, ClubAdminError>> {
    return this.asAdminOf(clubId, actorId, async () =>
      this.riderLocks.run(accountId, async () => {
        const request = await this.repos.clubs.getMembership(clubId, accountId);
        if (request?.status !== 'pending') return err('no-request');
        await this.repos.clubs.deleteMembership(clubId, accountId);
        return ok(undefined);
      }),
    );
  }

  /** Admin only; the admin cannot remove themselves (transfer first). */
  removeMember(actorId: string, clubId: string, accountId: string): Promise<Result<void, ClubAdminError>> {
    return this.asAdminOf(clubId, actorId, async (club) => {
      if (accountId === club.adminAccountId) return err('cannot-remove-admin');
      return this.riderLocks.run(accountId, async () => {
        const membership = await this.repos.clubs.getMembership(clubId, accountId);
        if (membership?.status !== 'member') return err('not-member');
        await this.repos.clubs.deleteMembership(clubId, accountId);
        await this.setAccountClub(accountId, null, clubId);
        return ok(undefined);
      });
    });
  }

  /** Admin only; the new admin must already be a confirmed member (checked and changed under the club lock). */
  transferAdmin(actorId: string, clubId: string, newAdminId: string): Promise<Result<ClubRecord, ClubAdminError>> {
    return this.asAdminOf(clubId, actorId, async (current) => {
      if (!(await this.isConfirmedMember(clubId, newAdminId))) return err('not-member');
      const club: ClubRecord = { ...current, adminAccountId: newAdminId };
      await this.repos.clubs.update(club);
      return ok(club);
    });
  }

  async isConfirmedMember(clubId: string, accountId: string): Promise<boolean> {
    const membership = await this.repos.clubs.getMembership(clubId, accountId);
    return membership?.status === 'member';
  }

  /** What anyone may see about a club: id and name only (never the code or the admin). */
  async getClubSummary(clubId: string): Promise<ClubSummary | null> {
    const club = await this.repos.clubs.getById(clubId);
    return club ? { id: club.id, name: club.name } : null;
  }

  /** The summary of the club the account is a CONFIRMED member of, or null. */
  async confirmedClubOf(accountId: string): Promise<ClubSummary | null> {
    const account = await this.repos.accounts.getById(accountId);
    if (!account?.clubId) return null;
    if (!(await this.isConfirmedMember(account.clubId, accountId))) return null;
    return this.getClubSummary(account.clubId);
  }

  async listPending(actorId: string, clubId: string): Promise<Result<MembershipRecord[], ClubAdminError>> {
    const admin = await this.asAdmin(actorId, clubId);
    if (!admin.ok) return admin;
    return ok(await this.repos.clubs.listMemberships(clubId, 'pending'));
  }

  /** The actor's own club (confirmed membership only): role, members, pending count, and the code for the admin. */
  async overview(actorId: string): Promise<Result<ClubOverview, 'no-club'>> {
    const summary = await this.confirmedClubOf(actorId);
    const club = summary ? await this.repos.clubs.getById(summary.id) : null;
    if (!club) return err('no-club');
    const role = club.adminAccountId === actorId ? 'admin' : 'member';
    return ok({
      id: club.id,
      name: club.name,
      role,
      code: role === 'admin' ? club.code : null,
      memberIds: (await this.repos.clubs.listMemberships(club.id, 'member')).map((m) => m.accountId),
      pendingCount: (await this.repos.clubs.listMemberships(club.id, 'pending')).length,
    });
  }

  /** The club when it exists and the actor is its admin; otherwise the matching error. */
  private async asAdmin(actorId: string, clubId: string): Promise<Result<ClubRecord, 'unknown-club' | 'forbidden'>> {
    const club = await this.repos.clubs.getById(clubId);
    if (!club) return err('unknown-club');
    if (club.adminAccountId !== actorId) return err('forbidden');
    return ok(club);
  }

  /**
   * Run an administrative change under the club lock: the admin check reads the club as it is at that moment,
   * and no other administrative change of the same club can interleave until `work` has settled.
   */
  private asAdminOf<T>(
    clubId: string,
    actorId: string,
    work: (club: ClubRecord) => Promise<Result<T, ClubAdminError>>,
  ): Promise<Result<T, ClubAdminError>> {
    return this.clubLocks.run(clubId, async () => {
      const admin = await this.asAdmin(actorId, clubId);
      if (!admin.ok) return admin;
      return work(admin.value);
    });
  }

  /**
   * Mirror membership on the account (plan 1.5: one club per rider) with a field-level patch, so this never
   * overwrites fields other services own; `onlyIf` guards against clearing another club.
   */
  private async setAccountClub(accountId: string, clubId: string | null, onlyIf?: string): Promise<void> {
    const account = await this.repos.accounts.getById(accountId);
    if (!account) return;
    if (onlyIf !== undefined && account.clubId !== onlyIf) return;
    await this.repos.accounts.patch(accountId, { clubId });
  }

  private async freshCode(): Promise<string> {
    for (;;) {
      let code = '';
      for (let i = 0; i < CLUB_CODE.length; i += 1) {
        code += CLUB_CODE.alphabet[Math.floor(this.rng() * CLUB_CODE.alphabet.length) % CLUB_CODE.alphabet.length];
      }
      if (!(await this.repos.clubs.getByCode(code))) return code;
    }
  }
}
