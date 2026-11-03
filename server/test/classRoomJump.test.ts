// Audit K1 r3 #3, in the LIVE room with a clock the test controls: one tick may cross a whole heat (walk → riding →
// results, possibly → done) — a stalled event loop, a laptop waking up. The phase events of that tick each carry
// their own heat, and the room publishes the heat that ended from its final snapshot, creating the rider entries the
// 'riding' handler of the same tick could not (the engine was already gone): the heat screen is never empty.
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ColyseusSDK, type Room as ClientRoom } from '@colyseus/sdk';
import { ColyseusTestServer } from '@colyseus/testing';
import type { CourseSpec } from '@open-jumps/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION } from '../src/auth/sessions.js';
import { CLASS_PROTOCOL, LOBBY_ROOM_NAME, LobbyRoom, type LobbyState } from '../src/colyseus/LobbyRoom.js';
import { createUpgradeGuard } from '../src/http/origin.js';
import type { ClassFlow } from '../src/round/classFlow.js';
import { RUN } from '../src/round/courseRunner.js';
import type { RoundSnapshot } from '../src/round/roundEngine.js';
import { buildServices, registerRider, uniqueRiderName, type Services } from './helpers.js';

const ORIGIN = 'https://play.open-jumps.test';
const PORT = 2596; // classRoomClock 2597, classRoom 2598, lobbyRoom 2599
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

/** One fence at 30 m on 50 m at 300 m/min: allowed 10 s, limit 20 s — every heat is over 21 s after its start. */
const COURSE: CourseSpec = { id: 'jump-test', version: 1, lengthM: 50, speedMPerMin: 300, fences: [{ number: 1, distanceM: 30, type: 'vertical' }], turns: [] };
/** A long results phase, so a jump of 25 s after the walk lands inside it (the heat ends between 10 s and 21 s). */
const TIMING = { walkMs: 500, resultsMs: 30_000, reconnectSeconds: 2 };
const HEAT_OVER_MS = 25_000;

/** The room's clock: it moves only when a test moves it (the simulation interval keeps firing on wall-clock, reading this). */
const manual = { now: 1_700_000_000_000 };

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

/**
 * A room with the host connected (clock measured against the frozen manual clock) and `absentCount` riders admitted
 * over the directory who never connect (they ride on autopilot).
 */
async function openRoom(absentCount: number) {
  const host = await registerRider(services, uniqueRiderName('Jump'));
  const entry = services.rooms.createRoom(host.account.id, { clubId: null });
  const room = await colyseus.createRoom<LobbyRoom>(LOBBY_ROOM_NAME, { code: entry.code });
  const absent = [];
  for (let i = 0; i < absentCount; i += 1) {
    const rider = await registerRider(services, uniqueRiderName('Away'), '1234', 'Nube');
    await services.rooms.requestJoin(entry.code, rider.account.id);
    services.rooms.hostAction(entry.code, host.account.id, { type: 'admit', accountId: rider.account.id });
    absent.push(rider);
  }
  const sdk = new ColyseusSDK(ENDPOINT, { headers: { cookie: `${SESSION.cookieName}=${host.token}`, origin: ORIGIN } });
  const client = await sdk.joinById<LobbyState>(room.roomId, { code: entry.code });
  const seat: Seat = { client, received: [] };
  client.onMessage('*', (type, payload) => seat.received.push({ type: String(type), payload }));
  client.onMessage('clock-ping', (ping: { serverSent: number }) => {
    seat.received.push({ type: 'clock-ping', payload: ping });
    client.send('room', { type: 'clock-pong', serverSent: ping.serverSent, clientTime: manual.now });
  });
  await until(() => seat.received.filter((m) => m.type === 'clock-ping').length >= CLASS_PROTOCOL.clockPingCount, 5000, 'the clock series');
  await sleep(100);
  const flow = (): ClassFlow => {
    const current = (room as unknown as { flow: ClassFlow | null }).flow;
    if (current === null) throw new Error('no class');
    return current;
  };
  return { host, absent, seat, flow };
}

/** Start the class; resolves on the course walk (the manual clock has not moved). */
async function startWalk(seat: Seat): Promise<void> {
  seat.client.send('room', { type: 'start-class', order: 'random' });
  await until(() => seat.client.state.phase === 'walk', 3000, "phase 'walk'");
}

/** The client's `riders` against a heat's final snapshot: the same riders, every value of the snapshot, the names. */
function expectRidersFrom(seat: Seat, final: RoundSnapshot | null, names: Map<string, { riderName: string; ponyName: string }>): void {
  if (final === null) throw new Error('the heat has no final snapshot');
  const riders = seat.client.state.riders;
  expect([...riders.keys()].sort()).toEqual(final.riders.map((r) => r.riderId).sort());
  for (const rider of final.riders) {
    expect(riders.get(rider.riderId)?.toJSON(), rider.riderId).toEqual({
      accountId: rider.riderId,
      heightClass: rider.heightClass,
      positionM: rider.positionM,
      gear: rider.gear,
      nextFence: rider.nextFence,
      attempt: rider.attempt,
      faults: rider.faults,
      status: rider.status,
      autopilot: rider.autopilot,
      lastLabel: rider.lastLabel ?? '',
      ...names.get(rider.riderId),
    });
    expect(['finished', 'eliminated']).toContain(rider.status);
  }
  expect(seat.client.state.roundClockMs).toBe(final.elapsedMs);
}

const phases = (seat: Seat) => seat.received.filter((m) => m.type === 'class-phase').map((m) => m.payload as { phase: string; heatIndex: number });

describe('one tick crosses a whole heat (audit K1 r3 #3)', () => {
  it('walk → riding → results in one tick: the heat that ended is in `riders` — every rider, the final values, the names', async () => {
    const { host, absent, seat, flow } = await openRoom(1);
    await startWalk(seat);
    manual.now += TIMING.walkMs + HEAT_OVER_MS; // ONE jump: the walk, the whole heat, into the results
    await settle();
    expect(seat.client.state.phase).toBe('results');
    expect(seat.client.state.heatIndex).toBe(0);
    expect(phases(seat)).toEqual([
      { phase: 'walk', heatIndex: 0, startedAt: expect.any(Number), endsAt: expect.any(Number) },
      { phase: 'riding', heatIndex: 0, startedAt: expect.any(Number), endsAt: null },
      { phase: 'results', heatIndex: 0, startedAt: expect.any(Number), endsAt: expect.any(Number) },
    ].map((p) => expect.objectContaining(p)));
    const names = new Map([host, ...absent].map((r) => [r.account.id, { riderName: r.account.riderName, ponyName: r.account.ponyName }]));
    expectRidersFrom(seat, flow().finalSnapshot(0), names);
    await seat.client.leave();
  }, 20000);

  it('the whole class in one tick (two heats, to done): `riders` holds the last heat as it ended, and the class table comes', async () => {
    const { host, absent, seat, flow } = await openRoom(4); // five riders: heats of three and two
    await startWalk(seat);
    manual.now += 2 * (TIMING.walkMs + HEAT_OVER_MS + TIMING.resultsMs); // ONE jump over every phase of the class
    await settle();
    expect(seat.client.state.phase).toBe('done');
    expect(flow().schedule.heats).toHaveLength(2);
    expect(seat.client.state.heatIndex).toBe(1);
    expect(phases(seat).map((p) => `${p.phase}#${String(p.heatIndex)}`)).toEqual(['walk#0', 'riding#0', 'results#0', 'walk#1', 'riding#1', 'results#1', 'done#1']);
    const names = new Map([host, ...absent].map((r) => [r.account.id, { riderName: r.account.riderName, ponyName: r.account.ponyName }]));
    expectRidersFrom(seat, flow().finalSnapshot(1), names);
    await until(() => seat.received.some((m) => m.type === 'class-table'), 2000, 'the class table');
    await seat.client.leave();
  }, 20000);
});
