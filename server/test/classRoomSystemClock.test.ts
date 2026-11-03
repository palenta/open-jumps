// Audit K1 r5 #1, the incident itself: the live room on the production defaults (no game clock, no time sources
// injected) while the system's calendar clock is stepped under it — Date.now() goes back by 200 ms every 250 ms and
// jumps an hour forward and an hour back, as NTP or macOS `timed` (settimeofday) do; performance.now() is left alone,
// as a real step leaves it. On the Mac a single step back of 65 ms made RoundEngine.tick throw 'tick goes backwards'
// out of the simulation interval: nothing caught it and the server process exited with every room in it. Here two
// rooms ride a class each through the steps: nothing may escape to the process, both heats finish on their riders'
// own times (never on a time limit an hour ahead), and the results carry the calendar date of the stepped wall.
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ColyseusSDK, type Room as ClientRoom } from '@colyseus/sdk';
import { ColyseusTestServer } from '@colyseus/testing';
import type { CourseSpec } from '@open-jumps/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION } from '../src/auth/sessions.js';
import { CLASS_PROTOCOL, LOBBY_ROOM_NAME, LobbyRoom, type LobbyState } from '../src/colyseus/LobbyRoom.js';
import { createUpgradeGuard } from '../src/http/origin.js';
import { buildServices, registerRider, uniqueRiderName, type Services } from './helpers.js';

const ORIGIN = 'https://play.open-jumps.test';
const PORT = 2594; // classRoomWallClock 2595, classRoomJump 2596, classRoomClock 2597, classRoom 2598, lobbyRoom 2599
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

/** One fence at 15 m on 25 m at 300 m/min (5 m/s): a passive rider jumps by herself and crosses the line at ~5 s; allowed 5 s. */
const COURSE: CourseSpec = { id: 'system-clock-test', version: 1, lengthM: 25, speedMPerMin: 300, fences: [{ number: 1, distanceM: 15, type: 'vertical' }], turns: [] };
const TIMING = { walkMs: 500, resultsMs: 500, reconnectSeconds: 2 };
const HOUR_MS = 3_600_000;

/** The real calendar clock, and how far the test has stepped the process's Date.now() away from it. */
const realNow = Date.now.bind(Date);
let wallShiftMs = 0;
/** Everything that escaped to the process: a throw out of the simulation interval lands here (and kills a real server). */
const escaped: unknown[] = [];
const onEscape = (error: unknown): void => {
  escaped.push(error);
};

let colyseus: ColyseusTestServer;
let services: Services;

beforeAll(async () => {
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + wallShiftMs);
  services = buildServices();
  // The production defaults: neither `clock` nor `time` — the room composes its game clock from the system's clocks.
  LobbyRoom.configure({
    sessions: services.sessions,
    accounts: services.accounts,
    rooms: services.rooms,
    allowedOrigins: [ORIGIN],
    results: services.repos.results,
    course: () => COURSE,
    timing: TIMING,
  });
  // As in app.ts: the server never hooks the process, so a throw that escapes a room reaches the process itself.
  const gameServer = new Server({ transport: new WebSocketTransport({ beforeUpgrade: createUpgradeGuard([ORIGIN]) }), gracefullyShutdown: false });
  gameServer.define(LOBBY_ROOM_NAME, LobbyRoom);
  await gameServer.listen(PORT);
  colyseus = new ColyseusTestServer(gameServer);
});

afterAll(async () => {
  vi.restoreAllMocks();
  process.off('uncaughtException', onEscape);
  process.off('unhandledRejection', onEscape);
  await colyseus?.shutdown();
  await services?.repos.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`${what}: not met within ${ms} ms`);
    await sleep(20);
  }
}

interface Seat {
  client: ClientRoom<LobbyState>;
  code: string;
  hostId: string;
  received: { type: string; payload: unknown }[];
}

/** A room with one rider (the host), connected, who answers every clock ping from a device clock of her own. */
async function openRoom(): Promise<Seat> {
  const host = await registerRider(services, uniqueRiderName('System'));
  const entry = services.rooms.createRoom(host.account.id, { clubId: null });
  const room = await colyseus.createRoom<LobbyRoom>(LOBBY_ROOM_NAME, { code: entry.code });
  const sdk = new ColyseusSDK(ENDPOINT, { headers: { cookie: `${SESSION.cookieName}=${host.token}`, origin: ORIGIN } });
  const client = await sdk.joinById<LobbyState>(room.roomId, { code: entry.code });
  const seat: Seat = { client, code: entry.code, hostId: host.account.id, received: [] };
  client.onMessage('*', (type, payload) => seat.received.push({ type: String(type), payload }));
  client.onMessage('clock-ping', (ping: { serverSent: number }) => {
    seat.received.push({ type: 'clock-ping', payload: ping });
    client.send('room', { type: 'clock-pong', serverSent: ping.serverSent, clientTime: performance.now() + 1_000_000 });
  });
  await until(() => seat.received.filter((m) => m.type === 'clock-ping').length >= CLASS_PROTOCOL.clockPingCount, 5000, 'the clock series');
  return seat;
}

describe('the system clock steps under the live room (audit K1 r5 #1)', () => {
  it('Date.now() goes back 200 ms every 250 ms and an hour each way: nothing escapes, both rooms finish their heats on their own times, results carry the stepped calendar date', async () => {
    const seats = [await openRoom(), await openRoom()];
    for (const seat of seats) seat.client.send('room', { type: 'start-class', order: 'random' });
    await until(() => seats.every((seat) => seat.client.state.phase === 'walk'), 3000, "both rooms in 'walk'");

    const stepper = setInterval(() => {
      wallShiftMs -= 200;
    }, 250);
    try {
      await until(() => seats.every((seat) => seat.client.state.phase === 'riding'), 3000, "both rooms in 'riding'");
      await sleep(1_000);
      wallShiftMs += HOUR_MS; // forward an hour in the middle of the heat
      await sleep(1_000);
      wallShiftMs -= 2 * HOUR_MS; // and back two hours
      await until(() => seats.every((seat) => seat.client.state.phase === 'done'), 15_000, "both rooms in 'done'");
    } finally {
      clearInterval(stepper);
    }

    expect(escaped).toEqual([]);
    for (const seat of seats) {
      const [row] = await services.repos.results.listByRound(`${seat.code}-1#0`);
      // A passive run of ~5 s, finished: never eliminated on a time limit the forward hour would have brought.
      expect(row).toMatchObject({ accountId: seat.hostId, status: 'finished', eliminationReason: null });
      expect(row?.timeMs).toBeGreaterThan(4_500);
      expect(row?.timeMs).toBeLessThan(6_000);
      // recordedAt is the calendar date the system believed when the heat ended: the stepped wall (now an hour and some
      // behind the real clock), never a game time.
      expect(Math.abs((row?.recordedAt ?? 0) - Date.now())).toBeLessThan(5_000);
      expect(realNow() - (row?.recordedAt ?? 0)).toBeGreaterThan(HOUR_MS - 60_000);
      await seat.client.leave();
    }
  }, 40000);
});
