// The live room from the client's side (plan 2.2, 2.3): joinById with the roomId the doorbell handed out, the
// state as plain snapshots, every server message typed, clock pings answered from the ClientClock, and the
// reconnection path for Safari's silent socket drops on screen lock — the SDK retries by itself while the tab
// lives; when it has given up (or auto-reconnection is off), resume() reconnects by the reconnection token
// on visibilitychange / pageshow.
import type { CourseSpec } from '@open-jumps/shared';
import type { ClientClock } from './clientClock.js';
import { KICKED_CLOSE_CODE, SESSION_REVOKED_CLOSE_CODE, type ClientRoomMessage, type LobbyStateSnapshot, type ServerMessage } from './types.js';

/** The slice of a Colyseus SDK Room the session uses (ColyseusSDK's Room satisfies it). */
export interface RoomLike {
  roomId: string;
  sessionId: string;
  reconnectionToken: string;
  state: unknown;
  reconnection: { enabled: boolean; isReconnecting?: boolean };
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
}

/** How long the first full state may take after the join resolved. */
const FIRST_STATE_TIMEOUT_MS = 5000;

/**
 * - connect(): joinById(roomId, { code }); resolves once the first full state (code ≠ '') has arrived, with every
 *   handler in place (a message is never missed between join and subscription).
 * - Every 'clock-ping' is answered at once with clock.onPing(serverSent) as the 'room' message.
 * - state: the latest snapshot (state.toJSON()); onState fires after every patch.
 * - Messages reach onMessage listeners as ServerMessage ('round-event' carries the event under `event`);
 *   'class-course' is also remembered as course().
 * - A leave code 4100 → ended 'kicked', 4101 → 'revoked', a consented leave → 'left'; any other close is a
 *   drop: status 'dropped' (the SDK keeps retrying when autoReconnect; a successful retry → 'connected').
 * - resume(): when dropped and the SDK is not retrying, reconnect by token; resolves true when connected
 *   afterwards (also when it already was), false when the server refused (then the session ends as 'lost').
 * - send() while dropped is dropped silently (a rider command is useless late; the server has autopilot).
 */
export class RoomSession {
  private readonly sdk: SdkLike;
  private readonly clock: ClientClock;
  private readonly autoReconnect: boolean;
  private room: RoomLike | null = null;
  private snapshot: LobbyStateSnapshot | null = null;
  private currentStatus: SessionStatus = 'idle';
  private currentEnd: SessionEnd | null = null;
  private currentCourse: CourseSpec | null = null;
  /** The token of the last connection, kept through a drop for resume(). */
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
    if (this.currentStatus !== 'dropped' || this.token === null) return false;
    if (this.room?.reconnection.isReconnecting) return false; // the SDK is still on it; the next status says
    this.setStatus('connecting');
    let room: RoomLike;
    try {
      room = await this.sdk.reconnect(this.token);
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
    return this.token;
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
      if (this.room === room) {
        this.token = room.reconnectionToken;
        this.setStatus('connected');
      }
    });
    room.onLeave((code) => {
      if (this.room !== room || this.currentStatus === 'ended') return;
      if (code === KICKED_CLOSE_CODE) this.finish({ kind: 'kicked', code });
      else if (code === SESSION_REVOKED_CLOSE_CODE) this.finish({ kind: 'revoked', code });
      else if (this.leaving) this.finish({ kind: 'left', code });
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
      return { type, phase: p.phase as Exclude<LobbyStateSnapshot['phase'], 'lobby'>, heatIndex: typeof p.heatIndex === 'number' ? p.heatIndex : -1 };
    case 'round-event':
      return { type, event: payload as Extract<ServerMessage, { type: 'round-event' }>['event'] };
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
