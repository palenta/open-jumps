// The live room (plan 2.5а): only accounts admitted to THIS room may connect (instance onAuth checks the room
// it belongs to, not a code chosen by the client); the session comes from the HttpOnly cookie of the
// matchmaking request (or options.sessionToken for non-browser clients); the matchmaking request must carry
// an allowed Origin; admission is re-checked at onJoin so a kick between reservation and connection still
// refuses; a kick disconnects the client at once. A session revocation (PIN reset, logout) closes every live
// connection of that account at once and refuses a connection whose reservation predates the revocation
// (audit finding B). Emotes relay only ids of the closed shared list (finding A). Part B2 adds the class
// (see CLASS_PROTOCOL below): course walk, heats, the authoritative round, reconnection with autopilot.
import { CloseCode, Room, type AuthContext, type Client } from 'colyseus';
import { schema, t, type SchemaType } from '@colyseus/schema';
import { allowedHeightClasses, clubCourse, type AssistSettings, type CourseSpec, type HeightClass, type PonyCategory } from '@open-jumps/shared';
import type { AccountService } from '../auth/accounts.js';
import type { ResultRecord, ResultRepository } from '../storage/repositories.js';
import { parseCookies } from '../auth/cookies.js';
import { SESSION, type SessionService } from '../auth/sessions.js';
import { isAllowedOrigin } from '../http/origin.js';
import type { RoomDirectory, RoomEntry } from '../http/rooms.js';
import { ROOM_CAPACITY } from '../rooms/admission.js';
import { RIDER_ONLY_MESSAGES, authorizeRoomMessage, validateRoomMessage, type RoomMessage } from '../rooms/authz.js';
import { ClassFlow, CLASS_TIMING, type ClassEvent, type ClassTable, type ClassTableRow } from '../round/classFlow.js';
import { ClockSync } from '../round/clockSync.js';
import { OUTBOX, ResultOutbox } from '../round/resultOutbox.js';
import { RUN } from '../round/courseRunner.js';
import type { RoundResult, RoundSnapshot } from '../round/roundEngine.js';

export interface LobbyRoomDeps {
  sessions: SessionService;
  accounts: AccountService;
  rooms: RoomDirectory;
  allowedOrigins: readonly string[];
  /** Part B2: where each rider's round result is recorded once per (round, rider). */
  results: ResultRepository;
  /** Part B2: the course of a class; defaults to clubCourse(`${code}|${classNumber}`, 8). Tests pass a short one. */
  course?: (code: string, classNumber: number) => CourseSpec;
  /** Part B2: course-walk and results durations and the reconnection window; defaults CLASS_TIMING / CLASS_PROTOCOL. */
  timing?: { walkMs: number; resultsMs: number; reconnectSeconds?: number };
  /** Part B2: the server clock in ms for the class and the clock sync (tests advance it); defaults to Date.now. */
  clock?: () => number;
}

/**
 * Part B2 — the class inside the room (plan 1.7, 2.3), on top of the B1 door:
 * - Lobby settings: 'height' (a class allowed for the sender's pony category, plan 1.6) and 'assists' are kept per
 *   participant and frozen when the host sends 'start-class'; a change during a class applies to the next class.
 *   Before the class is built every admitted participant — also one admitted over the directory who never opened a
 *   WebSocket, whom onAuth never saw — has her profile and settings valid for her pony category: the missing profiles
 *   are read from the accounts first, and a participant without settings (or with a class her category does not
 *   allow any more) gets the default below — never a class of no category (audit K1 r3 #2). This preparation is
 *   asynchronous: from the start-class until the class is built a second start-class is refused ('class-running'),
 *   and when a profile cannot be read the start is refused ('class-not-ready') and nothing starts.
 * - Clock: on every join the room sends CLOCK_PING_COUNT 'clock-ping' { serverSent } messages (CLOCK_PING_EVERY_MS
 *   apart); the client answers 'clock-pong' { serverSent, clientTime }; rider commands carry clientTime and are
 *   translated with that session's ClockSync — until it is ready they are refused ('clock-not-ready'). Each time the
 *   session's active measurement is set (a series became ready) or refined (a further sample moved its median), the
 *   room sends that connection — and only it — 'clock-offset' { offsetMs }: the active ClockSync.offsetMs, client −
 *   server (a clientTime c is judged at c − offsetMs). The client translates with it from then on, so the lit tap
 *   zone and the instant hint read the judge's own translation and never one biased by the one-way delay (audit K1
 *   r3 #5). An unchanged value is not sent again.
 * - Phases in the state: 'lobby' → 'walk' → 'riding' → 'results' (per heat) → 'done'; 'class-phase' is also sent
 *   as a message { phase, heatIndex, startedAt, endsAt } with the server's clock: when the phase began and when
 *   its timer ends (walk, results; null for riding and done), so a client paces the course walk from the server's
 *   times and never from a constant of its own (audit K1 r1 #6). During 'riding' the state's `riders` map (riders
 *   of the running heat only) and roundClockMs follow the engine every tick; spectators see the arena but cannot
 *   drive anything.
 * - Rider commands ('tap', 'turn', 'gear', 'line') are accepted only from riders of the running heat and always
 *   act on the sender's own horse (there is no horse id in the message, plan 2.3 / matrix row 20); anyone else is
 *   refused ('not-riding'). Take-off and turn decisions are broadcast as 'round-event' { riderId, ...event }.
 * - A dropped connection during 'riding' keeps the seat for reconnectSeconds (Colyseus allowReconnection) with
 *   the horse on autopilot; a reconnection with the token — or a fresh join by the same account, also after the
 *   reservation expired — hands control back; an expired reservation never withdraws the rider (the horse waits
 *   and the time limit decides, plan 2.3). On handing control back the room sends that connection — and only it —
 *   'approach-sync' { classNumber, heatIndex, hardTurn, approach: { fence, attempt, t0 } | null }: the approach the
 *   server has open for the rider's horse right now and still undecided (null between fences, in flight, stopped),
 *   and the hard-turn flag in force; the 'approach' broadcast went only to the connections alive when it opened, so
 *   this is how a returning client arms (or disarms) its take-off tap (audit K1 r2 #1). A fresh join gets it right
 *   after 'class-course' and 'class-phase'; a token reconnection also gets a new clock series, on the NEW
 *   connection. A kick or a session revocation while a reconnection is pending rejects it (the old token is dead,
 *   B1 checks are never bypassed). A consented leave withdraws the rider (eliminated 'disconnected'); the heat goes
 *   on, also with no client connected at all.
 * - The tick that ends a heat publishes the heat's final snapshot (ClassFlow.finalSnapshot) into `riders` in the
 *   same patch that says 'results': every rider of the heat finished or eliminated, with the faults of the results
 *   (time faults included), never the values of the tick before (audit K1 r2 #2). `riders` keeps them through the
 *   results phase; the next heat's 'riding' replaces them. One tick may cross a whole heat (walk → riding → results,
 *   possibly on to 'done' or into later heats): each phase event of the tick is applied with the data of its own heat,
 *   and the 'results' of a heat creates the entries its 'riding' could not (the engine was already gone), so the heat
 *   screen always shows exactly the riders of the heat that ended (audit K1 r3 #3).
 * - Every `riders` entry and every 'class-table' row carries riderName and ponyName (profiles learnt at onAuth, or
 *   read from the accounts before the class is built for a rider admitted over the directory who never connected): a
 *   rider who leaves the room for good is no participant any more, and the client names her from these.
 * - When a heat ends, every result is written with results.insertOnce; the class table is sent as 'class-table'
 *   { table } to everyone when the class is done, and to any client that joins while the class is already done.
 *   A client joining during a class gets 'class-course', then 'class-phase' for the phase in progress (with its
 *   startedAt / endsAt), then — once done — 'class-table'.
 * - The class is ticked from one `now` per tick (deps.clock) for every rider; the live room keeps ticking with
 *   zero clients connected (its lifetime follows the directory entry, never a reservation timeout), so a heat
 *   finishes — and its results are written — even if every rider dropped. The injected `course` is used as is
 *   (production courses come from clubCourse and are valid; tests inject short ones).
 * Ids: the n-th class of a room is `${code}-${n}` (n from 1); its heats are rounds `${code}-${n}#${heatIndex}`.
 * Refusal codes sent as 'refused' { error }: 'not-riding' (a rider command outside 'riding' or from someone not
 * in the running heat), 'clock-not-ready', 'height-not-allowed' (not a class of the sender's pony category),
 * 'class-running' (start-class during a class, or while the previous start-class is still being prepared),
 * 'class-not-ready' (start-class while a participant's profile cannot be read; nothing starts, the host may try
 * again), plus B1's 'host-only' / 'not-participant' / 'not-available'.
 * Defaults: a participant's height class is the lowest class allowed for their pony category; assists are off.
 */
export const CLASS_PROTOCOL = {
  clockPingCount: 8,
  clockPingEveryMs: 200,
  reconnectSeconds: 10,
} as const;

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

/** Part B2: one rider of the running heat as everyone sees them (positions are authoritative, plan 2.3). */
export const RiderView = schema(
  {
    accountId: t.string().default(''),
    heightClass: t.number().default(60),
    positionM: t.number().default(0),
    gear: t.string().default('collected'),
    nextFence: t.number().default(1),
    attempt: t.number().default(1),
    faults: t.number().default(0),
    status: t.string().default('riding'),
    autopilot: t.boolean().default(false),
    lastLabel: t.string().default(''),
    // The rider's names, as shown over the horse and on the heat screen: a rider who leaves the room for good is no
    // participant any more, while her rider entry stays until the next heat.
    riderName: t.string().default(''),
    ponyName: t.string().default(''),
  },
  'RiderView',
);
export type RiderView = SchemaType<typeof RiderView>;

/** A class table row as sent in 'class-table': the pure row plus the rider's names (a rider who left is no participant any more). */
export type ClassTableRowWire = ClassTableRow & { riderName: string; ponyName: string };

/** Room state: no pending or kicked names here (host-only lists live in the HTTP lobby view), only a count. */
export const LobbyState = schema(
  {
    code: t.string().default(''),
    hostId: t.string().default(''),
    entryOpen: t.boolean().default(true),
    pendingCount: t.number().default(0),
    participants: t.map(LobbyParticipant),
    // Part B2 — the class:
    phase: t.string().default('lobby'),
    heatIndex: t.number().default(-1),
    roundClockMs: t.number().default(0),
    riders: t.map(RiderView),
  },
  'LobbyState',
);
export type LobbyState = SchemaType<typeof LobbyState>;

export const LOBBY_ROOM_NAME = 'lobby';

interface Profile {
  riderName: string;
  ponyName: string;
  ponyCategory: PonyCategory;
}

/** A participant's lobby settings (frozen into the class at start-class). */
interface RiderSettings {
  heightClass: HeightClass;
  assists: AssistSettings;
}

/** A pending reconnection of a dropped rider: the Colyseus deferred and the session it belongs to. */
interface Reconnection {
  sessionId: string;
  reject: () => void;
}

export class LobbyRoom extends Room<{ state: LobbyState }> {
  /** Injected once at app start (tests inject their own services). */
  static deps: LobbyRoomDeps | null = null;

  static configure(deps: LobbyRoomDeps): void {
    LobbyRoom.deps = deps;
    // Results wait in a process-level outbox (see resultOutbox.ts): a room disposed while storage is down leaves
    // its rows here, and this timer keeps retrying until they land. The timer never keeps the process alive.
    LobbyRoom.outbox = new ResultOutbox(deps.results, deps.clock ?? Date.now);
    if (LobbyRoom.outboxTimer) clearInterval(LobbyRoom.outboxTimer);
    LobbyRoom.outboxTimer = setInterval(() => void LobbyRoom.outbox?.flush(), OUTBOX.retryMs);
    LobbyRoom.outboxTimer.unref();
  }

  static outbox: ResultOutbox | null = null;
  private static outboxTimer: NodeJS.Timeout | null = null;

  /** Live rooms by code in this process: the server creates exactly one live room per code (audit B2, P1). */
  private static readonly liveByCode = new Map<string, string>();

  private static requireDeps(): LobbyRoomDeps {
    if (!LobbyRoom.deps) throw new Error('LobbyRoom.configure() was not called');
    return LobbyRoom.deps;
  }

  /**
   * Match-making pre-check, before a seat is reserved: the same Origin, session and admission rules as the
   * instance onAuth, against the code the client names. Returns true (no auth data), so Colyseus still runs the
   * instance onAuth at the connection, which binds the admission to THIS room's code.
   */
  static override async onAuth(_token: string, options: LobbyJoinOptions, context: AuthContext): Promise<unknown> {
    const deps = LobbyRoom.requireDeps();
    if (!isAllowedOrigin(context.headers.get('origin') ?? undefined, deps.allowedOrigins)) {
      throw new Error('bad-origin: the request did not come from the game site');
    }
    const token = parseCookies(context.headers.get('cookie') ?? undefined)[SESSION.cookieName] ?? options?.sessionToken;
    const account = token ? await deps.sessions.resolve(token) : null;
    if (!account) throw new Error('no-session: sign in first');
    // Admission is checked against the room the request actually names (joinById/<roomId> in the URL), never
    // against a code the client chooses: a seat is reserved only for a room this account may enter.
    const code = LobbyRoom.requestedCode(context) ?? (typeof options?.code === 'string' ? options.code : undefined);
    const entry = code === undefined ? undefined : deps.rooms.getByCode(code);
    if (!entry?.admission.canAccessState(account.id)) throw new Error('not-admitted: the host has not let this account in');
    return true;
  }

  /** The code of the live room named by a match-making request URL (…/matchmake/joinById/<roomId>), if known here. */
  private static requestedCode(context: AuthContext): string | undefined {
    const raw = (context.req as { url?: unknown } | undefined)?.url;
    if (typeof raw !== 'string') return undefined;
    let path: string;
    try {
      path = new URL(raw, 'http://localhost').pathname;
    } catch {
      return undefined;
    }
    const parts = path.split('/').filter((part) => part !== '');
    const at = parts.indexOf('matchmake');
    if (at === -1 || parts[at + 1] !== 'joinById') return undefined;
    const roomId = parts[at + 2];
    for (const [code, id] of LobbyRoom.liveByCode) if (id === roomId) return code;
    return '\u0000unknown-room'; // a room id this process does not know: no code can admit the account
  }

  private roomCode = '';
  private entryId = '';
  /** Account per connected session (set at onJoin). */
  private readonly accountBySession = new Map<string, string>();
  /** Profiles learnt at onAuth so onJoin can publish the participant synchronously and settings have defaults. */
  private readonly profiles = new Map<string, Profile>();
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

  // ---- Part B2: the class ----
  private readonly settings = new Map<string, RiderSettings>();
  /**
   * Clocks per session: `active` is the last READY measurement (the one rider commands use), `pending` the series
   * being measured now (at every join and every course walk, plan 2.3); a series replaces the active one only once
   * it is ready, so unanswered series never discard a usable offset.
   */
  private readonly clocks = new Map<string, { active: ClockSync | null; pending: ClockSync | null; announced: number | null }>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private flow: ClassFlow | null = null;
  private classNumber = 0;
  /** The course of the current class (announced to every client: the arena and the course walk draw it). */
  private course: CourseSpec | null = null;
  private classId = '';
  /** Riders of the running heat (account ids). */
  private heatRiders = new Set<string>();
  private lastTable: Record<string, ClassTableRowWire[]> | null = null;
  /** Dropped riders whose seat is kept for a while (by account id). */
  private readonly reconnections = new Map<string, Reconnection>();
  private simulating = false;
  /** True from a start-class until its class is built (the profiles are read in between): a second one is refused. */
  private preparing = false;

  /** The code of the room this instance serves (set in onCreate; never taken from a joining client). */
  get code(): string {
    return this.roomCode;
  }

  override onCreate(options: { code: string }): void {
    const entry = this.deps().rooms.getByCode(options.code);
    if (!entry) throw new Error(`unknown-code: no room is open with code ${options.code}`);
    if (LobbyRoom.liveByCode.has(entry.code)) throw new Error(`room-exists: a live room is already open for code ${entry.code}`);
    LobbyRoom.liveByCode.set(entry.code, this.roomId);
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

    // A kick decided over HTTP or in the room: cut the connection now (voice revocation arrives with LiveKit, phase 3),
    // reject a pending reconnection, and withdraw the rider from the running heat.
    this.unsubscribeRevoke = this.deps().rooms.onRevoke((roomId, revocation) => {
      if (roomId !== this.entryId) return;
      this.rejectReconnection(revocation.accountId);
      this.flow?.riderLeft(revocation.accountId, this.serverNow());
      for (const client of this.clients) {
        if (this.accountBySession.get(client.sessionId) === revocation.accountId) client.leave(KICKED_CLOSE_CODE);
      }
    });

    // A session revocation (PIN reset, logout): every live connection of that account is forgotten and closed at
    // once, so it can neither send a command nor receive another patch; the generation is remembered so a
    // connection whose onAuth predates the revocation is refused at onJoin. Admission is untouched: after a new
    // sign-in the same account may come back, so the horse goes on autopilot rather than out of the heat.
    this.unsubscribeSessionRevoke = this.deps().sessions.onRevoke((accountId, generation) => {
      const known = this.revokedGeneration.get(accountId);
      if (known === undefined || generation > known) this.revokedGeneration.set(accountId, generation);
      this.rejectReconnection(accountId);
      for (const client of this.clients) {
        if (this.accountBySession.get(client.sessionId) !== accountId) continue;
        this.forgetSession(client.sessionId);
        client.leave(SESSION_REVOKED_CLOSE_CODE);
      }
      if (this.heatRiders.has(accountId)) this.flow?.riderDisconnected(accountId, this.serverNow());
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
    this.profiles.set(account.id, { riderName: account.riderName, ponyName: account.ponyName, ponyCategory: account.ponyCategory });
    this.ensureSettings(account.id);
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
    // A fresh connection supersedes a pending reconnection of the same account.
    this.rejectReconnection(accountId);
    this.accountBySession.set(client.sessionId, accountId);
    if (!this.state.participants.has(accountId)) {
      const profile = this.profiles.get(accountId);
      const participant = new LobbyParticipant();
      participant.accountId = accountId;
      participant.riderName = profile?.riderName ?? '';
      participant.ponyName = profile?.ponyName ?? '';
      this.state.participants.set(accountId, participant);
    }
    this.syncDoor();
    this.startClockSync(client);
    if (this.heatRiders.has(accountId)) this.flow?.riderReconnected(accountId, this.serverNow());
    // A late joiner learns the class in progress: its course (for the arena and the walk), the phase with its clock,
    // and, once done, the table.
    if (this.flow !== null && this.course !== null) {
      client.send('class-course', { course: this.course, classNumber: this.classNumber });
      const startedAt = this.flow.phaseStartedAt;
      if (startedAt !== null) client.send('class-phase', { phase: this.flow.phase, heatIndex: this.flow.heatIndex, startedAt, endsAt: this.flow.phaseEndsAt() });
      this.syncApproach(client, accountId);
    }
    if (this.flow?.phase === 'done' && this.lastTable !== null) client.send('class-table', { table: this.lastTable });
  }

  override onLeave(client: Client, code?: number): void {
    const accountId = this.accountBySession.get(client.sessionId);
    // A session already forgotten (revoked, superseded) has nothing left to do here.
    if (accountId === undefined) return;
    const othersAlive = [...this.accountBySession].some(([sessionId, id]) => sessionId !== client.sessionId && id === accountId);
    const riding = this.flow?.phase === 'riding' && this.heatRiders.has(accountId);
    const dropped = code !== CloseCode.CONSENTED && code !== KICKED_CLOSE_CODE && code !== SESSION_REVOKED_CLOSE_CODE;
    if (dropped && riding && !othersAlive && !this.reconnections.has(accountId)) {
      // The account's last connection went to sleep: keep the seat for a while with the horse on autopilot (the
      // account mapping stays until the reservation is consumed, rejected or expires).
      this.flow?.riderDisconnected(accountId, this.serverNow());
      void this.keepSeat(client, accountId);
      return;
    }
    // Another live session of the same account keeps control; a drop outside the heat just forgets the session
    // (presence is read again when a heat starts).
    const gone = this.forgetSession(client.sessionId);
    if (!gone) return;
    if (gone.lastConnection && code === CloseCode.CONSENTED) {
      // Leaving for good: out of the running heat now, and the heat is advanced at once so that, when nobody is
      // left, its results are written before the room goes.
      this.flow?.riderLeft(gone.accountId, this.serverNow());
      this.tickClass();
      this.deps().rooms.leave(this.roomCode, gone.accountId);
    }
    this.syncDoor();
    this.closeIfGone();
  }

  /** Decisions taken over HTTP (admit, deny, close the door…) reach the state before every patch. */
  override onBeforePatch(): void {
    this.syncDoor();
    this.closeIfGone();
  }

  override onDispose(): void {
    if (LobbyRoom.liveByCode.get(this.roomCode) === this.roomId) LobbyRoom.liveByCode.delete(this.roomCode);
    this.unsubscribeRevoke?.();
    this.unsubscribeRevoke = null;
    this.unsubscribeSessionRevoke?.();
    this.unsubscribeSessionRevoke = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // Rows still queued stay in the process-level outbox, which keeps retrying after this room is gone.
    void LobbyRoom.outbox?.flush();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Part B2: reconnection

  /** Keep the dropped rider's seat for reconnectSeconds; control returns on reconnection, nothing changes on expiry. */
  private async keepSeat(client: Client, accountId: string): Promise<void> {
    const seconds = this.deps().timing?.reconnectSeconds ?? CLASS_PROTOCOL.reconnectSeconds;
    const deferred = this.allowReconnection(client, seconds);
    this.reconnections.set(accountId, { sessionId: client.sessionId, reject: () => deferred.reject() });
    try {
      const back = await deferred;
      this.reconnections.delete(accountId);
      this.accountBySession.set(client.sessionId, accountId);
      if (this.heatRiders.has(accountId)) this.flow?.riderReconnected(accountId, this.serverNow());
      // Messages go to the NEW Client object: Colyseus marks the previous one RECONNECTED and drops whatever is sent
      // to it, so the clock series used to vanish here (found with audit K1 r2 #1).
      this.startClockSync(back);
      this.syncApproach(back, accountId);
    } catch {
      // Expired, rejected or superseded: the socket is gone; the rider keeps riding (autopilot, then waiting).
      if (this.reconnections.get(accountId)?.sessionId === client.sessionId) this.reconnections.delete(accountId);
      this.forgetSession(client.sessionId);
      this.syncDoor();
    }
  }

  /**
   * Tell a rider of the running heat who takes control back — by the token or by a fresh join — the approach the
   * server has open for their horse right now (audit K1 r2 #1): the 'approach' broadcast went only to the connections
   * alive when it opened, so the returning client would otherwise never arm the tap of the approach in progress, and
   * a null approach disarms one whose verdict it missed. Sent to this connection only.
   */
  private syncApproach(client: Client, accountId: string): void {
    const flow = this.flow;
    const engine = flow?.engine() ?? null;
    if (flow === null || engine === null || !this.heatRiders.has(accountId)) return;
    const own = engine.approachOf(accountId);
    if (own === null) return;
    client.send('approach-sync', { classNumber: this.classNumber, heatIndex: flow.heatIndex, hardTurn: own.hardTurn, approach: own.approach });
  }

  private rejectReconnection(accountId: string): void {
    const pending = this.reconnections.get(accountId);
    if (!pending) return;
    this.reconnections.delete(accountId);
    pending.reject();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Part B2: clock sync

  /** Send a fresh ping series; its samples replace the active offset only once the new series is ready. */
  private startClockSync(client: Client): void {
    const clocks = this.clocks.get(client.sessionId) ?? { active: null, pending: null, announced: null };
    clocks.pending = new ClockSync();
    this.clocks.set(client.sessionId, clocks);
    for (let i = 0; i < CLASS_PROTOCOL.clockPingCount; i += 1) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.accountBySession.has(client.sessionId)) client.send('clock-ping', { serverSent: this.serverNow() });
      }, i * CLASS_PROTOCOL.clockPingEveryMs);
      this.timers.add(timer);
    }
  }

  /** The last ready clock measurement of a session. */
  private activeClock(sessionId: string): ClockSync | null {
    return this.clocks.get(sessionId)?.active ?? null;
  }

  /**
   * A pong feeds the series being measured; once that series is ready it becomes the active measurement. Whenever the
   * active offset is new or has moved, the client is told it ('clock-offset', audit K1 r3 #5).
   */
  private clockPong(client: Client, serverSent: number, clientTime: number): void {
    const clocks = this.clocks.get(client.sessionId);
    if (!clocks) return;
    const target = clocks.pending ?? clocks.active;
    if (!target) return;
    target.addSample({ serverSent, clientTime, serverReceived: this.serverNow() });
    if (clocks.pending && clocks.pending.ready) {
      clocks.active = clocks.pending;
      clocks.pending = null;
    }
    const offsetMs = clocks.active?.offsetMs ?? null;
    if (offsetMs !== null && offsetMs !== clocks.announced) {
      clocks.announced = offsetMs;
      client.send('clock-offset', { offsetMs });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Part B2: the class

  private async startClass(client: Client, actorId: string, order: 'random' | 'lowest-class-first'): Promise<void> {
    if (!this.entry()) return;
    if (this.preparing || (this.flow && this.flow.phase !== 'done')) {
      client.send('refused', { error: 'class-running' });
      return;
    }
    this.preparing = true;
    let participants: string[] | null;
    try {
      participants = await this.prepareParticipants();
    } finally {
      this.preparing = false;
    }
    if (this.closing || !this.entry()) return;
    if (participants === null) {
      client.send('refused', { error: 'class-not-ready' });
      return;
    }
    this.classNumber += 1;
    this.classId = `${this.roomCode}-${this.classNumber}`;
    const deps = this.deps();
    const course = deps.course ? deps.course(this.roomCode, this.classNumber) : clubCourse(`${this.roomCode}|${this.classNumber}`, 8);
    // The settings are frozen here: a change from now on applies to the next class.
    const riders = participants.map((accountId) => {
      const own = this.ensureSettings(accountId);
      return { riderId: accountId, heightClass: own.heightClass, assists: { ...own.assists } };
    });
    const timing = deps.timing ? { walkMs: deps.timing.walkMs, resultsMs: deps.timing.resultsMs } : CLASS_TIMING;
    this.flow = new ClassFlow({ classId: this.classId, course, riders, order, mode: 'ranked', seed: this.classId, timing });
    this.course = course;
    this.heatRiders = new Set();
    this.lastTable = null;
    // Everyone in the room gets the course before the walk starts (the arena and the course walk draw it).
    this.broadcast('class-course', { course, classNumber: this.classNumber });
    this.flow.start(this.serverNow());
    if (!this.simulating) {
      this.simulating = true;
      this.setSimulationInterval(() => this.tickClass(), RUN.tickMs);
    }
    this.tickClass();
    void actorId;
  }

  private tickClass(): void {
    // Queued results are retried on every tick (rate-limited inside the outbox), also once the class is done.
    void LobbyRoom.outbox?.flush();
    const flow = this.flow;
    if (!flow || flow.phase === 'done') return;
    // Only COMPLETED milliseconds are simulated: a command is stamped with the current millisecond when it
    // arrives, so the tick for that millisecond (and any "no tap" it fixes at a deadline) happens only once the
    // clock has moved on and every packet stamped with it has been read — the callback order inside one
    // millisecond can no longer change a verdict (audit B2, deadline race).
    const now = this.serverNow() - 1;
    const events = flow.tick(now);
    for (const event of events) this.applyClassEvent(flow, event);
    this.syncRiders(flow);
  }

  private applyClassEvent(flow: ClassFlow, event: ClassEvent): void {
    if (event.type === 'phase') {
      this.state.phase = event.phase;
      this.state.heatIndex = event.heatIndex;
      if (event.phase === 'walk') {
        // Clocks are measured again before every heat (plan 2.3): a tab that missed the first series gets another.
        for (const client of this.clients) if (this.accountBySession.has(client.sessionId)) this.startClockSync(client);
      }
      if (event.phase === 'riding') {
        // The data of a phase event is the data of ITS heat (audit K1 r3 #3): one tick may cross a whole heat — or
        // several — so the engine is used only while it is still this heat's; a heat that already ended within the
        // same tick is seated from its final snapshot.
        const engine = flow.phase === 'riding' && flow.heatIndex === event.heatIndex ? flow.engine() : null;
        const heat = engine?.snapshot() ?? flow.finalSnapshot(event.heatIndex);
        this.state.riders.clear();
        this.heatRiders = new Set();
        if (heat !== null) this.seatRiders(heat);
        if (engine !== null) {
          this.heatRiders = new Set(heat?.riders.map((r) => r.riderId) ?? []);
          // A rider with no live connection at the start rides on autopilot until they come back.
          for (const riderId of this.heatRiders) {
            if (!this.isConnected(riderId) && !this.reconnections.has(riderId)) flow.riderDisconnected(riderId, this.serverNow());
          }
        }
      }
      if (event.phase === 'results') {
        // The heat ended in this very tick — its last finish or elimination came after the previous syncRiders, and
        // flow.engine() is null from here — so its final values are published now, in the same patch as the phase:
        // the heat screen never shows the last rider still riding or without her time faults (audit K1 r2 #2). When
        // the same tick also began the heat, its 'riding' event found no engine to read: the entries are created here
        // from the final snapshot (audit K1 r3 #3), so `riders` is always exactly the heat that ended.
        const final = flow.finalSnapshot(event.heatIndex);
        if (final !== null) {
          this.seatRiders(final);
          this.publishRiders(final);
        }
        this.heatRiders = new Set();
        this.recordResults(flow.results().filter((r) => r.roundId === `${this.classId}#${event.heatIndex}`));
      }
      if (event.phase === 'done') {
        this.lastTable = this.withNames(flow.table());
        this.broadcast('class-table', { table: this.lastTable });
      }
      this.broadcast('class-phase', { phase: event.phase, heatIndex: event.heatIndex, startedAt: event.at, endsAt: event.endsAt });
      return;
    }
    this.broadcast('round-event', event);
  }

  private syncRiders(flow: ClassFlow): void {
    const engine = flow.engine();
    if (engine) this.publishRiders(engine.snapshot());
  }

  /**
   * Make the state's riders exactly the riders of `snapshot`'s heat: an entry of another rider goes, a missing one is
   * created with the rider's height class and names (its values come with publishRiders).
   */
  private seatRiders(snapshot: RoundSnapshot): void {
    const ids = new Set(snapshot.riders.map((r) => r.riderId));
    for (const id of [...this.state.riders.keys()]) if (!ids.has(id)) this.state.riders.delete(id);
    for (const rider of snapshot.riders) {
      if (this.state.riders.has(rider.riderId)) continue;
      const view = new RiderView();
      view.accountId = rider.riderId;
      view.heightClass = rider.heightClass;
      const names = this.namesOf(rider.riderId);
      view.riderName = names.riderName;
      view.ponyName = names.ponyName;
      this.state.riders.set(rider.riderId, view);
    }
  }

  /** Mirror a heat snapshot (the running one, or the final one of a heat that just ended) into the state's riders. */
  private publishRiders(snapshot: RoundSnapshot): void {
    if (this.state.roundClockMs !== snapshot.elapsedMs) this.state.roundClockMs = snapshot.elapsedMs;
    for (const rider of snapshot.riders) {
      const view = this.state.riders.get(rider.riderId);
      if (!view) continue;
      if (view.positionM !== rider.positionM) view.positionM = rider.positionM;
      if (view.gear !== rider.gear) view.gear = rider.gear;
      if (view.nextFence !== rider.nextFence) view.nextFence = rider.nextFence;
      if (view.attempt !== rider.attempt) view.attempt = rider.attempt;
      if (view.faults !== rider.faults) view.faults = rider.faults;
      if (view.status !== rider.status) view.status = rider.status;
      if (view.autopilot !== rider.autopilot) view.autopilot = rider.autopilot;
      const label = rider.lastLabel ?? '';
      if (view.lastLabel !== label) view.lastLabel = label;
    }
  }

  /** The names of an account as the room knows them (from onAuth, or learnt from the accounts); '' while unknown. */
  private namesOf(accountId: string): { riderName: string; ponyName: string } {
    const profile = this.profiles.get(accountId);
    return { riderName: profile?.riderName ?? '', ponyName: profile?.ponyName ?? '' };
  }

  /**
   * The admitted participants of the class about to start, each with a known profile (audit K1 r3 #2). A participant
   * who never opened a WebSocket (admitted over the directory: in the class like any admitted participant, on
   * autopilot) is unknown to onAuth, so her profile — names and pony category, hence her default class — is read from
   * the accounts before the class is built. The list is read again after every wait (a kick, a leave or an admission
   * may land meanwhile) until every participant on it is known. Null when a profile cannot be read (storage trouble,
   * or no such account): the class must not start with a rider of unknown category.
   */
  private async prepareParticipants(): Promise<string[] | null> {
    for (;;) {
      const entry = this.entry();
      if (!entry) return null;
      const participants = [...entry.admission.participants];
      const missing = participants.filter((id) => !this.profiles.has(id));
      if (missing.length === 0) return participants;
      const read = await Promise.allSettled(missing.map((id) => this.deps().accounts.getPublicProfile(id)));
      for (const [index, outcome] of read.entries()) {
        const accountId = missing[index];
        if (accountId === undefined) continue;
        if (outcome.status !== 'fulfilled' || outcome.value === null) return null;
        // A connection that landed meanwhile brought a fresher profile (onAuth): keep that one.
        if (!this.profiles.has(accountId)) {
          const profile = outcome.value;
          this.profiles.set(accountId, { riderName: profile.riderName, ponyName: profile.ponyName, ponyCategory: profile.ponyCategory });
        }
      }
    }
  }

  /**
   * A participant's settings, valid for her pony category: kept as she set them while her category allows the class;
   * otherwise (none yet, or a class her category no longer allows) the lowest class allowed for her category with
   * the assists she had (off by default). Her profile must be known (onAuth, or prepareParticipants).
   */
  private ensureSettings(accountId: string): RiderSettings {
    const category = this.profiles.get(accountId)?.ponyCategory;
    const own = this.settings.get(accountId);
    if (category === undefined) {
      if (own) return own;
      throw new Error(`no profile for ${accountId}: its pony category, hence its height class, is unknown`);
    }
    const allowed = allowedHeightClasses(category);
    if (own && allowed.includes(own.heightClass)) return own;
    const lowest = allowed[0];
    if (lowest === undefined) throw new Error(`pony category ${category} allows no height class`);
    const fixed: RiderSettings = { heightClass: lowest, assists: own ? own.assists : { schoolmaster: false, widerWindow: false } };
    this.settings.set(accountId, fixed);
    return fixed;
  }

  /** The class table with every row named (the table itself is pure; the room knows the names). */
  private withNames(table: ClassTable): Record<string, ClassTableRowWire[]> {
    const named: Record<string, ClassTableRowWire[]> = {};
    for (const [heightClass, rows] of Object.entries(table)) named[heightClass] = (rows ?? []).map((row) => ({ ...row, ...this.namesOf(row.riderId) }));
    return named;
  }

  /** Queue the results of a finished heat (once per rider) in the process-level outbox and try to write them now. */
  private recordResults(results: RoundResult[]): void {
    const recordedAt = this.serverNow();
    LobbyRoom.outbox?.add(
      results.map((result): ResultRecord => ({
        roundId: result.roundId,
        accountId: result.riderId,
        courseId: result.courseId,
        courseVersion: result.courseVersion,
        rulesVersion: result.rulesVersion,
        heightClass: result.heightClass,
        faults: result.faults,
        timeMs: result.timeMs,
        status: result.status,
        eliminationReason: result.eliminationReason,
        autopilot: result.autopilot,
        schoolmaster: result.schoolmaster,
        mode: 'ranked',
        seed: result.seed,
        recordedAt,
      })),
    );
    void LobbyRoom.outbox?.flush();
  }

  private isConnected(accountId: string): boolean {
    return [...this.accountBySession.values()].includes(accountId);
  }

  /** A rider command: only from a rider of the running heat, always about the sender's own horse. */
  private riderCommand(client: Client, actorId: string, message: RoomMessage): void {
    const flow = this.flow;
    if (!flow || flow.phase !== 'riding' || !this.heatRiders.has(actorId)) {
      client.send('refused', { error: 'not-riding' });
      return;
    }
    const receiveTime = this.serverNow();
    if (message.type === 'gear') {
      flow.enqueue({ riderId: actorId, receiveTime, kind: 'gear', gear: message.gear });
      return;
    }
    if (message.type === 'line') {
      flow.enqueue({ riderId: actorId, receiveTime, kind: 'line', line: message.line });
      return;
    }
    const sync = this.activeClock(client.sessionId);
    const actionTime = sync?.toServerTime(message.type === 'tap' || message.type === 'turn' ? message.clientTime : 0) ?? null;
    if (actionTime === null) {
      client.send('refused', { error: 'clock-not-ready' });
      return;
    }
    if (message.type === 'tap') {
      flow.enqueue({ riderId: actorId, receiveTime, kind: 'tap', actionTime, fence: message.fence, attempt: message.attempt });
    } else if (message.type === 'turn') {
      flow.enqueue({ riderId: actorId, receiveTime, kind: 'turn', choice: message.choice, actionTime });
    }
  }

  private serverNow(): number {
    return (this.deps().clock ?? Date.now)();
  }

  // ---------------------------------------------------------------------------------------------------------

  /**
   * Forget a client session: drop its account mapping (so no further message of it is heard) and, when it was
   * the account's last connection, its participant. Returns null when the session was unknown or already
   * forgotten, so a later onLeave for the same socket is a no-op.
   */
  private forgetSession(sessionId: string): { accountId: string; lastConnection: boolean } | null {
    this.generationBySession.delete(sessionId);
    this.clocks.delete(sessionId);
    const accountId = this.accountBySession.get(sessionId);
    if (!accountId) return null;
    this.accountBySession.delete(sessionId);
    const lastConnection = ![...this.accountBySession.values()].includes(accountId);
    if (lastConnection) this.state.participants.delete(accountId);
    return { accountId, lastConnection };
  }

  private deps(): LobbyRoomDeps {
    return LobbyRoom.requireDeps();
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
    if (RIDER_ONLY_MESSAGES.has(message.type)) {
      this.riderCommand(client, actorId, message);
      return;
    }
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
        void this.startClass(client, actorId, message.order);
        break;
      case 'emote':
        this.broadcast('emote', { from: actorId, emote: message.emote });
        break;
      case 'height': {
        // A connected sender: onAuth learnt her profile and gave her settings of her category.
        const category = this.profiles.get(actorId)?.ponyCategory;
        if (category === undefined || !allowedHeightClasses(category).includes(message.heightClass)) {
          client.send('refused', { error: 'height-not-allowed' });
          break;
        }
        const own = this.ensureSettings(actorId);
        this.settings.set(actorId, { ...own, heightClass: message.heightClass });
        break;
      }
      case 'assists': {
        const own = this.ensureSettings(actorId);
        this.settings.set(actorId, { ...own, assists: { schoolmaster: message.schoolmaster, widerWindow: message.widerWindow } });
        break;
      }
      case 'clock-pong':
        this.clockPong(client, message.serverSent, message.clientTime);
        break;
      default:
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
