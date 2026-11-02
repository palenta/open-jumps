// Room directory (plan 1.5): rooms by code with their admission state; the doorbell for HTTP and Colyseus.
import { randomUUID } from 'node:crypto';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import type { AccountService, PublicProfile } from '../auth/accounts.js';
import type { ClubService, ClubSummary } from '../clubs/clubs.js';
import { RoomAdmission } from '../rooms/admission.js';
import type { AdmissionError, JoinDecision, ParticipantStatus, Revocation } from '../rooms/admission.js';
import { JoinRateLimiter, RoomCodeRegistry } from '../rooms/codes.js';

export interface RoomEntry {
  id: string;
  code: string;
  admission: RoomAdmission;
  clubId: string | null;
  createdAt: number;
}

export interface RoomDirectoryDeps {
  clock: () => number;
  rng: () => number;
  clubs: Pick<ClubService, 'isConfirmedMember' | 'confirmedClubOf'>;
  accounts: Pick<AccountService, 'getPublicProfile'>;
  codes?: RoomCodeRegistry;
  limiter?: JoinRateLimiter;
  newId?: () => string;
}

export type HostAction =
  | { type: 'admit' | 'deny' | 'kick' | 'unblock'; accountId: string }
  | { type: 'entry'; open: boolean }
  | { type: 'auto-admit'; on: boolean };

export type RevokeListener = (roomId: string, revocation: Revocation) => void;

/** A person as the host sees them at the door: the public profile plus the club they are a CONFIRMED member of. */
export interface LobbyPerson extends PublicProfile {
  /** id and name only; null when the person has no confirmed membership (a pending request is not a club). */
  club: ClubSummary | null;
}

/** The host's view of the door: who is in, who is ringing, who was kicked. */
export interface LobbyView {
  code: string;
  hostId: string;
  entryOpen: boolean;
  autoAdmitClub: boolean;
  clubId: string | null;
  participants: LobbyPerson[];
  pending: LobbyPerson[];
  kicked: LobbyPerson[];
}

export class RoomDirectory {
  private readonly clock: () => number;
  private readonly clubs: RoomDirectoryDeps['clubs'];
  private readonly accounts: RoomDirectoryDeps['accounts'];
  private readonly codes: RoomCodeRegistry;
  private readonly limiter: JoinRateLimiter;
  private readonly newId: () => string;
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly revokeListeners = new Set<RevokeListener>();

  constructor(deps: RoomDirectoryDeps) {
    this.clock = deps.clock;
    this.clubs = deps.clubs;
    this.accounts = deps.accounts;
    this.codes = deps.codes ?? new RoomCodeRegistry(deps.rng);
    this.limiter = deps.limiter ?? new JoinRateLimiter(deps.clock);
    this.newId = deps.newId ?? randomUUID;
  }

  /** The room's club is the host's club (null when the host has none); auto-admit is off unless asked. */
  createRoom(hostId: string, options: { clubId: string | null; autoAdmitClub?: boolean }): RoomEntry {
    const id = this.newId();
    const entry: RoomEntry = {
      id,
      code: this.codes.allocate(id),
      admission: new RoomAdmission({ hostId, clubId: options.clubId, autoAdmitClub: options.autoAdmitClub ?? false }),
      clubId: options.clubId,
      createdAt: this.clock(),
    };
    this.rooms.set(id, entry);
    return entry;
  }

  getByCode(code: string): RoomEntry | undefined {
    const id = this.codes.lookup(code);
    return id === undefined ? undefined : this.rooms.get(id);
  }

  getById(roomId: string): RoomEntry | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * The doorbell. The rate limit is keyed by the authenticated account (never by anything the client sends),
   * so changing a body field cannot reset it. Club membership is asked from the club service for the room's club.
   */
  async requestJoin(code: string, accountId: string): Promise<Result<JoinDecision, 'unknown-code' | 'rate-limited'>> {
    const gate = this.gate(code, accountId);
    if (!gate.ok) return gate;
    const { room } = gate.value;
    const confirmedClubMember = room.clubId !== null && (await this.clubs.isConfirmedMember(room.clubId, accountId));
    return ok(room.admission.requestJoin(accountId, { confirmedClubMember }));
  }

  /** An account with no relation to the room sees 'unknown-code' (and spends a guess), never 'none'. */
  statusOf(code: string, accountId: string): ParticipantStatus | 'unknown-code' | 'rate-limited' {
    const gate = this.gate(code, accountId);
    if (!gate.ok) return gate.error;
    return gate.value.related ? gate.value.room.admission.statusOf(accountId) : 'unknown-code';
  }

  /** Host only: the lists the host needs to decide (pending with names, kicked for unblocking). */
  async lobbyView(code: string, actorId: string): Promise<Result<LobbyView, 'unknown-code' | 'forbidden' | 'rate-limited'>> {
    const gate = this.gate(code, actorId);
    if (!gate.ok) return gate;
    if (!gate.value.related) return err('unknown-code');
    const { room } = gate.value;
    if (room.admission.hostId !== actorId) return err('forbidden');
    return ok({
      code: room.code,
      hostId: room.admission.hostId,
      entryOpen: room.admission.entryOpen,
      autoAdmitClub: room.admission.autoAdmitClub,
      clubId: room.clubId,
      participants: await this.people(room.admission.participants),
      pending: await this.people(room.admission.pending),
      kicked: await this.people(room.admission.kicked),
    });
  }

  /** Host decisions; a kick also notifies revoke listeners so the live room drops the client. */
  hostAction(code: string, actorId: string, action: HostAction): Result<void, AdmissionError | 'unknown-code' | 'rate-limited'> {
    const gate = this.gate(code, actorId);
    if (!gate.ok) return gate;
    if (!gate.value.related) return err('unknown-code');
    const { room } = gate.value;
    const { admission } = room;
    switch (action.type) {
      case 'admit':
        return admission.admit(actorId, action.accountId);
      case 'deny':
        return admission.deny(actorId, action.accountId);
      case 'unblock':
        return admission.unblock(actorId, action.accountId);
      case 'entry':
        return admission.setEntryOpen(actorId, action.open);
      case 'auto-admit':
        return admission.setAutoAdmitClub(actorId, action.on);
      case 'kick': {
        const kicked = admission.kick(actorId, action.accountId);
        if (!kicked.ok) return kicked;
        for (const listener of this.revokeListeners) listener(room.id, kicked.value);
        return ok(undefined);
      }
    }
  }

  /** A participant left for good; an empty room closes and its code is retired (never resolves again). */
  leave(code: string, accountId: string): void {
    const room = this.getByCode(code);
    if (!room) return;
    room.admission.leave(accountId);
    if (room.admission.participants.length === 0) {
      this.rooms.delete(room.id);
      this.codes.release(room.code);
    }
  }

  onRevoke(listener: RevokeListener): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
    };
  }

  /**
   * Every route that takes a code passes here. An account the room already knows (host, admitted, pending, kicked)
   * is related and free of charge; anyone else is guessing — whether the code exists or not — and spends one of
   * the account's attempts (plan 1.5: a code must not be discoverable through status, lobby or host routes either).
   * The budget is never refilled by a hit: only the sliding window clears it.
   */
  private gate(code: string, accountId: string): Result<{ room: RoomEntry; related: boolean }, 'unknown-code' | 'rate-limited'> {
    const room = this.getByCode(code);
    if (room && room.admission.statusOf(accountId) !== 'none') return ok({ room, related: true });
    if (!this.limiter.attempt(accountId).allowed) return err('rate-limited');
    return room ? ok({ room, related: false }) : err('unknown-code');
  }

  private async people(ids: readonly string[]): Promise<LobbyPerson[]> {
    const people: LobbyPerson[] = [];
    for (const id of ids) {
      const profile = await this.accounts.getPublicProfile(id);
      if (!profile) continue;
      people.push({ ...profile, club: await this.clubs.confirmedClubOf(id) });
    }
    return people;
  }
}
