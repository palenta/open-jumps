// The live room from the client's side (plan 2.2, 2.3): joinById with the roomId the doorbell handed out, the
// state as plain snapshots, every server message typed, clock pings answered from the ClientClock, and the
// reconnection path for Safari's silent socket drops on screen lock — with the SDK's own retries on, the SDK
// reconnects by itself while the tab lives and the session reports the outcome (connected again, or lost for good
// once the retries are exhausted); with them off, resume() reconnects by the reconnection token on
// visibilitychange / pageshow.
import { HEIGHT_CLASSES, type CourseSpec, type Gear, type HeightClass, type RoundMode } from '@open-jumps/shared';
import type { ClientClock } from './clientClock.js';
import { KICKED_CLOSE_CODE, OPENED_ELSEWHERE_CLOSE_CODE, SESSION_REVOKED_CLOSE_CODE, type ClientRoomMessage, type ControlState, type Line, type LobbyStateSnapshot, type ServerMessage } from './types.js';

/** The SDK's retry settings the session may override (tests shorten them; production keeps the SDK's defaults). */
export interface RetrySettings {
  /** How long the room must have been up before the SDK retries at all (SDK default 5000 ms). */
  minUptime?: number;
  maxRetries?: number;
  delay?: number;
  minDelay?: number;
  maxDelay?: number;
}

/** The slice of a Colyseus SDK Room the session uses (ColyseusSDK's Room satisfies it). */
export interface RoomLike {
  roomId: string;
  sessionId: string;
  /** The SDK renews it on every (re)connection — AFTER its onReconnect callback has returned (0.18.9). */
  reconnectionToken: string;
  state: unknown;
  reconnection: { enabled: boolean; isReconnecting?: boolean } & RetrySettings;
  onStateChange(callback: (state: unknown) => void): unknown;
  onMessage(type: '*', callback: (type: string | number, payload: unknown) => void): unknown;
  onLeave(callback: (code: number, reason?: string) => void): unknown;
  onDrop(callback: (code: number, reason?: string) => void): unknown;
  onReconnect(callback: () => void): unknown;
  send(type: string, payload?: unknown): void;
  leave(consented?: boolean): Promise<number>;
}

/** The slice of the SDK client the session uses (ColyseusSDK satisfies it). */
export interface SdkLike {
  joinById(roomId: string, options?: { code: string }): Promise<RoomLike>;
  reconnect(reconnectionToken: string): Promise<RoomLike>;
}

export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'dropped' | 'ended';

/** Why a session is over for good: kicked (4100), signed out elsewhere (4101), left on purpose, or lost (no way back). */
export type SessionEnd = { kind: 'kicked' | 'revoked' | 'elsewhere' | 'left' | 'lost'; code: number };

export interface RoomSessionDeps {
  sdk: SdkLike;
  clock: ClientClock;
  /** The SDK's own retry loop on a drop (default true); off, a drop waits for resume(). */
  autoReconnect?: boolean;
  /** Overrides of the SDK's retry settings (tests only; production keeps the SDK's defaults). */
  retry?: RetrySettings;
}

/** How long the first full state may take after the join resolved. */
const FIRST_STATE_TIMEOUT_MS = 5000;

/**
 * - connect(): joinById(roomId, { code }); resolves once the first full state (code ≠ '') has arrived, with every
 *   handler in place (a message is never missed between join and subscription).
 * - Every 'clock-ping' is answered at once with clock.onPing(serverSent) as the 'room' message; every 'clock-offset'
 *   (the server's own measurement, audit K1 r3 #5) is handed to clock.onServerOffset — both before any listener hears
 *   the message, so what a listener draws from server times already uses the new reading. A 'clock-offset' whose
 *   offsetMs is not a finite number is dropped.
 * - state: the latest snapshot (state.toJSON()); onState fires after every patch.
 * - Messages reach onMessage listeners as ServerMessage ('round-event' carries the event under `event`);
 *   'class-course' is also remembered as course(); a malformed 'approach-sync' is dropped.
 * - speedMps (K1.1 step 5) of an 'approach' round event and of the approach of an 'approach-sync' is handed on as
 *   sent when it is a finite number above 0, and as null otherwise — missing, not a number, NaN, ±Infinity, 0 or
 *   negative: an approach without speed (the game then draws the marker as an outline and the own horse from the
 *   patch). An invalid speed never drops the message: the approach itself still arms the tap.
 * - A leave code 4100 → ended 'kicked', 4101 → 'revoked', 4102 → 'elsewhere' (a newer connection of the account took
 *   control: the game is open in another window — K1.1 code audit r3; never retried, whatever the retry setting), a
 *   consented leave → 'left'. Any other close: with the
 *   SDK's retries ON, the SDK's onDrop makes the status 'dropped' and the SDK retries by itself — a successful
 *   retry → 'connected', and the final onLeave once the retries are exhausted (or refused at once: uptime too
 *   short, a server close the SDK never retries) ends the session as 'lost' (audit K1 r1 #4: never a 'dropped'
 *   that nothing will ever change); with them OFF the close is a drop: status 'dropped', waiting for resume().
 * - resume(): when dropped and the SDK is not retrying, reconnect by the room's CURRENT token; resolves true when
 *   connected afterwards (also when it already was), false when the server refused (then the session ends as
 *   'lost') or when the SDK is still retrying (its outcome comes as the next status).
 * - reconnectionToken: always the room's current one — the SDK renews it on every reconnection, right after its
 *   onReconnect callback, so the stored copy is refreshed a microtask later too (audit K1 r1 #10).
 * - send() while not connected (dropped, connecting) sends nothing and returns false — a rider command is useless
 *   late and the server has autopilot — so the caller can keep the input unspent (audit K1 r3 #1); true when the
 *   message was handed to the room. send(message, seq) numbers a 'gear' or 'line' command (K1.1 code audit r2): the
 *   payload goes out with that seq, which the server's answer names; the caller owns the numbering. A seq given with
 *   any other message is not sent.
 * - K1.1 code audit r2 — the server's answers about the rider's controls and rules, each handed on only when well
 *   formed (a number is finite, a seq a safe integer ≥ 0, a gear or line one of the closed ids, a height one of the
 *   classes, a mode 'ranked' or 'training', the assists two booleans): 'control-applied' { seq (or null), at,
 *   requestedGear, line } — dropped otherwise; 'class-rules' { classNumber, heightClass, mode, assists } — dropped
 *   otherwise; 'refused' carries seq only when the server named a valid one; an 'approach-sync' carries controls
 *   { requestedGear, line, at } only when all three are present and valid — never dropped for them (the approach still
 *   arms the tap).
 */
export class RoomSession {
  private readonly sdk: SdkLike;
  private readonly clock: ClientClock;
  private readonly autoReconnect: boolean;
  private readonly retry: RetrySettings;
  private room: RoomLike | null = null;
  private snapshot: LobbyStateSnapshot | null = null;
  private currentStatus: SessionStatus = 'idle';
  private currentEnd: SessionEnd | null = null;
  private currentCourse: CourseSpec | null = null;
  /** The token of the last connection as last seen (the room's own field is the live value), kept through a drop for resume(). */
  private token: string | null = null;
  /** True while leave() runs, so the close it causes reads as 'left'. */
  private leaving = false;
  private readonly stateListeners = new Set<(state: LobbyStateSnapshot) => void>();
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly statusListeners = new Set<(status: SessionStatus) => void>();

  constructor(deps: RoomSessionDeps) {
    this.sdk = deps.sdk;
    this.clock = deps.clock;
    this.autoReconnect = deps.autoReconnect ?? true;
    this.retry = deps.retry ?? {};
  }

  async connect(roomId: string, code: string): Promise<void> {
    this.setStatus('connecting');
    let room: RoomLike;
    try {
      room = await this.sdk.joinById(roomId, { code });
    } catch (error) {
      this.setStatus('idle');
      throw error;
    }
    await this.adopt(room);
  }

  async resume(): Promise<boolean> {
    if (this.currentStatus === 'connected') return true;
    const token = this.currentToken();
    if (this.currentStatus !== 'dropped' || token === null) return false;
    if (this.room?.reconnection.isReconnecting) return false; // the SDK is still on it; the next status says
    this.setStatus('connecting');
    let room: RoomLike;
    try {
      room = await this.sdk.reconnect(token);
    } catch {
      this.finish({ kind: 'lost', code: 0 });
      return false;
    }
    try {
      await this.adopt(room);
    } catch {
      this.finish({ kind: 'lost', code: 0 });
      return false;
    }
    return this.statusNow() === 'connected';
  }

  async leave(): Promise<void> {
    const room = this.room;
    if (room === null || this.currentStatus === 'ended') return;
    this.leaving = true;
    try {
      const code = await room.leave(true);
      if (this.statusNow() !== 'ended') this.finish({ kind: 'left', code });
    } finally {
      this.leaving = false;
    }
  }

  /**
   * Hands the message to the room and returns true; while not connected (dropped, connecting, ended, idle) nothing is
   * sent and the answer is false, so the caller knows the input never left (audit K1 r3 #1).
   */
  send(message: ClientRoomMessage, seq?: number): boolean {
    if (this.currentStatus !== 'connected' || this.room === null) return false;
    const numbered = seq !== undefined && (message.type === 'gear' || message.type === 'line');
    this.room.send('room', numbered ? { ...message, seq } : message);
    return true;
  }

  get state(): LobbyStateSnapshot | null {
    return this.snapshot;
  }

  get status(): SessionStatus {
    return this.currentStatus;
  }

  get end(): SessionEnd | null {
    return this.currentEnd;
  }

  /** The reconnection token of the current connection (persisted by the app for a reload), null when none. */
  get reconnectionToken(): string | null {
    return this.currentToken();
  }

  /** The room's own token is the live value: the SDK renews it on every reconnection. */
  private currentToken(): string | null {
    return this.room?.reconnectionToken ?? this.token;
  }

  course(): CourseSpec | null {
    return this.currentCourse;
  }

  onState(listener: (state: LobbyStateSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: (status: SessionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ---------------------------------------------------------------------------------------------------------

  /** Wire a freshly joined or reconnected room, then wait for its first full state. */
  private async adopt(room: RoomLike): Promise<void> {
    this.room = room;
    this.token = room.reconnectionToken;
    room.reconnection.enabled = this.autoReconnect;
    Object.assign(room.reconnection, this.retry);
    const firstState = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no room state arrived')), FIRST_STATE_TIMEOUT_MS);
      room.onStateChange((state) => {
        const snapshot = toSnapshot(state);
        if (snapshot === null) return;
        this.snapshot = snapshot;
        if (snapshot.code !== '') {
          clearTimeout(timer);
          resolve();
        }
        for (const listener of [...this.stateListeners]) listener(snapshot);
      });
    });
    room.onMessage('*', (type, payload) => this.receive(String(type), payload));
    room.onDrop(() => {
      if (this.room === room && this.currentStatus === 'connected') this.setStatus('dropped');
    });
    room.onReconnect(() => {
      if (this.room !== room) return;
      this.setStatus('connected');
      // SDK 0.18.9 assigns the renewed token right AFTER this callback returns: the stored copy is refreshed a
      // microtask later (reads in between go to the room's own field, which is always the live value).
      queueMicrotask(() => {
        if (this.room === room) this.token = room.reconnectionToken;
      });
    });
    room.onLeave((code) => {
      if (this.room !== room || this.currentStatus === 'ended') return;
      if (code === KICKED_CLOSE_CODE) this.finish({ kind: 'kicked', code });
      else if (code === SESSION_REVOKED_CLOSE_CODE) this.finish({ kind: 'revoked', code });
      else if (code === OPENED_ELSEWHERE_CLOSE_CODE) this.finish({ kind: 'elsewhere', code });
      else if (this.leaving) this.finish({ kind: 'left', code });
      // With the SDK's retries on, onLeave is final: the retries are exhausted (FAILED_TO_RECONNECT), or the SDK
      // never started them (uptime too short, a server close it does not retry) — nothing in this session will
      // bring the room back, so the app must be told to connect afresh. With them off, the close is a drop and
      // resume() may still reconnect by the token.
      else if (this.autoReconnect) this.finish({ kind: 'lost', code });
      else this.setStatus('dropped');
    });
    const current = toSnapshot(room.state);
    if (current !== null && current.code !== '') this.snapshot = current;
    this.setStatus('connected');
    if (this.snapshot === null || this.snapshot.code === '') await firstState;
  }

  private receive(type: string, payload: unknown): void {
    const message = decode(type, payload);
    if (message === null) return;
    if (message.type === 'clock-ping') {
      const pong = this.clock.onPing(message.serverSent);
      this.room?.send('room', pong);
    } else if (message.type === 'clock-offset') {
      this.clock.onServerOffset(message.offsetMs);
    } else if (message.type === 'class-course') {
      this.currentCourse = message.course;
    }
    for (const listener of [...this.messageListeners]) listener(message);
  }

  /** The status after an await (a plain read keeps TypeScript's earlier narrowing of the field). */
  private statusNow(): SessionStatus {
    return this.currentStatus;
  }

  private setStatus(status: SessionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private finish(end: SessionEnd): void {
    this.currentEnd = end;
    this.setStatus('ended');
  }
}

/** The plain snapshot of a schema state (maps become objects), or null before any state exists. */
function toSnapshot(state: unknown): LobbyStateSnapshot | null {
  if (state === null || state === undefined) return null;
  const json = typeof (state as { toJSON?: unknown }).toJSON === 'function' ? (state as { toJSON: () => unknown }).toJSON() : state;
  if (typeof json !== 'object' || json === null) return null;
  const snapshot = json as Partial<LobbyStateSnapshot>;
  return {
    code: snapshot.code ?? '',
    hostId: snapshot.hostId ?? '',
    entryOpen: snapshot.entryOpen ?? true,
    pendingCount: snapshot.pendingCount ?? 0,
    participants: snapshot.participants ?? {},
    phase: snapshot.phase ?? 'lobby',
    heatIndex: snapshot.heatIndex ?? -1,
    nextHeat: snapshot.nextHeat ?? false,
    roundClockMs: snapshot.roundClockMs ?? 0,
    riders: snapshot.riders ?? {},
  };
}

/** An approach speed as sent (K1.1 step 5): a finite number above 0, or null — an approach without speed. */
function speedOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

const GEARS: ReadonlySet<unknown> = new Set<Gear>(['collected', 'extended', 'gallop']);
const LINES: ReadonlySet<unknown> = new Set<Line>(['center', 'angle']);
const MODES: ReadonlySet<unknown> = new Set<RoundMode>(['ranked', 'training']);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The rider's controls as the server sent them (K1.1 code audit r2), or null when either is not one of the closed ids. */
function controlsOf(p: Record<string, unknown>): ControlState | null {
  return GEARS.has(p.requestedGear) && LINES.has(p.line) ? { requestedGear: p.requestedGear as Gear, line: p.line as Line } : null;
}

/** A wire message into its ServerMessage shape; unknown types are dropped. */
function decode(type: string, payload: unknown): ServerMessage | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'clock-ping':
      return typeof p.serverSent === 'number' ? { type, serverSent: p.serverSent } : null;
    case 'clock-offset':
      return typeof p.offsetMs === 'number' && Number.isFinite(p.offsetMs) ? { type, offsetMs: p.offsetMs } : null;
    case 'class-course':
      return { type, course: p.course as CourseSpec, classNumber: typeof p.classNumber === 'number' ? p.classNumber : 0 };
    case 'class-phase':
      return {
        type,
        phase: p.phase as Exclude<LobbyStateSnapshot['phase'], 'lobby'>,
        heatIndex: typeof p.heatIndex === 'number' ? p.heatIndex : -1,
        startedAt: typeof p.startedAt === 'number' ? p.startedAt : 0,
        endsAt: typeof p.endsAt === 'number' ? p.endsAt : null,
      };
    case 'round-event': {
      const event = payload as Extract<ServerMessage, { type: 'round-event' }>['event'];
      if (p.type !== 'approach') return { type, event };
      // An invalid speed never drops the approach: it still arms the tap, only without speed.
      return { type, event: { ...(event as Extract<typeof event, { type: 'approach' }>), speedMps: speedOf(p.speedMps) } };
    }
    case 'approach-sync': {
      const approach = (p.approach ?? null) as Record<string, unknown> | null;
      const valid = approach !== null && typeof approach.fence === 'number' && typeof approach.attempt === 'number' && typeof approach.t0 === 'number';
      if (typeof p.classNumber !== 'number' || typeof p.heatIndex !== 'number' || (approach !== null && !valid)) return null;
      const controls = controlsOf(p);
      return {
        type,
        classNumber: p.classNumber,
        heatIndex: p.heatIndex,
        hardTurn: p.hardTurn === true,
        approach:
          approach === null
            ? null
            : { fence: approach.fence as number, attempt: approach.attempt as number, t0: approach.t0 as number, speedMps: speedOf(approach.speedMps) },
        // The controls come all together or not at all; their absence never drops the sync (K1.1 code audit r2).
        ...(controls !== null && isFiniteNumber(p.at) ? { controls: { ...controls, at: p.at } } : {}),
      };
    }
    case 'control-applied': {
      const controls = controlsOf(p);
      if (controls === null || !isFiniteNumber(p.at) || !(p.seq === null || isSeq(p.seq))) return null;
      return { type, seq: p.seq, at: p.at, ...controls };
    }
    case 'class-rules': {
      const assists = (p.assists ?? null) as Record<string, unknown> | null;
      const heightClass = p.heightClass;
      if (
        typeof p.classNumber !== 'number' ||
        !(HEIGHT_CLASSES as readonly unknown[]).includes(heightClass) ||
        !MODES.has(p.mode) ||
        assists === null ||
        typeof assists.schoolmaster !== 'boolean' ||
        typeof assists.widerWindow !== 'boolean'
      ) {
        return null;
      }
      return {
        type,
        classNumber: p.classNumber,
        heightClass: heightClass as HeightClass,
        mode: p.mode as RoundMode,
        assists: { schoolmaster: assists.schoolmaster, widerWindow: assists.widerWindow },
      };
    }
    case 'class-table':
      return { type, table: (p.table ?? {}) as Extract<ServerMessage, { type: 'class-table' }>['table'] };
    case 'refused':
      return { type, error: typeof p.error === 'string' ? p.error : 'unknown', ...(isSeq(p.seq) ? { seq: p.seq } : {}) };
    case 'emote':
      return { type, from: String(p.from ?? ''), emote: p.emote as Extract<ServerMessage, { type: 'emote' }>['emote'] };
    default:
      return null;
  }
}
