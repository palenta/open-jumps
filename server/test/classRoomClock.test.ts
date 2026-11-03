// Audit B2, P3: the deadline millisecond in the LIVE room, with a clock the test controls. The room simulates
// only completed milliseconds (tickClass → flow.tick(clock() − 1)), so a packet stamped with the deadline T is
// judged the same whether its callback ran before or after the tick that happened while the clock read T:
// nothing is fixed at T until the clock has moved past it. The late packet (clock already past T) is ignored.
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ColyseusSDK, type Room as ClientRoom } from '@colyseus/sdk';
import { ColyseusTestServer } from '@colyseus/testing';
import type { CourseSpec } from '@open-jumps/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION } from '../src/auth/sessions.js';
import { CLASS_PROTOCOL, LOBBY_ROOM_NAME, LobbyRoom, type LobbyState } from '../src/colyseus/LobbyRoom.js';
import { createUpgradeGuard } from '../src/http/origin.js';
import { RUN } from '../src/round/courseRunner.js';
import { buildServices, registerRider, uniqueRiderName, type Services } from './helpers.js';

const ORIGIN = 'https://play.open-jumps.test';
const PORT = 2597; // classRoom 2598, lobbyRoom 2599
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

/** One fence at 30 m (t0 = start + 6000 at 5 m/s, deadline t0 + 700), no turn, nothing else. */
const COURSE: CourseSpec = { id: 'clock-test', version: 1, lengthM: 50, speedMPerMin: 300, fences: [{ number: 1, distanceM: 30, type: 'vertical' }], turns: [] };
const TIMING = { walkMs: 500, resultsMs: 500, reconnectSeconds: 2 };

/** The room's clock: it moves only when a test moves it (the simulation interval keeps firing on wall-clock, reading this). */
const manual = { now: 1_700_000_000_000 };
/** This device's clock runs 5 s ahead of the server's: every clientTime it sends must be translated. */
const SKEW_MS = 5000;
const DEADLINE_MS = 700; // t0 + NO_TAP_LIMIT (400) + the packet age allowance (300)

let colyseus: ColyseusTestServer;
let services: Services;

beforeAll(async () => {
  services = buildServices();
  LobbyRoom.configure({
    sessions: services.sessions,
    accounts: services.accounts,
    rooms: services.rooms,
    allowedOrigins: [ORIGIN],
    results: services.repos.results,
    course: () => COURSE,
    timing: TIMING,
    clock: () => manual.now,
  });
  const gameServer = new Server({ transport: new WebSocketTransport({ beforeUpgrade: createUpgradeGuard([ORIGIN]) }) });
  gameServer.define(LOBBY_ROOM_NAME, LobbyRoom);
  await gameServer.listen(PORT);
  colyseus = new ColyseusTestServer(gameServer);
});

afterAll(async () => {
  await colyseus?.shutdown();
  await services?.repos.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough for the simulation interval (RUN.tickMs on wall-clock) to have run at least twice and the patches to arrive. */
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
  received: { type: string; payload: unknown }[];
}

type Approach = { fence: number; attempt: number; t0: number };
type Takeoff = { decidedAt: number; offsetMs: number | null; outcome: { kind: string; faults: number } };

const eventsOf = (seat: Seat, type: string) =>
  seat.received.filter((m) => m.type === 'round-event').map((m) => m.payload as Record<string, unknown>).filter((e) => e.type === type);

/** A room with one rider (the host), connected, clocks measured against the frozen manual clock (RTT 0 → the offset is exact). */
async function openRoom(): Promise<{ seat: Seat; roomId: string }> {
  const host = await registerRider(services, uniqueRiderName('Clock'));
  const entry = services.rooms.createRoom(host.account.id, { clubId: null });
  const room = await colyseus.createRoom<LobbyRoom>(LOBBY_ROOM_NAME, { code: entry.code });
  const sdk = new ColyseusSDK(ENDPOINT, { headers: { cookie: `${SESSION.cookieName}=${host.token}`, origin: ORIGIN } });
  const client = await sdk.joinById<LobbyState>(room.roomId, { code: entry.code });
  const seat: Seat = { client, received: [] };
  client.onMessage('*', (type, payload) => seat.received.push({ type: String(type), payload }));
  client.onMessage('clock-ping', (ping: { serverSent: number }) => {
    seat.received.push({ type: 'clock-ping', payload: ping });
    client.send('room', { type: 'clock-pong', serverSent: ping.serverSent, clientTime: manual.now + SKEW_MS });
  });
  await until(() => seat.received.filter((m) => m.type === 'clock-ping').length >= CLASS_PROTOCOL.clockPingCount, 5000, 'the clock series');
  await sleep(100);
  return { seat, roomId: room.roomId };
}

/** Start the class and move the clock to the approach of fence 1; returns its t0 (server time). */
async function rideToApproach(seat: Seat): Promise<Approach> {
  seat.client.send('room', { type: 'start-class', order: 'random' });
  await until(() => seat.client.state.phase === 'walk', 3000, "phase 'walk'");
  manual.now += TIMING.walkMs + 100; // the walk is over on the manual clock
  await settle();
  expect(seat.client.state.phase).toBe('riding');
  manual.now += 3700; // zone at 18 m = 3.6 s after the start: the approach event fires in this tick
  await settle();
  const approach = eventsOf(seat, 'approach')[0] as Approach | undefined;
  if (!approach) throw new Error('no approach event');
  return approach;
}

const tap = (seat: Seat, approach: Approach, actionServerTime: number) =>
  seat.client.send('room', { type: 'tap', clientTime: actionServerTime + SKEW_MS, fence: approach.fence, attempt: approach.attempt });

describe('the deadline millisecond in the live room (controlled clock)', () => {
  it('order A — the packet arrives while the clock reads T, before any tick could see T: judged at T as "close" with offset +400', async () => {
    const { seat } = await openRoom();
    const approach = await rideToApproach(seat);
    const T = approach.t0 + DEADLINE_MS;
    manual.now = T; // the clock reads T; the tick for T itself cannot run yet (only T − 1 is complete)
    tap(seat, approach, approach.t0 + 400); // stamped T on receipt, action exactly t0 + 400 (the last "close" moment)
    await settle();
    expect(eventsOf(seat, 'takeoff')).toEqual([]); // nothing is fixed while T is the current millisecond
    manual.now = T + 1;
    await settle();
    const takeoffs = eventsOf(seat, 'takeoff') as unknown as Takeoff[];
    expect(takeoffs).toHaveLength(1);
    expect(takeoffs[0]).toMatchObject({ decidedAt: T, offsetMs: 400, outcome: { kind: 'chip', faults: 4 } });
  }, 20000);

  it('order B — the tick for T − 1 ran while the clock read T, THEN the packet arrives: the same verdict, the same decidedAt', async () => {
    const { seat } = await openRoom();
    const approach = await rideToApproach(seat);
    const T = approach.t0 + DEADLINE_MS;
    manual.now = T;
    await settle(); // ticks ran with the clock at T: they simulated up to T − 1 and fixed nothing
    expect(eventsOf(seat, 'takeoff')).toEqual([]);
    tap(seat, approach, approach.t0 + 400); // received at T, after those ticks
    await settle();
    expect(eventsOf(seat, 'takeoff')).toEqual([]);
    manual.now = T + 1;
    await settle();
    const takeoffs = eventsOf(seat, 'takeoff') as unknown as Takeoff[];
    expect(takeoffs).toHaveLength(1);
    expect(takeoffs[0]).toMatchObject({ decidedAt: T, offsetMs: 400, outcome: { kind: 'chip', faults: 4 } });
  }, 20000);

  it('late — the clock is already past T when the packet arrives: "no tap" was fixed at T; the packet is ignored', async () => {
    const { seat } = await openRoom();
    const approach = await rideToApproach(seat);
    const T = approach.t0 + DEADLINE_MS;
    manual.now = T + 1;
    await settle(); // T is complete: "no tap" is fixed at T
    const fixed = eventsOf(seat, 'takeoff') as unknown as Takeoff[];
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ decidedAt: T, offsetMs: null, outcome: { kind: 'chip' } }); // a good line: the horse jumps by itself, a rail
    tap(seat, approach, approach.t0 + 400); // received at T + 1: after the deadline
    manual.now = T + 200;
    await settle();
    expect(eventsOf(seat, 'takeoff')).toHaveLength(1); // no second take-off, no exception
    const [rider] = [...seat.client.state.riders.values()];
    expect(rider?.faults).toBe(4); // the rail of the self-jump, nothing from the ignored packet
  }, 20000);
});
