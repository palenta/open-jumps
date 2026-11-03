// RoomSession against a scripted SDK room (no server): the exact order of the SDK 0.18.9 callbacks that the live
// tests cannot time — a drop that starts the SDK's own retries, a resume() while they run, the final onLeave once
// they are exhausted (audit K1 r1 #4), and the reconnectionToken the SDK assigns only AFTER its onReconnect
// callback has returned (audit K1 r1 #10). The manual path (autoReconnect off: dropped → resume() by token) stays.
import { describe, expect, it } from 'vitest';
import { ClientClock } from '../src/net/clientClock.js';
import { RoomSession, type RoomLike, type SdkLike, type SessionStatus } from '../src/net/roomSession.js';
import type { LobbyStateSnapshot, ServerMessage } from '../src/net/types.js';

const state = (over: Partial<LobbyStateSnapshot> = {}): LobbyStateSnapshot => ({
  code: 'ABCDEF',
  hostId: 'host',
  entryOpen: true,
  pendingCount: 0,
  participants: {},
  phase: 'lobby',
  heatIndex: -1,
  nextHeat: false,
  roundClockMs: 0,
  riders: {},
  ...over,
});

/** A room as the SDK hands it out: callbacks the test fires in the SDK's own order. */
class FakeRoom implements RoomLike {
  roomId = 'r1';
  sessionId = 's1';
  reconnectionToken: string;
  state: unknown;
  reconnection: RoomLike['reconnection'] = { enabled: true, isReconnecting: false };
  private readonly stateListeners: ((state: unknown) => void)[] = [];
  private readonly leaveListeners: ((code: number, reason?: string) => void)[] = [];
  private readonly dropListeners: ((code: number, reason?: string) => void)[] = [];
  private readonly reconnectListeners: (() => void)[] = [];
  readonly sent: unknown[] = [];
  leaves = 0;

  constructor(token: string, initial: LobbyStateSnapshot | null = state()) {
    this.reconnectionToken = `r1:${token}`;
    this.state = initial;
  }

  onStateChange(callback: (state: unknown) => void): void {
    this.stateListeners.push(callback);
  }

  private messageListener: ((type: string | number, payload: unknown) => void) | null = null;

  onMessage(_type: '*', callback: (type: string | number, payload: unknown) => void): void {
    this.messageListener = callback;
  }

  /** A server message reaches the room's wildcard handler. */
  deliver(type: string, payload: unknown): void {
    this.messageListener?.(type, payload);
  }

  onLeave(callback: (code: number, reason?: string) => void): void {
    this.leaveListeners.push(callback);
  }

  onDrop(callback: (code: number, reason?: string) => void): void {
    this.dropListeners.push(callback);
  }

  onReconnect(callback: () => void): void {
    this.reconnectListeners.push(callback);
  }

  send(type: string, payload?: unknown): void {
    this.sent.push({ type, payload });
  }

  leave(): Promise<number> {
    this.leaves += 1;
    this.finish(4000);
    return Promise.resolve(4000);
  }

  /** The socket closed with a retriable code: the SDK tells onDrop, then starts retrying (isReconnecting). */
  drop(code: number): void {
    for (const listener of [...this.dropListeners]) listener(code);
    if (this.reconnection.enabled) this.reconnection.isReconnecting = true;
    else this.finish(code);
  }

  /** The SDK gave up (or the server closed for good): isReconnecting off, then onLeave once. */
  finish(code: number): void {
    this.reconnection.isReconnecting = false;
    for (const listener of [...this.leaveListeners]) listener(code);
  }

  /** A retry succeeded: exactly as SDK 0.18.9 — onReconnect fires FIRST, the new token is assigned after it returned. */
  reconnected(newToken: string): void {
    this.reconnection.isReconnecting = false;
    try {
      for (const listener of [...this.reconnectListeners]) listener();
    } finally {
      this.reconnectionToken = `r1:${newToken}`;
    }
  }
}

class FakeSdk implements SdkLike {
  readonly rooms: FakeRoom[] = [];
  readonly reconnectCalls: string[] = [];
  /** The room the next reconnect() hands out (null: the server refuses). */
  nextReconnect: FakeRoom | null = null;

  joinById(): Promise<RoomLike> {
    const room = new FakeRoom('t1');
    this.rooms.push(room);
    return Promise.resolve(room);
  }

  reconnect(token: string): Promise<RoomLike> {
    this.reconnectCalls.push(token);
    const room = this.nextReconnect;
    if (room === null) return Promise.reject(new Error('reconnection refused'));
    this.rooms.push(room);
    return Promise.resolve(room);
  }
}

async function connected(autoReconnect: boolean): Promise<{ sdk: FakeSdk; room: FakeRoom; session: RoomSession; statuses: SessionStatus[] }> {
  const sdk = new FakeSdk();
  const session = new RoomSession({ sdk, clock: new ClientClock(() => 1000), autoReconnect });
  const statuses: SessionStatus[] = [];
  session.onStatus((status) => statuses.push(status));
  await session.connect('r1', 'ABCDEF');
  const room = sdk.rooms[0];
  if (!room) throw new Error('no room');
  expect(session.status).toBe('connected');
  return { sdk, room, session, statuses };
}

const microtask = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

describe('RoomSession with the SDK retrying by itself (autoReconnect on, audit K1 r1 #4)', () => {
  it('a drop → dropped; the tab returns during the retries → resume() is false and no manual reconnect is tried; the retries exhausted → ended as lost', async () => {
    const { sdk, room, session, statuses } = await connected(true);
    expect(room.reconnection.enabled).toBe(true);
    room.drop(1006);
    expect(session.status).toBe('dropped');
    expect(session.end).toBeNull();
    expect(await session.resume()).toBe(false); // the SDK is on it
    expect(sdk.reconnectCalls).toEqual([]);
    expect(session.status).toBe('dropped');
    room.finish(4003); // FAILED_TO_RECONNECT: the SDK's last retry was refused
    expect(session.status).toBe('ended');
    expect(session.end).toEqual({ kind: 'lost', code: 4003 });
    expect(statuses).toEqual(['connecting', 'connected', 'dropped', 'ended']);
    expect(await session.resume()).toBe(false); // nothing left to resume: the app connects afresh
    expect(sdk.reconnectCalls).toEqual([]);
  });

  it('a final close with no drop before it (the SDK refuses to retry: uptime too short) ends the session as lost at once', async () => {
    const { room, session } = await connected(true);
    room.finish(1006);
    expect(session.status).toBe('ended');
    expect(session.end).toEqual({ kind: 'lost', code: 1006 });
  });

  it('kicked and revoked closes keep their own kinds whatever the retry setting', async () => {
    const kicked = await connected(true);
    kicked.room.finish(4100);
    expect(kicked.session.end).toEqual({ kind: 'kicked', code: 4100 });
    const revoked = await connected(true);
    revoked.room.finish(4101);
    expect(revoked.session.end).toEqual({ kind: 'revoked', code: 4101 });
  });

  it('a retry that succeeds → connected again, with the status told once', async () => {
    const { room, session, statuses } = await connected(true);
    room.drop(1001);
    room.reconnected('t2');
    expect(session.status).toBe('connected');
    expect(statuses).toEqual(['connecting', 'connected', 'dropped', 'connected']);
  });
});

describe('RoomSession with the SDK retries off (autoReconnect off): the manual path', () => {
  it('a drop → dropped, not ended; resume() reconnects by the token and the new room is adopted', async () => {
    const { sdk, room, session, statuses } = await connected(false);
    expect(room.reconnection.enabled).toBe(false);
    room.drop(4005); // with retries off the SDK ends the room: onLeave right away
    expect(session.status).toBe('dropped');
    expect(session.end).toBeNull();
    sdk.nextReconnect = new FakeRoom('t2');
    expect(await session.resume()).toBe(true);
    expect(sdk.reconnectCalls).toEqual(['r1:t1']);
    expect(session.status).toBe('connected');
    expect(session.reconnectionToken).toBe('r1:t2');
    expect(statuses).toEqual(['connecting', 'connected', 'dropped', 'connecting', 'connected']);
  });

  it('a refused manual reconnect ends the session as lost', async () => {
    const { sdk, room, session } = await connected(false);
    room.drop(4005);
    sdk.nextReconnect = null;
    expect(await session.resume()).toBe(false);
    expect(session.end).toEqual({ kind: 'lost', code: 0 });
  });
});

describe('the reconnection token after the SDK reconnected by itself (audit K1 r1 #10)', () => {
  it('two automatic recoveries: after each one the public token is the one the SDK assigned AFTER its onReconnect callback', async () => {
    const { room, session } = await connected(true);
    expect(session.reconnectionToken).toBe('r1:t1');
    room.drop(1001);
    room.reconnected('t2');
    await microtask();
    expect(session.reconnectionToken).toBe('r1:t2');
    room.drop(1001);
    room.reconnected('t3');
    await microtask();
    expect(session.reconnectionToken).toBe('r1:t3');
  });

  it('a manual resume() reads the room\'s current token at that moment, never a copy taken earlier', async () => {
    const { sdk, room, session } = await connected(false);
    // The SDK renewed the token behind the session's back (as it does after its own reconnection).
    room.reconnectionToken = 'r1:fresh';
    expect(session.reconnectionToken).toBe('r1:fresh');
    room.drop(4005);
    sdk.nextReconnect = new FakeRoom('t2');
    expect(await session.resume()).toBe(true);
    expect(sdk.reconnectCalls).toEqual(['r1:fresh']);
  });
});

describe("the 'approach-sync' message (audit K1 r2 #1)", () => {
  it('reaches the listeners typed, with or without an approach; a malformed one is dropped', async () => {
    const { room, session } = await connected(true);
    const messages: ServerMessage[] = [];
    session.onMessage((message) => messages.push(message));
    room.deliver('approach-sync', { classNumber: 1, heatIndex: 0, hardTurn: true, approach: { fence: 2, attempt: 1, t0: 61_234.5 } });
    room.deliver('approach-sync', { classNumber: 1, heatIndex: 0, hardTurn: false, approach: null });
    room.deliver('approach-sync', { classNumber: 1, heatIndex: 0, hardTurn: false, approach: { fence: 2 } });
    room.deliver('approach-sync', { heatIndex: 0, approach: null });
    expect(messages).toEqual([
      { type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: true, approach: { fence: 2, attempt: 1, t0: 61_234.5 } },
      { type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: false, approach: null },
    ]);
  });
});

describe('RoomSession.send tells whether the message went out (audit K1 r3 #1)', () => {
  const tap = { type: 'tap', clientTime: 6000, fence: 1, attempt: 1 } as const;

  it('connected: handed to the room, true; dropped (the SDK retrying): nothing handed to the room, false; recovered: true again', async () => {
    const { room, session } = await connected(true);
    expect(session.send(tap)).toBe(true);
    room.drop(1006);
    expect(session.status).toBe('dropped');
    expect(session.send(tap)).toBe(false);
    room.reconnected('t2');
    expect(session.status).toBe('connected');
    expect(session.send(tap)).toBe(true);
    expect(room.sent).toEqual([
      { type: 'room', payload: tap },
      { type: 'room', payload: tap },
    ]);
  });

  it('connecting (resume() under way) and ended: false, nothing handed to any room', async () => {
    const { sdk, room, session } = await connected(false);
    room.drop(1006);
    const next = new FakeRoom('t2');
    sdk.nextReconnect = next;
    const resumed = session.resume();
    expect(session.status).toBe('connecting');
    expect(session.send(tap)).toBe(false);
    expect(await resumed).toBe(true);
    await session.leave();
    expect(session.status).toBe('ended');
    expect(session.send(tap)).toBe(false);
    expect([...room.sent, ...next.sent].filter((m) => (m as { type: string }).type === 'room')).toEqual([]);
  });
});
