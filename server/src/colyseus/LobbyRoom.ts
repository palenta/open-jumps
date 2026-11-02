// The live room (plan 2.5а): only accounts admitted to THIS room may connect (instance onAuth checks the room
// it belongs to, not a code chosen by the client); the session comes from the HttpOnly cookie of the
// matchmaking request (or options.sessionToken for non-browser clients); the matchmaking request must carry
// an allowed Origin; admission is re-checked at onJoin so a kick between reservation and connection still
// refuses; a kick disconnects the client at once. A session revocation (PIN reset, logout) closes every live
// connection of that account at once and refuses a connection whose reservation predates the revocation
// (audit finding B). Emotes relay only ids of the closed shared list (finding A). Round simulation comes in B2.
import { CloseCode, Room, type AuthContext, type Client } from 'colyseus';
import { schema, t, type SchemaType } from '@colyseus/schema';
import type { AccountService } from '../auth/accounts.js';
import { parseCookies } from '../auth/cookies.js';
import { SESSION, type SessionService } from '../auth/sessions.js';
import { isAllowedOrigin } from '../http/origin.js';
import type { RoomDirectory, RoomEntry } from '../http/rooms.js';
import { ROOM_CAPACITY } from '../rooms/admission.js';
import { authorizeRoomMessage, validateRoomMessage } from '../rooms/authz.js';

export interface LobbyRoomDeps {
  sessions: SessionService;
  accounts: AccountService;
  rooms: RoomDirectory;
  allowedOrigins: readonly string[];
}

/** Options a client passes when connecting: the room code and, for non-browser clients, the session token. */
export interface LobbyJoinOptions {
  code: string;
  sessionToken?: string;
}

/** What onAuth hands to onJoin. */
export interface LobbyAuth {
  accountId: string;
}

/** Why a connection was refused (the message of the thrown Error starts with this code). */
export type LobbyRefusal = 'bad-origin' | 'no-session' | 'not-admitted';

/** WebSocket close code a kicked client receives (4000–4999 are application codes). */
export const KICKED_CLOSE_CODE = 4100;
/** WebSocket close code a client receives when its account's sessions were revoked (PIN reset, logout). */
export const SESSION_REVOKED_CLOSE_CODE = 4101;

// Schemas use the @colyseus/schema 5 builder (schema() + t.*): the legacy defineTypes() path relies on
// `useDefineForClassFields: false`, and with ES2022 class fields the map never received its child type.

/** What every participant sees about another participant: public profile fields only. */
export const LobbyParticipant = schema(
  {
    accountId: t.string().default(''),
    riderName: t.string().default(''),
    ponyName: t.string().default(''),
    isHost: t.boolean().default(false),
  },
  'LobbyParticipant',
);
export type LobbyParticipant = SchemaType<typeof LobbyParticipant>;

/** Room state: no pending or kicked names here (host-only lists live in the HTTP lobby view), only a count. */
export const LobbyState = schema(
  {
    code: t.string().default(''),
    hostId: t.string().default(''),
    entryOpen: t.boolean().default(true),
    pendingCount: t.number().default(0),
    participants: t.map(LobbyParticipant),
  },
  'LobbyState',
);
export type LobbyState = SchemaType<typeof LobbyState>;

export const LOBBY_ROOM_NAME = 'lobby';

interface Names {
  riderName: string;
  ponyName: string;
}

export class LobbyRoom extends Room<{ state: LobbyState }> {
  /** Injected once at app start (tests inject their own services). */
  static deps: LobbyRoomDeps | null = null;

  static configure(deps: LobbyRoomDeps): void {
    LobbyRoom.deps = deps;
  }

  private roomCode = '';
  private entryId = '';
  /** Account per connected session (set at onJoin). */
  private readonly accountBySession = new Map<string, string>();
  /** Names learnt at onAuth so onJoin can publish the participant synchronously. */
  private readonly names = new Map<string, Names>();
  /**
   * Session generation seen at onAuth per client session, consumed at onJoin: a revocation that lands between
   * the two bumps the account's generation past it, and the connection is refused. (A reservation that never
   * connects leaves its number here until dispose; the room lives for one class, so it stays tiny.)
   */
  private readonly generationBySession = new Map<string, number>();
  /** Latest revoked generation per account, from the session service (the generation AFTER the bump). */
  private readonly revokedGeneration = new Map<string, number>();
  private unsubscribeRevoke: (() => void) | null = null;
  private unsubscribeSessionRevoke: (() => void) | null = null;

  /** The code of the room this instance serves (set in onCreate; never taken from a joining client). */
  get code(): string {
    return this.roomCode;
  }

  override onCreate(options: { code: string }): void {
    const entry = this.deps().rooms.getByCode(options.code);
    if (!entry) throw new Error(`unknown-code: no room is open with code ${options.code}`);
    this.roomCode = entry.code;
    this.entryId = entry.id;
    this.maxClients = ROOM_CAPACITY;
    // The live room lives as long as the directory entry (the host may not have connected yet, and a refused
    // stranger must not dispose it); it closes when the last participant leaves for good (see closeIfGone).
    this.autoDispose = false;

    const state = new LobbyState();
    state.code = entry.code;
    state.hostId = entry.admission.hostId;
    state.entryOpen = entry.admission.entryOpen;
    this.state = state;

    this.onMessage('room', (client: Client, payload: unknown) => this.handleRoomMessage(client, payload));

    // A kick decided over HTTP or in the room: cut the connection now (voice revocation arrives with LiveKit, phase 3).
    this.unsubscribeRevoke = this.deps().rooms.onRevoke((roomId, revocation) => {
      if (roomId !== this.entryId) return;
      for (const client of this.clients) {
        if (this.accountBySession.get(client.sessionId) === revocation.accountId) client.leave(KICKED_CLOSE_CODE);
      }
    });

    // A session revocation (PIN reset, logout): every live connection of that account is forgotten and closed at
    // once, so it can neither send a command nor receive another patch; the generation is remembered so a
    // connection whose onAuth predates the revocation is refused at onJoin. Admission is untouched: after a new
    // sign-in the same account may come back.
    this.unsubscribeSessionRevoke = this.deps().sessions.onRevoke((accountId, generation) => {
      const known = this.revokedGeneration.get(accountId);
      if (known === undefined || generation > known) this.revokedGeneration.set(accountId, generation);
      for (const client of this.clients) {
        if (this.accountBySession.get(client.sessionId) !== accountId) continue;
        this.forgetSession(client.sessionId);
        client.leave(SESSION_REVOKED_CLOSE_CODE);
      }
      this.syncDoor();
    });
  }

  /**
   * Matchmaking-time check for THIS room: allowed Origin on the request, a valid session (cookie first,
   * then options.sessionToken) and admission to this room's code. Throws Error(<LobbyRefusal>) otherwise.
   */
  override async onAuth(client: Client, options: LobbyJoinOptions, context: AuthContext): Promise<LobbyAuth> {
    const deps = this.deps();
    if (!isAllowedOrigin(context.headers.get('origin') ?? undefined, deps.allowedOrigins)) {
      throw new Error('bad-origin: the request did not come from the game site');
    }
    const token = parseCookies(context.headers.get('cookie') ?? undefined)[SESSION.cookieName] ?? options?.sessionToken;
    const account = token ? await deps.sessions.resolve(token) : null;
    if (!account) throw new Error('no-session: sign in first');
    if (!this.isAdmitted(account.id)) throw new Error('not-admitted: the host has not let this account in');
    this.names.set(account.id, { riderName: account.riderName, ponyName: account.ponyName });
    this.generationBySession.set(client.sessionId, account.sessionGeneration);
    return { accountId: account.id };
  }

  /**
   * Re-checks the session (a revocation may have landed since onAuth) and admission (a kick may have), then
   * publishes the participant. Synchronous on purpose: the refusal must throw before the client is seated.
   */
  override onJoin(client: Client, _options?: LobbyJoinOptions, auth?: LobbyAuth): void {
    const accountId = auth?.accountId;
    const seenGeneration = this.generationBySession.get(client.sessionId);
    this.generationBySession.delete(client.sessionId);
    if (!accountId) throw new Error('not-admitted: admission was withdrawn before the connection');
    const revokedGeneration = this.revokedGeneration.get(accountId);
    if (seenGeneration !== undefined && revokedGeneration !== undefined && revokedGeneration > seenGeneration) {
      throw new Error('no-session: the session was revoked before the connection');
    }
    if (!this.isAdmitted(accountId)) throw new Error('not-admitted: admission was withdrawn before the connection');
    this.accountBySession.set(client.sessionId, accountId);
    if (!this.state.participants.has(accountId)) {
      const names = this.names.get(accountId);
      const participant = new LobbyParticipant();
      participant.accountId = accountId;
      participant.riderName = names?.riderName ?? '';
      participant.ponyName = names?.ponyName ?? '';
      this.state.participants.set(accountId, participant);
    }
    this.syncDoor();
  }

  override onLeave(client: Client, code?: number): void {
    const gone = this.forgetSession(client.sessionId);
    // A session already forgotten (revoked) has nothing left to do here.
    if (!gone) return;
    // Only a deliberate leave gives the seat up; a dropped connection keeps the admission (B2 adds reconnection).
    if (gone.lastConnection && code === CloseCode.CONSENTED) this.deps().rooms.leave(this.roomCode, gone.accountId);
    this.syncDoor();
    this.closeIfGone();
  }

  /** Decisions taken over HTTP (admit, deny, close the door…) reach the state before every patch. */
  override onBeforePatch(): void {
    this.syncDoor();
    this.closeIfGone();
  }

  override onDispose(): void {
    this.unsubscribeRevoke?.();
    this.unsubscribeRevoke = null;
    this.unsubscribeSessionRevoke?.();
    this.unsubscribeSessionRevoke = null;
  }

  /**
   * Forget a client session: drop its account mapping (so no further message of it is heard) and, when it was
   * the account's last connection, its participant. Returns null when the session was unknown or already
   * forgotten, so a later onLeave for the same socket is a no-op.
   */
  private forgetSession(sessionId: string): { accountId: string; lastConnection: boolean } | null {
    this.generationBySession.delete(sessionId);
    const accountId = this.accountBySession.get(sessionId);
    if (!accountId) return null;
    this.accountBySession.delete(sessionId);
    const lastConnection = ![...this.accountBySession.values()].includes(accountId);
    if (lastConnection) this.state.participants.delete(accountId);
    return { accountId, lastConnection };
  }

  private deps(): LobbyRoomDeps {
    if (!LobbyRoom.deps) throw new Error('LobbyRoom.configure() was not called');
    return LobbyRoom.deps;
  }

  private entry(): RoomEntry | undefined {
    return this.deps().rooms.getById(this.entryId);
  }

  private isAdmitted(accountId: string): boolean {
    return this.entry()?.admission.canAccessState(accountId) ?? false;
  }

  private closing = false;

  /** The directory closed the room (last participant gone): disconnect everyone and dispose this instance. */
  private closeIfGone(): void {
    if (this.closing || this.entry()) return;
    this.closing = true;
    void this.disconnect();
  }

  private handleRoomMessage(client: Client, payload: unknown): void {
    const actorId = this.accountBySession.get(client.sessionId);
    const entry = this.entry();
    if (!actorId || !entry) return;
    const parsed = validateRoomMessage(payload);
    if (!parsed.ok) return;
    const allowed = authorizeRoomMessage(entry.admission, actorId, parsed.value);
    if (!allowed.ok) {
      client.send('refused', { error: allowed.error });
      return;
    }
    const message = parsed.value;
    const rooms = this.deps().rooms;
    switch (message.type) {
      case 'admit':
      case 'deny':
      case 'kick':
      case 'unblock': {
        const result = rooms.hostAction(this.roomCode, actorId, { type: message.type, accountId: message.accountId });
        if (!result.ok) client.send('refused', { error: result.error });
        break;
      }
      case 'set-entry': {
        const result = rooms.hostAction(this.roomCode, actorId, { type: 'entry', open: message.open });
        if (!result.ok) client.send('refused', { error: result.error });
        break;
      }
      case 'set-auto-admit': {
        const result = rooms.hostAction(this.roomCode, actorId, { type: 'auto-admit', on: message.on });
        if (!result.ok) client.send('refused', { error: result.error });
        break;
      }
      case 'start-class':
        // The class itself (heats, rounds, judging on the server) is part B2.
        client.send('refused', { error: 'not-available' });
        break;
      case 'emote':
        this.broadcast('emote', { from: actorId, emote: message.emote });
        break;
    }
    this.syncDoor();
  }

  /** Mirror the door (host, entry, pending count, host flags) into the state without touching names of those waiting. */
  private syncDoor(): void {
    const entry = this.entry();
    if (!entry) return;
    const { admission } = entry;
    if (this.state.hostId !== admission.hostId) this.state.hostId = admission.hostId;
    if (this.state.entryOpen !== admission.entryOpen) this.state.entryOpen = admission.entryOpen;
    if (this.state.pendingCount !== admission.pending.length) this.state.pendingCount = admission.pending.length;
    this.state.participants.forEach((participant, accountId) => {
      const isHost = accountId === admission.hostId;
      if (participant.isHost !== isHost) participant.isHost = isHost;
    });
  }
}
