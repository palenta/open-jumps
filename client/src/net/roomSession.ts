// The live room from the client's side (plan 2.2, 2.3): joinById with the roomId the doorbell handed out, the
// state as plain snapshots, every server message typed, clock pings answered from the ClientClock, and the
// reconnection path for Safari's silent socket drops on screen lock — with the SDK's own retries on, the SDK
// reconnects by itself while the tab lives and the session reports the outcome (connected again, or lost for good
// once the retries are exhausted); with them off, resume() reconnects by the reconnection token on
// visibilitychange / pageshow.
import type { CourseSpec } from '@open-jumps/shared';
import type { ClientClock } from './clientClock.js';
import { KICKED_CLOSE_CODE, SESSION_REVOKED_CLOSE_CODE, type ClientRoomMessage, type LobbyStateSnapshot, type ServerMessage } from './types.js';

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
export type SessionEnd = { kind: 'kicked' | 'revoked' | 'left' | 'lost'; code: number };

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
 * - Every 'clock-ping' is answered at once with clock.onPing(serverSent) as the 'room' message.
 * - state: the latest snapshot (state.toJSON()); onState fires after every patch.
 * - Messages reach onMessage listeners as ServerMessage ('round-event' carries the event under `event`);
 *   'class-course' is also remembered as course(); a malformed 'approach-sync' is dropped.
 * - A leave code 4100 → ended 'kicked', 4101 → 'revoked', a consented leave → 'left'. Any other close: with the
 *   SDK's retries ON, the SDK's onDrop makes the status 'dropped' and the SDK retries by itself — a successful
 *   retry → 'connected', and the final onLeave once the retries are exhausted (or refused at once: uptime too
 *   short, a server close the SDK never retries) ends the session as 'lost' (audit K1 r1 #4: never a 'dropped'
 *   that nothing will ever change); with them OFF the close is a drop: status 'dropped', waiting for resume().
 * - resume(): when dropped and the SDK is not retrying, reconnect by the room's CURRENT token; resolves true when
 *   connected afterwards (also when it already was), false when the server refused (then the session ends as
 *   'lost') or when the SDK is still retrying (its outcome comes as the next status).
 * - reconnectionToken: always the room's current one — the SDK renews it on every reconnection, right after its
 *   onReconnect callback, so the stored copy is refreshed a microtask later too (audit K1 r1 #10).
 * - send() while dropped is dropped silently (a rider command is useless late; the server has autopilot).
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

  send(message: ClientRoomMessage): void {
    if (this.currentStatus !== 'connected' || this.room === null) return;
    this.room.send('room', message);
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
    roundClockMs: snapshot.roundClockMs ?? 0,
    riders: snapshot.riders ?? {},
  };
}

/** A wire message into its ServerMessage shape; unknown types are dropped. */
function decode(type: string, payload: unknown): ServerMessage | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'clock-ping':
      return typeof p.serverSent === 'number' ? { type, serverSent: p.serverSent } : null;
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
    case 'round-event':
      return { type, event: payload as Extract<ServerMessage, { type: 'round-event' }>['event'] };
    case 'approach-sync': {
      const approach = (p.approach ?? null) as Record<string, unknown> | null;
      const valid = approach !== null && typeof approach.fence === 'number' && typeof approach.attempt === 'number' && typeof approach.t0 === 'number';
      if (typeof p.classNumber !== 'number' || typeof p.heatIndex !== 'number' || (approach !== null && !valid)) return null;
      return {
        type,
        classNumber: p.classNumber,
        heatIndex: p.heatIndex,
        hardTurn: p.hardTurn === true,
        approach: approach === null ? null : { fence: approach.fence as number, attempt: approach.attempt as number, t0: approach.t0 as number },
      };
    }
    case 'class-table':
      return { type, table: (p.table ?? {}) as Extract<ServerMessage, { type: 'class-table' }>['table'] };
    case 'refused':
      return { type, error: typeof p.error === 'string' ? p.error : 'unknown' };
    case 'emote':
      return { type, from: String(p.from ?? ''), emote: p.emote as Extract<ServerMessage, { type: 'emote' }>['emote'] };
    default:
      return null;
  }
}
