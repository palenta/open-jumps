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

  it("a close 4102 — the game opened in another window (K1.1 code audit r3) — ends as 'elsewhere' whatever the retry setting: never a drop to resume, and nothing more is sent", async () => {
    for (const autoReconnect of [true, false]) {
      const { room, session, statuses } = await connected(autoReconnect);
      room.finish(4102);
      expect(session.status).toBe('ended');
      expect(session.end).toEqual({ kind: 'elsewhere', code: 4102 });
      expect(statuses).toEqual(['connecting', 'connected', 'ended']);
      expect(await session.resume()).toBe(false);
      expect(session.send({ type: 'gear', gear: 'gallop' }, 1)).toBe(false);
    }
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
      // A server that sends no speed (K1): the approach reads as one without speed (K1.1 step 5).
      { type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: true, approach: { fence: 2, attempt: 1, t0: 61_234.5, speedMps: null } },
      { type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: false, approach: null },
    ]);
  });
});

describe('the approach speed on the wire (K1.1 step 5: speedMps)', () => {
  /** Speeds a server could send that are no speed: each decodes as an approach without speed. */
  const NO_SPEED: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5, '5', null, undefined, {}];

  it("an 'approach-sync' approach with a finite speed above 0 hands it on: 5 m/s, 7 m/s, 6.5 m/s", async () => {
    const { room, session } = await connected(true);
    const messages: ServerMessage[] = [];
    session.onMessage((message) => messages.push(message));
    for (const speedMps of [5, 7, 6.5]) room.deliver('approach-sync', { classNumber: 1, heatIndex: 0, hardTurn: false, approach: { fence: 1, attempt: 1, t0: 6_000, speedMps } });
    expect(messages.map((m) => (m.type === 'approach-sync' ? m.approach?.speedMps : 'other'))).toEqual([5, 7, 6.5]);
  });

  it("an 'approach-sync' approach whose speed is not a finite number above 0 is an approach without speed — never dropped", async () => {
    const { room, session } = await connected(true);
    const messages: ServerMessage[] = [];
    session.onMessage((message) => messages.push(message));
    for (const speedMps of NO_SPEED) room.deliver('approach-sync', { classNumber: 1, heatIndex: 0, hardTurn: false, approach: { fence: 1, attempt: 1, t0: 6_000, speedMps } });
    expect(messages).toHaveLength(NO_SPEED.length);
    for (const message of messages) expect(message).toEqual({ type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: false, approach: { fence: 1, attempt: 1, t0: 6_000, speedMps: null } });
  });

  it("the 'approach' round event hands on a finite speed above 0 as sent", async () => {
    const { room, session } = await connected(true);
    const messages: ServerMessage[] = [];
    session.onMessage((message) => messages.push(message));
    room.deliver('round-event', { type: 'approach', riderId: 'host', fence: 1, attempt: 1, t0: 6_000, speedMps: 5 });
    expect(messages).toEqual([{ type: 'round-event', event: { type: 'approach', riderId: 'host', fence: 1, attempt: 1, t0: 6_000, speedMps: 5 } }]);
  });

  it("the 'approach' round event with no speed, or one that is not a finite number above 0, arrives with speedMps null", async () => {
    const { room, session } = await connected(true);
    const messages: ServerMessage[] = [];
    session.onMessage((message) => messages.push(message));
    for (const speedMps of NO_SPEED) room.deliver('round-event', { type: 'approach', riderId: 'host', fence: 1, attempt: 1, t0: 6_000, speedMps });
    room.deliver('round-event', { type: 'approach', riderId: 'host', fence: 1, attempt: 1, t0: 6_000 });
    expect(messages).toHaveLength(NO_SPEED.length + 1);
    for (const message of messages) {
      expect(message).toEqual({ type: 'round-event', event: { type: 'approach', riderId: 'host', fence: 1, attempt: 1, t0: 6_000, speedMps: null } });
    }
  });

  it('negative: the other round events are handed on as they came (no speed is added to them)', async () => {
    const { room, session } = await connected(true);
    const messages: ServerMessage[] = [];
    session.onMessage((message) => messages.push(message));
    room.deliver('round-event', { type: 'turn-ahead', riderId: 'host', distanceM: 45, at: 9_000 });
    expect(messages).toEqual([{ type: 'round-event', event: { type: 'turn-ahead', riderId: 'host', distanceM: 45, at: 9_000 } }]);
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

describe('K1.1 code audit r2: the controls and rules the server judges with, on the wire', () => {
  /** Every message a session hands on after these payloads are delivered. */
  async function decoded(...payloads: [string, unknown][]): Promise<ServerMessage[]> {
    const { room, session } = await connected(true);
    const messages: ServerMessage[] = [];
    session.onMessage((message) => messages.push(message));
    for (const [type, payload] of payloads) room.deliver(type, payload);
    return messages;
  }

  it('send(message, seq) numbers a gear or a line command on the wire; without seq, or for any other message, the payload is as given', async () => {
    const { room, session } = await connected(true);
    expect(session.send({ type: 'gear', gear: 'gallop' }, 7)).toBe(true);
    expect(session.send({ type: 'line', line: 'angle' }, 8)).toBe(true);
    expect(session.send({ type: 'gear', gear: 'collected' })).toBe(true);
    expect(session.send({ type: 'tap', clientTime: 6000, fence: 1, attempt: 1 }, 9)).toBe(true);
    expect(room.sent).toEqual([
      { type: 'room', payload: { type: 'gear', gear: 'gallop', seq: 7 } },
      { type: 'room', payload: { type: 'line', line: 'angle', seq: 8 } },
      { type: 'room', payload: { type: 'gear', gear: 'collected' } },
      { type: 'room', payload: { type: 'tap', clientTime: 6000, fence: 1, attempt: 1 } },
    ]);
    room.drop(1006);
    expect(session.send({ type: 'gear', gear: 'extended' }, 10)).toBe(false); // nothing goes out while dropped
    expect(room.sent).toHaveLength(4);
  });

  it("'control-applied' reaches the listeners with its seq (or null), its server moment and the controls after it", async () => {
    expect(
      await decoded(
        ['control-applied', { seq: 3, at: 61_250, requestedGear: 'gallop', line: 'angle' }],
        ['control-applied', { seq: null, at: 61_300, requestedGear: 'collected', line: 'center' }],
        ['control-applied', { seq: 0, at: 61_301.5, requestedGear: 'extended', line: 'center' }],
      ),
    ).toEqual([
      { type: 'control-applied', seq: 3, at: 61_250, requestedGear: 'gallop', line: 'angle' },
      { type: 'control-applied', seq: null, at: 61_300, requestedGear: 'collected', line: 'center' },
      { type: 'control-applied', seq: 0, at: 61_301.5, requestedGear: 'extended', line: 'center' },
    ]);
  });

  it("negative: a malformed 'control-applied' is dropped — a seq that is no safe integer from 0, a moment that is no finite number, a gear or line off the list, a missing field", async () => {
    const good = { seq: 3, at: 61_250, requestedGear: 'gallop', line: 'angle' };
    const bad: unknown[] = [
      { ...good, seq: -1 },
      { ...good, seq: 1.5 },
      { ...good, seq: '3' },
      { ...good, seq: undefined },
      { ...good, at: Number.NaN },
      { ...good, at: Number.POSITIVE_INFINITY },
      { ...good, at: '61250' },
      { ...good, requestedGear: 'warp' },
      { ...good, line: 'left' },
      { seq: 3, at: 61_250, requestedGear: 'gallop' },
      null,
    ];
    expect(await decoded(...bad.map((payload): [string, unknown] => ['control-applied', payload]))).toEqual([]);
  });

  it("'refused' names the seq of the refused command when the server sent a valid one; otherwise it is { error } as before", async () => {
    expect(
      await decoded(
        ['refused', { error: 'not-riding', seq: 4 }],
        ['refused', { error: 'not-riding', seq: 0 }],
        ['refused', { error: 'not-riding' }],
        ['refused', { error: 'not-riding', seq: -2 }],
        ['refused', { error: 'clock-not-ready', seq: 'x' }],
      ),
    ).toEqual([
      { type: 'refused', error: 'not-riding', seq: 4 },
      { type: 'refused', error: 'not-riding', seq: 0 },
      { type: 'refused', error: 'not-riding' },
      { type: 'refused', error: 'not-riding' },
      { type: 'refused', error: 'clock-not-ready' },
    ]);
  });

  it("'approach-sync' hands on the rider's controls with the sync's moment; one without them, or with any of them malformed, still arms (no controls)", async () => {
    const base = { classNumber: 1, heatIndex: 0, hardTurn: false, approach: null };
    expect(
      await decoded(
        ['approach-sync', { ...base, requestedGear: 'gallop', line: 'angle', at: 70_000 }],
        ['approach-sync', base],
        ['approach-sync', { ...base, requestedGear: 'gallop', line: 'angle' }],
        ['approach-sync', { ...base, requestedGear: 'trot', line: 'angle', at: 70_000 }],
        ['approach-sync', { ...base, requestedGear: 'gallop', line: 'angle', at: Number.NaN }],
      ),
    ).toEqual([
      { type: 'approach-sync', ...base, controls: { requestedGear: 'gallop', line: 'angle', at: 70_000 } },
      { type: 'approach-sync', ...base },
      { type: 'approach-sync', ...base },
      { type: 'approach-sync', ...base },
      { type: 'approach-sync', ...base },
    ]);
  });

  it("'class-rules' reaches the listeners as sent; a malformed one is dropped", async () => {
    const rules = { classNumber: 2, heightClass: 80, mode: 'ranked', assists: { schoolmaster: true, widerWindow: false } };
    expect(
      await decoded(
        ['class-rules', rules],
        ['class-rules', { ...rules, mode: 'training', assists: { schoolmaster: false, widerWindow: true } }],
        ['class-rules', { ...rules, heightClass: 65 }],
        ['class-rules', { ...rules, mode: 'casual' }],
        ['class-rules', { ...rules, assists: { schoolmaster: 'yes', widerWindow: false } }],
        ['class-rules', { ...rules, assists: undefined }],
        ['class-rules', { ...rules, classNumber: '2' }],
      ),
    ).toEqual([
      { type: 'class-rules', ...rules },
      { type: 'class-rules', ...rules, mode: 'training', assists: { schoolmaster: false, widerWindow: true } },
    ]);
  });
});
