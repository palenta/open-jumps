// Plan 1.5, the doorbell from the visitor's side: the host creates a room and gets the code and the live
// roomId; a visitor enters the code, rings, waits while the host decides (status polled once a second) and
// gets the roomId once admitted. A pure state machine over the API with injected timers; the UI subscribes.
import { afterEach, describe, expect, it } from 'vitest';
import { LOBBY_FLOW, LobbyFlow, normalizeCode, type LobbyFlowDeps, type LobbyPhase } from '../src/lobby/lobbyFlow.js';
import type { ApiResult, CreateRoomReply } from '../src/net/api.js';
import type { JoinDecision, RoomStatusReply } from '../src/net/types.js';

type Api = LobbyFlowDeps['api'];

interface Script {
  createRoom?: ApiResult<CreateRoomReply>[];
  knock?: ApiResult<JoinDecision>[];
  roomStatus?: ApiResult<RoomStatusReply>[];
}

interface FakeApi {
  api: Api;
  /** Every call in order, e.g. 'knock ABCDEF'. */
  calls: string[];
}

/** An API answering from scripted queues (one reply per call, in order) and recording every call. */
function fakeApi(script: Script): FakeApi {
  const calls: string[] = [];
  const queues = {
    createRoom: [...(script.createRoom ?? [])],
    knock: [...(script.knock ?? [])],
    roomStatus: [...(script.roomStatus ?? [])],
  };
  const next = <T>(queue: T[], call: string): Promise<T> => {
    calls.push(call);
    const reply = queue.shift();
    return reply === undefined ? Promise.reject(new Error(`unscripted call: ${call}`)) : Promise.resolve(reply);
  };
  const api: Api = {
    createRoom: (autoAdmitClub?: boolean) => next(queues.createRoom, autoAdmitClub === undefined ? 'createRoom' : `createRoom ${String(autoAdmitClub)}`),
    knock: (code) => next(queues.knock, `knock ${code}`),
    roomStatus: (code) => next(queues.roomStatus, `roomStatus ${code}`),
  };
  return { api, calls };
}

interface Timer {
  handle: number;
  fn: () => void;
  ms: number;
}

/** Timers fired by hand: the flow schedules one poll at a time. */
class ManualTimers {
  readonly pending: Timer[] = [];
  readonly cleared: unknown[] = [];
  private nextHandle = 1;

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const timer: Timer = { handle: this.nextHandle, fn, ms };
    this.nextHandle += 1;
    this.pending.push(timer);
    return timer.handle;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.cleared.push(handle);
    const index = this.pending.findIndex((timer) => timer.handle === handle);
    if (index >= 0) this.pending.splice(index, 1);
  };

  /** Fires the earliest pending timer. */
  fire(): void {
    const timer = this.pending.shift();
    if (timer === undefined) throw new Error('no pending timer to fire');
    timer.fn();
  }
}

/** Lets every pending promise reaction run (the flow's API replies resolve on microtasks). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Harness {
  flow: LobbyFlow;
  calls: string[];
  timers: ManualTimers;
  /** Every phase reported through onChange, in order. */
  phases: LobbyPhase[];
}

/** Every flow built in this file; a scenario that leaves a poll pending is stopped after the test. */
const flows: LobbyFlow[] = [];
afterEach(() => {
  for (const flow of flows.splice(0)) flow.stop();
});

function harness(script: Script): Harness {
  const { api, calls } = fakeApi(script);
  const timers = new ManualTimers();
  const flow = new LobbyFlow({ api, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  flows.push(flow);
  const phases: LobbyPhase[] = [];
  flow.onChange((phase) => phases.push(phase));
  return { flow, calls, timers, phases };
}

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const failed = <T>(status: number, error: string): ApiResult<T> => ({ ok: false, status, error });

const admitted = ok<JoinDecision>({ status: 'admitted' });
const pending = ok<JoinDecision>({ status: 'pending' });
const rejected = (reason: 'closed' | 'kicked' | 'full' | 'already-in'): ApiResult<JoinDecision> => ok({ status: 'rejected', reason });

const guestReady: LobbyPhase = { kind: 'ready', code: 'ABCDEF', roomId: 'r1', role: 'guest' };
const hostReady: LobbyPhase = { kind: 'ready', code: 'ABCDEF', roomId: 'r1', role: 'host' };

/**
 * Rings and lets the knock settle (and the first status check, when the knock led to one). The promise of
 * enter() comes back INSIDE an object: an async function returning a promise would adopt its state, and the
 * caller would wait for the final phase before it could fire the polls that produce it.
 */
async function ring(h: Harness, code = 'abcdef'): Promise<{ done: Promise<LobbyPhase> }> {
  const done = h.flow.enter(code);
  await settle();
  return { done };
}

/** Fires the pending poll and lets its reply settle. */
async function poll(h: Harness): Promise<void> {
  h.timers.fire();
  await settle();
}

describe('LOBBY_FLOW', () => {
  it('polls once a second for ten minutes; a code is six characters', () => {
    expect(LOBBY_FLOW).toEqual({ pollMs: 1000, maxPolls: 600, codeLength: 6 });
  });
});

describe('normalizeCode', () => {
  it('upper-cases and drops spaces and dashes', () => {
    expect(normalizeCode('ab c-def')).toBe('ABCDEF');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCode(' x7y9k2 ')).toBe('X7Y9K2');
  });

  it('keeps other characters for the server to refuse', () => {
    expect(normalizeCode('ab#cde')).toBe('AB#CDE');
  });
});

describe('LobbyFlow.create', () => {
  it('starts idle', () => {
    const h = harness({});
    expect(h.flow.phase).toEqual({ kind: 'idle' });
    expect(h.phases).toEqual([]);
  });

  it('goes creating, then ready as the host with the code and the live roomId', async () => {
    const h = harness({ createRoom: [ok({ code: 'ABCDEF', roomId: 'r1' })] });
    const result = await h.flow.create();
    expect(result).toEqual(hostReady);
    expect(h.flow.phase).toEqual(hostReady);
    expect(h.phases).toEqual([{ kind: 'creating' }, hostReady]);
    expect(h.calls).toEqual(['createRoom']);
  });

  it('a network failure (status 0) refuses with reason network and status 0', async () => {
    const h = harness({ createRoom: [failed(0, 'network')] });
    const result = await h.flow.create();
    expect(result).toMatchObject({ kind: 'refused', reason: 'network', status: 0 });
    expect(h.flow.phase).toEqual(result);
  });

  it('a server error with a known reason refuses with that reason and the HTTP status', async () => {
    const h = harness({ createRoom: [failed(429, 'rate-limited')] });
    expect(await h.flow.create()).toMatchObject({ kind: 'refused', reason: 'rate-limited', status: 429 });
  });

  it('a reply without a roomId (no live rooms) never becomes ready: it is refused as network with status 0', async () => {
    const h = harness({ createRoom: [ok({ code: 'ABCDEF' })] });
    const result = await h.flow.create();
    expect(result).toMatchObject({ kind: 'refused', reason: 'network', status: 0 });
    expect(h.phases.some((phase) => phase.kind === 'ready')).toBe(false);
  });
});

describe('LobbyFlow.enter when the knock is answered at once', () => {
  it('knocks with the normalized code and reports the knocking phase first', async () => {
    const h = harness({ knock: [admitted], roomStatus: [ok({ status: 'admitted', roomId: 'r1' })] });
    await ring(h, 'ab c-def');
    expect(h.calls[0]).toBe('knock ABCDEF');
    expect(h.phases[0]).toEqual({ kind: 'knocking', code: 'ABCDEF' });
  });

  it('admitted → status with the roomId → ready as a guest', async () => {
    const h = harness({ knock: [admitted], roomStatus: [ok({ status: 'admitted', roomId: 'r1' })] });
    const { done } = await ring(h);
    expect(await done).toEqual(guestReady);
    expect(h.calls).toEqual(['knock ABCDEF', 'roomStatus ABCDEF']);
    expect(h.phases).toEqual([{ kind: 'knocking', code: 'ABCDEF' }, guestReady]);
    expect(h.timers.pending).toEqual([]);
  });

  it('rejected closed → refused closed, without asking the status or polling', async () => {
    const h = harness({ knock: [rejected('closed')] });
    const { done } = await ring(h);
    expect(await done).toMatchObject({ kind: 'refused', code: 'ABCDEF', reason: 'closed' });
    expect(h.calls).toEqual(['knock ABCDEF']);
    expect(h.timers.pending).toEqual([]);
  });

  it('rejected full → refused full', async () => {
    const h = harness({ knock: [rejected('full')] });
    const { done } = await ring(h);
    expect(await done).toMatchObject({ kind: 'refused', code: 'ABCDEF', reason: 'full' });
  });

  it('rejected kicked → refused kicked', async () => {
    const h = harness({ knock: [rejected('kicked')] });
    const { done } = await ring(h);
    expect(await done).toMatchObject({ kind: 'refused', code: 'ABCDEF', reason: 'kicked' });
  });

  it('already-in → the flow asks the status and a visitor who rang twice is still in: ready as a guest', async () => {
    const h = harness({ knock: [rejected('already-in')], roomStatus: [ok({ status: 'admitted', roomId: 'r1' })] });
    const { done } = await ring(h);
    expect(await done).toEqual(guestReady);
    expect(h.calls).toEqual(['knock ABCDEF', 'roomStatus ABCDEF']);
  });

  it('already-in as the host → ready as the host', async () => {
    const h = harness({ knock: [rejected('already-in')], roomStatus: [ok({ status: 'host', roomId: 'r1' })] });
    const { done } = await ring(h);
    expect(await done).toEqual(hostReady);
  });

  it('a knock refused as unknown-code (404) → refused unknown-code 404', async () => {
    const h = harness({ knock: [failed(404, 'unknown-code')] });
    const { done } = await ring(h);
    expect(await done).toEqual({ kind: 'refused', code: 'ABCDEF', reason: 'unknown-code', status: 404 });
  });

  it('a knock refused as rate-limited (429) → refused rate-limited 429', async () => {
    const h = harness({ knock: [failed(429, 'rate-limited')] });
    const { done } = await ring(h);
    expect(await done).toEqual({ kind: 'refused', code: 'ABCDEF', reason: 'rate-limited', status: 429 });
  });

  it('a knock that never got an answer (status 0) → refused network 0', async () => {
    const h = harness({ knock: [failed(0, 'network')] });
    const { done } = await ring(h);
    expect(await done).toEqual({ kind: 'refused', code: 'ABCDEF', reason: 'network', status: 0 });
  });
});

describe('LobbyFlow.enter while the host decides', () => {
  it('pending → waiting with zero polls and one poll scheduled after pollMs, the status not asked yet', async () => {
    const h = harness({ knock: [pending] });
    await ring(h);
    expect(h.flow.phase).toEqual({ kind: 'waiting', code: 'ABCDEF', polls: 0 });
    expect(h.phases).toEqual([{ kind: 'knocking', code: 'ABCDEF' }, { kind: 'waiting', code: 'ABCDEF', polls: 0 }]);
    expect(h.calls).toEqual(['knock ABCDEF']);
    expect(h.timers.pending.map((timer) => timer.ms)).toEqual([LOBBY_FLOW.pollMs]);
  });

  it('the poll asks the status; still pending → waiting with one poll and the next poll scheduled', async () => {
    const h = harness({ knock: [pending], roomStatus: [ok({ status: 'pending' })] });
    await ring(h);
    await poll(h);
    expect(h.calls).toEqual(['knock ABCDEF', 'roomStatus ABCDEF']);
    expect(h.flow.phase).toEqual({ kind: 'waiting', code: 'ABCDEF', polls: 1 });
    expect(h.phases.at(-1)).toEqual({ kind: 'waiting', code: 'ABCDEF', polls: 1 });
    expect(h.timers.pending.map((timer) => timer.ms)).toEqual([LOBBY_FLOW.pollMs]);
  });

  it('admitted with a roomId on a poll → ready as a guest, no further poll, and enter() settles with that phase', async () => {
    const h = harness({ knock: [pending], roomStatus: [ok({ status: 'pending' }), ok({ status: 'admitted', roomId: 'r1' })] });
    const { done } = await ring(h);
    await poll(h);
    await poll(h);
    expect(h.flow.phase).toEqual(guestReady);
    expect(h.timers.pending).toEqual([]);
    expect(await done).toEqual(guestReady);
  });

  it('host with a roomId on a poll → ready as the host', async () => {
    const h = harness({ knock: [pending], roomStatus: [ok({ status: 'host', roomId: 'r1' })] });
    await ring(h);
    await poll(h);
    expect(h.flow.phase).toEqual(hostReady);
  });

  it('kicked on a poll → refused kicked', async () => {
    const h = harness({ knock: [pending], roomStatus: [ok({ status: 'kicked' })] });
    await ring(h);
    await poll(h);
    expect(h.flow.phase).toMatchObject({ kind: 'refused', code: 'ABCDEF', reason: 'kicked' });
    expect(h.timers.pending).toEqual([]);
  });

  it('none on a poll (the host said no) → refused denied', async () => {
    const h = harness({ knock: [pending], roomStatus: [ok({ status: 'none' })] });
    await ring(h);
    await poll(h);
    expect(h.flow.phase).toMatchObject({ kind: 'refused', code: 'ABCDEF', reason: 'denied' });
    expect(h.timers.pending).toEqual([]);
  });

  it('a poll refused as unknown-code (404) → refused unknown-code 404', async () => {
    const h = harness({ knock: [pending], roomStatus: [failed(404, 'unknown-code')] });
    await ring(h);
    await poll(h);
    expect(h.flow.phase).toEqual({ kind: 'refused', code: 'ABCDEF', reason: 'unknown-code', status: 404 });
    expect(h.timers.pending).toEqual([]);
  });

  it('after maxPolls pending polls → refused timeout, with exactly maxPolls status calls and no poll left', async () => {
    const replies = Array.from({ length: LOBBY_FLOW.maxPolls }, () => ok<RoomStatusReply>({ status: 'pending' }));
    const h = harness({ knock: [pending], roomStatus: replies });
    await ring(h);
    let fired = 0;
    while (h.timers.pending.length > 0 && fired < LOBBY_FLOW.maxPolls + 1) {
      await poll(h);
      fired += 1;
    }
    expect(h.flow.phase).toMatchObject({ kind: 'refused', code: 'ABCDEF', reason: 'timeout' });
    expect(h.calls.filter((call) => call.startsWith('roomStatus'))).toHaveLength(LOBBY_FLOW.maxPolls);
    expect(h.timers.pending).toEqual([]);
  });

  it('stop() cancels the scheduled poll with its handle and keeps the phase', async () => {
    const h = harness({ knock: [pending] });
    await ring(h);
    const handle = h.timers.pending[0]?.handle;
    expect(handle).toBeDefined();
    h.flow.stop();
    expect(h.timers.cleared).toEqual([handle]);
    expect(h.timers.pending).toEqual([]);
    expect(h.flow.phase).toEqual({ kind: 'waiting', code: 'ABCDEF', polls: 0 });
    expect(h.calls).toEqual(['knock ABCDEF']);
  });
});

describe('LobbyFlow.onChange', () => {
  it('fires for every phase in order and the returned function unsubscribes', async () => {
    const { api } = fakeApi({ createRoom: [ok({ code: 'ABCDEF', roomId: 'r1' })] });
    const timers = new ManualTimers();
    const flow = new LobbyFlow({ api, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const kept: LobbyPhase[] = [];
    const dropped: LobbyPhase[] = [];
    flow.onChange((phase) => kept.push(phase));
    const unsubscribe = flow.onChange((phase) => dropped.push(phase));
    unsubscribe();
    await flow.create();
    expect(kept).toEqual([{ kind: 'creating' }, hostReady]);
    expect(dropped).toEqual([]);
  });
});
