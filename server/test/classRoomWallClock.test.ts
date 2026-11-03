// Audit K1 r5 #1, in the LIVE room with the production composition of the game clock and both of its sources under
// the test's control: the wall (calendar) clock and the monotonic clock. The room is configured with these sources
// only — no ready-made game clock — so it composes its game clock exactly as in production (the wall read once, at
// configure, plus the monotonic time elapsed since). The test then steps the wall back and forward the way NTP or
// macOS `timed` (settimeofday) does, while the monotonic clock only moves forward: nothing of the game may notice.
// A step back of 65 ms once made RoundEngine.tick throw 'tick goes backwards' out of the simulation interval and the
// whole server process exited; a step forward ends walks early and eliminates heats on their time limit; a step
// between a tick and a command, or inside a ping/pong, moves a receive time or biases a clock offset.
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ColyseusSDK, type Room as ClientRoom } from '@colyseus/sdk';
import { ColyseusTestServer } from '@colyseus/testing';
import { PACKET, type CourseSpec } from '@open-jumps/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION } from '../src/auth/sessions.js';
import { CLASS_PROTOCOL, LOBBY_ROOM_NAME, LobbyRoom, type LobbyState } from '../src/colyseus/LobbyRoom.js';
import { createUpgradeGuard } from '../src/http/origin.js';
import { RUN } from '../src/round/courseRunner.js';
import { OUTBOX } from '../src/round/resultOutbox.js';
import type { ResultRecord, ResultRepository } from '../src/storage/repositories.js';
import { buildServices, registerRider, uniqueRiderName, type Services } from './helpers.js';

const ORIGIN = 'https://play.open-jumps.test';
const PORT = 2595; // classRoomJump 2596, classRoomClock 2597, classRoom 2598, lobbyRoom 2599
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

/** One fence at 30 m (t0 = start + 6000 at 5 m/s, deadline t0 + 700), no turn: a passive rider crosses the line at ~10.1 s. */
const COURSE: CourseSpec = { id: 'wall-clock-test', version: 1, lengthM: 50, speedMPerMin: 300, fences: [{ number: 1, distanceM: 30, type: 'vertical' }], turns: [] };
const TIMING = { walkMs: 500, resultsMs: 500, reconnectSeconds: 2 };
/** Every device here runs 5 s ahead of the server: every clientTime it sends must be translated with the measured offset. */
const SKEW_MS = 5000;
const DEADLINE_MS = PACKET.lastActionOffsetMs + PACKET.marginMs; // 700 after t0
const HOUR_MS = 3_600_000;

/**
 * The two sources the room composes its game clock from. Both stay still unless the test moves them: `advance` moves
 * the monotonic clock and the wall together (time passing), `stepWall` moves the wall alone (the system setting its
 * date). The simulation interval keeps firing on Node's own timers and reads the composed clock at every tick.
 */
const WALL_START = 1_700_000_000_000;
const MONOTONIC_START = 42_000.25; // performance.now() is fractional; the game clock is whole milliseconds
const wall = { now: WALL_START };
const monotonic = { now: MONOTONIC_START };
const advance = (ms: number): void => {
  monotonic.now += ms;
  wall.now += ms;
};
const stepWall = (ms: number): void => {
  wall.now += ms;
};
/** The production composition, as the room made it at configure: the wall read once plus the monotonic time elapsed. */
const gameNow = (): number => Math.floor(WALL_START + (monotonic.now - MONOTONIC_START));
/** Move time on until the game clock reads `target` (never back). */
const advanceTo = (target: number): void => {
  const delta = target - gameNow();
  if (delta < 0) throw new Error(`the game clock never goes back (${target} < ${gameNow()})`);
  advance(delta);
};

let colyseus: ColyseusTestServer;
let services: Services;
/** How many of the next insertOnce calls must fail (storage trouble the outbox has to retry). */
let failInserts = 0;
let insertCalls: string[] = [];
/** Everything that escaped to the process: a throw out of the simulation interval lands here (and would kill a server). */
const escaped: unknown[] = [];
const onEscape = (error: unknown): void => {
  escaped.push(error);
};

beforeAll(async () => {
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);
  services = buildServices();
  const results: ResultRepository = {
    insertOnce: async (record) => {
      insertCalls.push(`${record.roundId}|${record.accountId}`);
      if (failInserts > 0) {
        failInserts -= 1;
        throw new Error('storage unavailable (test)');
      }
      return services.repos.results.insertOnce(record);
    },
    get: (roundId, accountId) => services.repos.results.get(roundId, accountId),
    listByRound: (roundId) => services.repos.results.listByRound(roundId),
    listByAccount: (accountId) => services.repos.results.listByAccount(accountId),
  };
  LobbyRoom.configure({
    sessions: services.sessions,
    accounts: services.accounts,
    rooms: services.rooms,
    allowedOrigins: [ORIGIN],
    results,
    course: () => COURSE,
    timing: TIMING,
    // The sources only, never a ready-made game clock: the room composes it as production does.
    time: { wall: () => wall.now, monotonic: () => monotonic.now },
  });
  // As in app.ts: the server never hooks the process, so a throw that escapes a room reaches the process itself.
  const gameServer = new Server({ transport: new WebSocketTransport({ beforeUpgrade: createUpgradeGuard([ORIGIN]) }), gracefullyShutdown: false });
  gameServer.define(LOBBY_ROOM_NAME, LobbyRoom);
  await gameServer.listen(PORT);
  colyseus = new ColyseusTestServer(gameServer);
});

beforeEach(() => {
  failInserts = 0;
  insertCalls = [];
  escaped.length = 0;
});

afterEach(() => {
  // Whatever a test did to the wall, nothing may have escaped the room.
  expect(escaped).toEqual([]);
});

afterAll(async () => {
  process.off('uncaughtException', onEscape);
  process.off('unhandledRejection', onEscape);
  await colyseus?.shutdown();
  await services?.repos.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough for the simulation interval (RUN.tickMs on Node's timers) to have run at least twice and the patches to arrive. */
const settle = () => sleep(RUN.tickMs * 3 + 60);
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what}: not met within ${ms} ms`);
    await sleep(20);
  }
}

interface Seat {
  client: ClientRoom<LobbyState>;
  code: string;
  hostId: string;
  received: { type: string; payload: unknown }[];
}

type Approach = { fence: number; attempt: number; t0: number };
type Takeoff = { decidedAt: number; offsetMs: number | null; outcome: { kind: string; faults: number } };
type Phase = { phase: string; heatIndex: number; startedAt: number; endsAt: number | null };

const eventsOf = (seat: Seat, type: string) =>
  seat.received.filter((m) => m.type === 'round-event').map((m) => m.payload as Record<string, unknown>).filter((e) => e.type === type);
const phasesOf = (seat: Seat) => seat.received.filter((m) => m.type === 'class-phase').map((m) => m.payload as Phase);
const pingsOf = (seat: Seat) => seat.received.filter((m) => m.type === 'clock-ping').map((m) => m.payload as { serverSent: number });
const offsetsOf = (seat: Seat) => seat.received.filter((m) => m.type === 'clock-offset').map((m) => (m.payload as { offsetMs: number }).offsetMs);

/**
 * A room with one rider (the host), connected; every 'clock-ping' is answered with the device's clock, SKEW_MS ahead of
 * the game clock (the monotonic clock is still while the series runs: RTT 0, so the measured offset is exactly SKEW_MS).
 * `beforePong` runs right before each answer leaves — a test steps the wall there.
 */
async function openRoom(beforePong: (index: number) => void = () => {}): Promise<Seat> {
  const host = await registerRider(services, uniqueRiderName('Wall'));
  const entry = services.rooms.createRoom(host.account.id, { clubId: null });
  const room = await colyseus.createRoom<LobbyRoom>(LOBBY_ROOM_NAME, { code: entry.code });
  const sdk = new ColyseusSDK(ENDPOINT, { headers: { cookie: `${SESSION.cookieName}=${host.token}`, origin: ORIGIN } });
  const client = await sdk.joinById<LobbyState>(room.roomId, { code: entry.code });
  const seat: Seat = { client, code: entry.code, hostId: host.account.id, received: [] };
  let pongs = 0;
  client.onMessage('*', (type, payload) => seat.received.push({ type: String(type), payload }));
  client.onMessage('clock-ping', (ping: { serverSent: number }) => {
    seat.received.push({ type: 'clock-ping', payload: ping });
    beforePong(pongs);
    pongs += 1;
    client.send('room', { type: 'clock-pong', serverSent: ping.serverSent, clientTime: gameNow() + SKEW_MS });
  });
  await until(() => pingsOf(seat).length >= CLASS_PROTOCOL.clockPingCount, 5000, 'the clock series');
  await until(() => offsetsOf(seat).length > 0, 2000, 'the clock offset');
  await sleep(100);
  return seat;
}

/** Start the class and move time to the approach of fence 1; returns its t0 (game time). */
async function rideToApproach(seat: Seat): Promise<Approach> {
  seat.client.send('room', { type: 'start-class', order: 'random' });
  await until(() => seat.client.state.phase === 'walk', 3000, "phase 'walk'");
  advance(TIMING.walkMs + 100);
  await settle();
  expect(seat.client.state.phase).toBe('riding');
  advance(3700); // the zone at 18 m opens 3.6 s after the start: the approach event fires in this tick
  await settle();
  const approach = eventsOf(seat, 'approach')[0] as Approach | undefined;
  if (!approach) throw new Error('no approach event');
  return approach;
}

/** A tap whose moment is `actionGameTime` on the game clock, sent with the device's clock reading of that moment. */
const tap = (seat: Seat, approach: Approach, actionGameTime: number) =>
  seat.client.send('room', { type: 'tap', clientTime: actionGameTime + SKEW_MS, fence: approach.fence, attempt: approach.attempt });

/** Move time on in steps of `stepMs` until `done()` (the simulation sees every step), at most `maxMs` of game time. */
async function rideUntil(done: () => boolean, maxMs: number, stepMs = 1000): Promise<void> {
  for (let ridden = 0; !done(); ridden += stepMs) {
    if (ridden > maxMs) throw new Error(`not done within ${maxMs} ms of game time`);
    advance(stepMs);
    await settle();
  }
}

describe('the wall clock steps, the game clock goes on (audit K1 r5 #1)', () => {
  it('steps back (65 ms, 200 ms, an hour) and forward (an hour) during the walk and the heat: the phases keep the game time, the heat finishes, another room lives on', async () => {
    const seat = await openRoom();
    const other = await openRoom();
    seat.client.send('room', { type: 'start-class', order: 'random' });
    other.client.send('room', { type: 'start-class', order: 'random' });
    await until(() => seat.client.state.phase === 'walk' && other.client.state.phase === 'walk', 3000, "both rooms in 'walk'");
    const walk = phasesOf(seat).find((p) => p.phase === 'walk');
    expect(walk?.endsAt).toBe((walk?.startedAt ?? 0) + TIMING.walkMs);

    // The walk: the wall goes back by the 65 ms macOS `timed` once stepped it, then forward by an hour — the walk
    // neither ends early nor lasts an hour longer, and no tick throws.
    stepWall(-65);
    await settle();
    stepWall(HOUR_MS);
    await settle();
    expect(seat.client.state.phase).toBe('walk');
    advanceTo((walk?.endsAt ?? 0) - 1); // the walk's last millisecond is the current one: not complete yet
    await settle();
    expect(seat.client.state.phase).toBe('walk');
    stepWall(-2 * HOUR_MS);
    advanceTo((walk?.endsAt ?? 0) + 1);
    await settle();
    expect(seat.client.state.phase).toBe('riding');
    const riding = phasesOf(seat).find((p) => p.phase === 'riding');
    expect(riding?.startedAt).toBe(walk?.endsAt); // the heat starts exactly when the walk's game time ends

    // The heat: more steps both ways; a passive rider finishes on her own time (~10.1 s), never on a time limit.
    for (const step of [-200, HOUR_MS, -200, -HOUR_MS]) {
      stepWall(step);
      advance(1000);
      await settle();
      expect(seat.client.state.riders.get(seat.hostId)?.status).toBe('riding');
    }
    // A step of time may cross the results phase too: the phase messages say what happened.
    const ended = (s: Seat) => phasesOf(s).some((p) => p.phase === 'results');
    await rideUntil(() => ended(seat) && ended(other), 15_000);
    const results = phasesOf(seat).find((p) => p.phase === 'results');
    const finish = eventsOf(seat, 'finish')[0] as { at: number; elapsedMs: number } | undefined;
    expect(finish?.elapsedMs).toBeGreaterThan(10_000);
    expect(finish?.elapsedMs).toBeLessThan(10_500);
    expect(finish?.at).toBe((riding?.startedAt ?? 0) + (finish?.elapsedMs ?? 0)); // the game time of the line, nothing of the wall
    expect(results?.startedAt).toBe(finish?.at);
    expect(seat.client.state.riders.get(seat.hostId)?.status).toBe('finished');

    // recordedAt is a calendar date: the wall's reading when the heat's results were recorded (the last advance moved
    // the wall too, nothing stepped it since), which the steps above moved away from the game clock.
    const [row] = await services.repos.results.listByRound(`${seat.code}-1#0`);
    expect(row).toMatchObject({ accountId: seat.hostId, status: 'finished', timeMs: finish?.elapsedMs, recordedAt: wall.now });
    expect(row?.recordedAt).not.toBe(gameNow());
    expect(wall.now - gameNow()).toBe(-65 + HOUR_MS - 2 * HOUR_MS - 200 + HOUR_MS - 200 - HOUR_MS);

    // Both rooms go on to the end of the class.
    advance(TIMING.resultsMs + 100);
    await settle();
    expect(seat.client.state.phase).toBe('done');
    expect(other.client.state.phase).toBe('done');
    await seat.client.leave();
    await other.client.leave();
  }, 40000);

  it('a step between a tick and the receipt of a tap: the packet age is measured on the game clock (300 ms is in, 301 ms is out), whichever way the wall went', async () => {
    // Exactly PACKET.maxAgeMs old on the game clock, with the wall stepped forward between the tick and the receipt:
    // accepted, the perfect moment (a wall-based receive time would make it 500 ms old and 'too-old').
    {
      const seat = await openRoom();
      const approach = await rideToApproach(seat);
      advanceTo(approach.t0 + PACKET.maxAgeMs);
      await settle(); // the ticks ran with the game clock at t0 + 300: up to t0 + 299, nothing decided
      stepWall(200);
      tap(seat, approach, approach.t0);
      await settle();
      advance(1);
      await settle();
      const takeoffs = eventsOf(seat, 'takeoff') as unknown as Takeoff[];
      expect(takeoffs).toHaveLength(1);
      expect(takeoffs[0]).toMatchObject({ decidedAt: approach.t0 + PACKET.maxAgeMs, offsetMs: 0 });
      await seat.client.leave();
    }
    // One millisecond older on the game clock, with the wall stepped back: ignored as too old, "no tap" at the deadline
    // (a wall-based receive time would make it 101 ms old and the perfect take-off — and the next tick would throw).
    {
      const seat = await openRoom();
      const approach = await rideToApproach(seat);
      advanceTo(approach.t0 + PACKET.maxAgeMs + 1);
      await settle();
      stepWall(-200);
      tap(seat, approach, approach.t0);
      await settle();
      expect(eventsOf(seat, 'takeoff')).toEqual([]);
      advanceTo(approach.t0 + DEADLINE_MS + 1);
      await settle();
      const takeoffs = eventsOf(seat, 'takeoff') as unknown as Takeoff[];
      expect(takeoffs).toHaveLength(1);
      expect(takeoffs[0]).toMatchObject({ decidedAt: approach.t0 + DEADLINE_MS, offsetMs: null });
      await seat.client.leave();
    }
  }, 40000);

  it('a step between a tick and the receipt at the deadline millisecond: the same verdicts as with a still wall (classRoomClock.test.ts)', async () => {
    // Order B of the deadline test: the tick for T − 1 ran while the game clock read T, the wall steps back, then the
    // packet arrives — stamped T, judged at T: "close" with offset +400.
    {
      const seat = await openRoom();
      const approach = await rideToApproach(seat);
      const T = approach.t0 + DEADLINE_MS;
      advanceTo(T);
      await settle();
      expect(eventsOf(seat, 'takeoff')).toEqual([]);
      stepWall(-300);
      tap(seat, approach, approach.t0 + 400);
      await settle();
      expect(eventsOf(seat, 'takeoff')).toEqual([]); // nothing is fixed while T is the current millisecond
      advance(1);
      await settle();
      const takeoffs = eventsOf(seat, 'takeoff') as unknown as Takeoff[];
      expect(takeoffs).toHaveLength(1);
      expect(takeoffs[0]).toMatchObject({ decidedAt: T, offsetMs: 400, outcome: { kind: 'chip', faults: 4 } });
      await seat.client.leave();
    }
    // Late: the game clock is past T, "no tap" is fixed at T; the wall steps back before the packet arrives — it is
    // still after the deadline and ignored (a wall-based stamp would date it before T).
    {
      const seat = await openRoom();
      const approach = await rideToApproach(seat);
      const T = approach.t0 + DEADLINE_MS;
      advanceTo(T + 1);
      await settle();
      const fixed = eventsOf(seat, 'takeoff') as unknown as Takeoff[];
      expect(fixed).toHaveLength(1);
      expect(fixed[0]).toMatchObject({ decidedAt: T, offsetMs: null, outcome: { kind: 'chip' } });
      stepWall(-500);
      tap(seat, approach, approach.t0 + 400);
      advance(200);
      await settle();
      expect(eventsOf(seat, 'takeoff')).toHaveLength(1);
      expect(seat.client.state.riders.get(seat.hostId)?.faults).toBe(4);
      await seat.client.leave();
    }
  }, 40000);

  it('a step inside every ping/pong: the round trip and the offset are measured on the game clock — exactly the skew — and a tap translates exactly', async () => {
    // Before every answer leaves the wall steps: back, forward, an hour each way… A wall-based round trip would be
    // negative (discarded), an hour (discarded) or 150 ms (kept, the offset off by 75 ms).
    const steps = [-200, 150, HOUR_MS, -HOUR_MS, -65, 65, 150, -150];
    const seat = await openRoom((index) => stepWall(steps[index % steps.length] ?? 0));
    expect(offsetsOf(seat)).toEqual([SKEW_MS]);
    const approach = await rideToApproach(seat);
    advanceTo(approach.t0 + 50);
    await settle();
    stepWall(-1_000);
    tap(seat, approach, approach.t0); // the device's reading of t0 itself
    await settle();
    advance(1);
    await settle();
    const takeoffs = eventsOf(seat, 'takeoff') as unknown as Takeoff[];
    expect(takeoffs).toHaveLength(1);
    expect(takeoffs[0]).toMatchObject({ decidedAt: approach.t0 + 50, offsetMs: 0 });
    await seat.client.leave();
  }, 40000);

  it('the result outbox retries on the game clock: a wall stepped back an hour does not hold a row for an hour, one stepped forward does not hurry the retry', async () => {
    const outbox = LobbyRoom.outbox;
    if (!outbox) throw new Error('no outbox');
    const record = (roundId: string): ResultRecord => ({
      roundId, accountId: 'acc-wall', courseId: COURSE.id, courseVersion: 1, rulesVersion: 1, heightClass: 60, faults: 0, timeMs: 10_000,
      status: 'finished', eliminationReason: null, autopilot: false, schoolmaster: false, mode: 'ranked', seed: 's', recordedAt: wall.now,
    });
    // Stepped back: the first write fails, the wall goes back an hour, OUTBOX.retryMs of time passes → the row lands.
    failInserts = 1;
    outbox.add([record('wall-back#0')]);
    await outbox.flush();
    expect(insertCalls).toEqual(['wall-back#0|acc-wall']);
    stepWall(-HOUR_MS);
    advance(OUTBOX.retryMs);
    await outbox.flush();
    expect(insertCalls).toEqual(['wall-back#0|acc-wall', 'wall-back#0|acc-wall']);
    expect(outbox.size).toBe(0);
    expect(await services.repos.results.get('wall-back#0', 'acc-wall')).not.toBeNull();

    // Stepped forward: right after a failure the wall jumps an hour — no attempt before OUTBOX.retryMs of time has passed.
    insertCalls = [];
    failInserts = 1;
    outbox.add([record('wall-forward#0')]);
    await outbox.flush();
    stepWall(HOUR_MS);
    await outbox.flush();
    advance(OUTBOX.retryMs - 1);
    await outbox.flush();
    expect(insertCalls).toEqual(['wall-forward#0|acc-wall']);
    advance(1);
    await outbox.flush();
    expect(insertCalls).toEqual(['wall-forward#0|acc-wall', 'wall-forward#0|acc-wall']);
    expect(outbox.size).toBe(0);
  });
});
