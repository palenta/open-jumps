// Part B2 in the live room (plan 1.7, 2.3; matrix rows 3, 5, 8, 9, 20): the host starts a class, phases follow
// the class flow, only riders of the running heat drive — and only their own horse — taps are translated with the
// measured clock offset (every client here runs a skewed clock, so a raw client time would be rejected) and judged
// on the server; a dropped connection puts the horse on autopilot until the rider is back — with the token, or by
// a fresh join, also after the reservation expired, also twice; a heat goes on with nobody connected until the
// time limit; a kick or a session revocation kills a pending reconnection; results are written once per rider
// with the round seed, and the class ends with one table.
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ColyseusSDK, type Room as ClientRoom } from '@colyseus/sdk';
import { ColyseusTestServer } from '@colyseus/testing';
import type { CourseSpec } from '@open-jumps/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION } from '../src/auth/sessions.js';
import { CLASS_PROTOCOL, LOBBY_ROOM_NAME, LobbyRoom, type ClassTableRowWire, type LobbyState } from '../src/colyseus/LobbyRoom.js';
import { createUpgradeGuard } from '../src/http/origin.js';
import { RUN } from '../src/round/courseRunner.js';
import type { ResultRepository } from '../src/storage/repositories.js';
import { ADMIN_KEY, buildServices, registerRider, uniqueRiderName, type Services } from './helpers.js';

const ORIGIN = 'https://play.open-jumps.test';
const PORT = 2598; // lobbyRoom.test.ts uses 2599; test files run in parallel
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

// Every course here runs at the club norm (300 m/min = 5 m/s in collected canter); times below assume a passive rider.
/** One fence, no turn: a passive rider lands a chip at 6.7 s and crosses the line at 10.1 s (allowed 10 s → 1 time fault). */
const LIVE_COURSE: CourseSpec = { id: 'live-test', version: 1, lengthM: 50, speedMPerMin: 300, fences: [{ number: 1, distanceM: 30, type: 'vertical' }], turns: [] };
/** One fence far out: its zone opens at 38 m (7.6 s) — room for a drop, an expired reservation and a rejoin before the approach. */
const LATE_FENCE_COURSE: CourseSpec = { id: 'live-late-fence', version: 1, lengthM: 80, speedMPerMin: 300, fences: [{ number: 1, distanceM: 50, type: 'vertical' }], turns: [] };
/**
 * Three fences over 120 m: horses dropped at ~1 s ride on autopilot until ~11 s (RUN.autopilotMaxMs), clear fences 1 and
 * 2 and stop at fence 3's zone (88 m, reached at 17.6 s); the time allowed is 24 s, the limit 48 s.
 */
const LONG_COURSE: CourseSpec = {
  id: 'live-long',
  version: 1,
  lengthM: 120,
  speedMPerMin: 300,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 60, type: 'vertical' },
    { number: 3, distanceM: 100, type: 'vertical' },
  ],
  turns: [],
};
/** Short phases; a 2 s reconnection window so an expiry can be waited for in real time (Colyseus's timer is wall-clock). */
const TIMING = { walkMs: 500, resultsMs: 500, reconnectSeconds: 2 };

/** The room clock is Date.now() + jumpMs: a test may advance it, and only while no client of its room is connected. */
let jumpMs = 0;
const serverNow = () => Date.now() + jumpMs;
/** The course of each room, by room code (LIVE_COURSE unless a test registers another). */
const courseByCode = new Map<string, CourseSpec>();

let colyseus: ColyseusTestServer;
let services: Services;

/** How many of the next insertOnce calls must fail (storage trouble the room has to survive and retry). */
let failInserts = 0;
let insertCalls: { roundId: string; accountId: string }[] = [];

beforeAll(async () => {
  services = buildServices();
  const results: ResultRepository = {
    insertOnce: async (record) => {
      insertCalls.push({ roundId: record.roundId, accountId: record.accountId });
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
    course: (code) => courseByCode.get(code) ?? LIVE_COURSE,
    timing: TIMING,
    clock: serverNow,
  });
  const gameServer = new Server({ transport: new WebSocketTransport({ beforeUpgrade: createUpgradeGuard([ORIGIN]) }) });
  gameServer.define(LOBBY_ROOM_NAME, LobbyRoom);
  await gameServer.listen(PORT);
  colyseus = new ColyseusTestServer(gameServer);
});

beforeEach(() => {
  jumpMs = 0;
  failInserts = 0;
  insertCalls = [];
});

afterAll(async () => {
  await colyseus?.shutdown();
  await services?.repos.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}: not met within ${ms} ms`);
    await sleep(25);
  }
}
/** The clock series of a fresh connection is complete (CLASS_PROTOCOL pings plus a margin). */
const clocksSynced = () => sleep(CLASS_PROTOCOL.clockPingCount * CLASS_PROTOCOL.clockPingEveryMs + 400);

/** A browser-like SDK: the HttpOnly cookie and the Origin travel as headers. */
const sdk = (token: string) => new ColyseusSDK(ENDPOINT, { headers: { cookie: `${SESSION.cookieName}=${token}`, origin: ORIGIN } });

type Rider = Awaited<ReturnType<typeof registerRider>>;

interface Seat {
  id: string;
  token: string;
  /** This device's clock minus the server's (a real browser never knows it; the room has to measure it). May change mid-session. */
  skewMs: number;
  /** While true the device ignores clock pings (a stalled tab); may be flipped by a scenario. */
  muted: boolean;
  client: ClientRoom<LobbyState>;
  received: { type: string; payload: unknown }[];
}

interface SitOptions {
  /** Never answers the clock pings: the session's clock never becomes ready. */
  mute?: boolean;
  /** Fixed offset of this device's clock; used for the clock pongs AND for every clientTime it sends. */
  skewMs?: number;
}

/** The first full state a joined client holds (joinById resolves on JOIN_ROOM, before ROOM_STATE arrives). */
async function firstState(client: ClientRoom<LobbyState>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    let snapshot: Record<string, unknown> | undefined;
    try {
      snapshot = (client.state as { toJSON?: () => Record<string, unknown> } | undefined)?.toJSON?.();
    } catch {
      snapshot = undefined;
    }
    if (snapshot && typeof snapshot.code === 'string' && snapshot.code !== '') return;
    await sleep(10);
  }
  throw new Error('no lobby state arrived within 3 s');
}

/**
 * Join as a browser would and answer the clock pings from this device's (possibly skewed) clock. Every message lands
 * in `received` (the SDK dispatches to the specific handler OR the wildcard, so the ping handler records too); the
 * seat is handed back only once its first full state has arrived, with all handlers already in place.
 */
async function sit(roomId: string, code: string, token: string, id: string, options: SitOptions = {}): Promise<Seat> {
  const client = await sdk(token).joinById<LobbyState>(roomId, { code });
  const received: Seat['received'] = [];
  const seat: Seat = { id, token, skewMs: options.skewMs ?? 0, muted: options.mute ?? false, client, received };
  client.onMessage('*', (type, payload) => received.push({ type: String(type), payload }));
  client.onMessage('clock-ping', (ping: { serverSent: number }) => {
    received.push({ type: 'clock-ping', payload: ping });
    if (!seat.muted) client.send('room', { type: 'clock-pong', serverSent: ping.serverSent, clientTime: Date.now() + seat.skewMs });
  });
  await firstState(client);
  return seat;
}
const clockPings = (seat: Seat) => seat.received.filter((m) => m.type === 'clock-ping');

/** What this device's clock reads now — the only clock a client has. */
const clientTime = (seat: Seat) => Date.now() + seat.skewMs;

const refusals = (seat: Seat) => seat.received.filter((m) => m.type === 'refused').map((m) => (m.payload as { error: string }).error);
const roundEvents = (seat: Seat, type: string, riderId?: string) =>
  seat.received
    .filter((m) => m.type === 'round-event')
    .map((m) => m.payload as Record<string, unknown>)
    .filter((e) => e.type === type && (riderId === undefined || e.riderId === riderId));
const phaseMessages = (seat: Seat) => seat.received.filter((m) => m.type === 'class-phase').map((m) => m.payload as { phase: string; heatIndex: number });
const classTable = (seat: Seat) => seat.received.find((m) => m.type === 'class-table')?.payload as { table: Record<string, ClassTableRowWire[]> } | undefined;

/** True when `expected` appears in `actual` in this order (other messages may sit in between). */
function inOrder(actual: { phase: string; heatIndex: number }[], expected: { phase: string; heatIndex: number }[]): boolean {
  let i = 0;
  for (const message of actual) {
    const next = expected[i];
    if (next && message.phase === next.phase && message.heatIndex === next.heatIndex) i += 1;
  }
  return i === expected.length;
}

type ApproachEvent = { t0: number; fence: number; attempt: number };
type TakeoffEvent = { offsetMs: number | null; outcome: { kind: string; faults: number } };

/** A room with `riderCount` admitted riders (the host first), riding `course`. */
async function openRoom(riderCount: number, course: CourseSpec = LIVE_COURSE) {
  const host = await registerRider(services, uniqueRiderName('Host'));
  const entry = services.rooms.createRoom(host.account.id, { clubId: null });
  courseByCode.set(entry.code, course);
  const room = await colyseus.createRoom<LobbyRoom>(LOBBY_ROOM_NAME, { code: entry.code });
  const riders: Rider[] = [host];
  for (let i = 1; i < riderCount; i += 1) {
    const rider = await registerRider(services, uniqueRiderName('Rider'));
    await services.rooms.requestJoin(entry.code, rider.account.id);
    services.rooms.hostAction(entry.code, host.account.id, { type: 'admit', accountId: rider.account.id });
    riders.push(rider);
  }
  return { entry, room, riders, roundId: (heatIndex: number) => `${entry.code}-1#${heatIndex}` };
}

/** The host starts the class; resolves once the first heat is riding. */
async function startRiding(hostSeat: Seat, order: 'random' | 'lowest-class-first' = 'random'): Promise<void> {
  hostSeat.client.send('room', { type: 'start-class', order });
  await until(() => hostSeat.client.state.phase === 'riding', 5000, "phase 'riding'");
}

/** Tap at the server's t0 as a client would: wait for the physical moment, then send this device's clock reading. */
function tapAtT0(seat: Seat, approach: ApproachEvent): void {
  setTimeout(
    () => seat.client.send('room', { type: 'tap', clientTime: clientTime(seat), fence: approach.fence, attempt: approach.attempt }),
    Math.max(0, approach.t0 - serverNow()),
  );
}

describe('a class in the live room', () => {
  it('protocol constants', () => {
    expect(CLASS_PROTOCOL).toEqual({ clockPingCount: 8, clockPingEveryMs: 200, reconnectSeconds: 10 });
  });

  it(
    'phases, heats of four, own-horse commands, server judging of taps from skewed clocks, results once with one seed, one table',
    async () => {
      const { entry, room, riders, roundId } = await openRoom(5);
      const [host, ana, bea, cris, eva] = riders as [Rider, Rider, Rider, Rider, Rider];
      const seats = {
        host: await sit(room.roomId, entry.code, host.token, host.account.id),
        ana: await sit(room.roomId, entry.code, ana.token, ana.account.id, { skewMs: 5000 }), // her tablet runs 5 s ahead
        bea: await sit(room.roomId, entry.code, bea.token, bea.account.id, { skewMs: -3000 }), // hers 3 s behind
        cris: await sit(room.roomId, entry.code, cris.token, cris.account.id, { mute: true }), // never answers the clock
        eva: await sit(room.roomId, entry.code, eva.token, eva.account.id),
      };
      const view = (id: string) => seats.host.client.state.riders.get(id);
      await until(() => clockPings(seats.host).length >= CLASS_PROTOCOL.clockPingCount, 5000, 'the clock series of the host');
      await clocksSynced(); // every seat's series is complete; no ninth ping follows
      expect(clockPings(seats.host)).toHaveLength(CLASS_PROTOCOL.clockPingCount);
      expect(clockPings(seats.cris)).toHaveLength(CLASS_PROTOCOL.clockPingCount); // pinged like everyone, just never answers

      // Lobby settings: a class the pony category allows (default category C → 70/80/90), a refused one, assists.
      seats.eva.client.send('room', { type: 'height', heightClass: 80 });
      seats.bea.client.send('room', { type: 'height', heightClass: 50 });
      await sleep(100);
      expect(refusals(seats.bea)).toEqual(['height-not-allowed']);
      expect(refusals(seats.eva)).toEqual([]);

      // Nobody rides before the class: rider commands are refused; the class is host-only (B1).
      seats.ana.client.send('room', { type: 'tap', clientTime: clientTime(seats.ana), fence: 1, attempt: 1 });
      seats.ana.client.send('room', { type: 'start-class', order: 'lowest-class-first' });
      await sleep(100);
      expect(refusals(seats.ana)).toEqual(['not-riding', 'host-only']);

      seats.host.client.send('room', { type: 'start-class', order: 'lowest-class-first' });
      await until(() => seats.host.client.state.phase === 'walk', 5000, "phase 'walk'");
      expect(seats.host.client.state.heatIndex).toBe(0);
      seats.host.client.send('room', { type: 'start-class', order: 'random' });
      await sleep(100);
      expect(refusals(seats.host)).toEqual(['class-running']);
      await until(() => seats.host.client.state.riders.size === 4, 2000, 'the first heat in the state');
      expect([...seats.host.client.state.riders.keys()].sort()).toEqual([host.account.id, ana.account.id, bea.account.id, cris.account.id].sort()); // eva (80 cm) rides last

      await until(() => seats.host.client.state.phase === 'riding', 5000, "phase 'riding'");
      const ridingAt = Date.now();
      // A spectator cannot drive; a rider's gear command drives their own horse only; no clock → no taps.
      seats.eva.client.send('room', { type: 'gear', gear: 'gallop' });
      seats.host.client.send('room', { type: 'gear', gear: 'extended' });
      seats.cris.client.send('room', { type: 'tap', clientTime: Date.now(), fence: 1, attempt: 1 });
      // Changing assists during the round changes nothing until the next class (row 9).
      seats.ana.client.send('room', { type: 'assists', schoolmaster: true, widerWindow: true });
      await sleep(200);
      expect(refusals(seats.eva)).toEqual(['not-riding']);
      expect(refusals(seats.cris)).toEqual(['clock-not-ready']);
      expect(view(host.account.id)?.gear).toBe('extended');
      expect(view(ana.account.id)?.gear).toBe('collected');
      expect(view(bea.account.id)?.gear).toBe('collected');
      expect(view(eva.account.id)).toBeUndefined();
      seats.host.client.send('room', { type: 'gear', gear: 'collected' });

      // Ana and Bea tap at their t0 (announced by the approach event, in server time) at the physical moment, each
      // sending her own clock's reading: only a translated tap lands near t0 — raw, Ana's would be 5 s in the future
      // and Bea's 3 s too old, both "no tap".
      const approachOf = (seat: Seat) => roundEvents(seat, 'approach', seat.id)[0] as ApproachEvent | undefined;
      await until(() => approachOf(seats.ana) !== undefined && approachOf(seats.bea) !== undefined, 8000, 'the approach events of Ana and Bea');
      for (const seat of [seats.ana, seats.bea]) {
        const approach = approachOf(seat);
        if (!approach) throw new Error('approach event missing');
        tapAtT0(seat, approach);
      }
      const takeoffOf = (id: string) => roundEvents(seats.host, 'takeoff', id)[0] as TakeoffEvent | undefined;
      await until(() => takeoffOf(ana.account.id) !== undefined && takeoffOf(bea.account.id) !== undefined, 8000, 'the take-off events of Ana and Bea');
      for (const id of [ana.account.id, bea.account.id]) {
        const takeoff = takeoffOf(id);
        expect(takeoff?.offsetMs).not.toBeNull();
        expect(Math.abs(takeoff?.offsetMs ?? 999)).toBeLessThan(120); // her clock was translated, not taken raw
        expect(['perfect', 'clean']).toContain(takeoff?.outcome.kind);
      }
      await until(() => view(ana.account.id)?.lastLabel !== '' && view(bea.account.id)?.lastLabel !== '', 2000, 'the take-off labels');
      expect(view(ana.account.id)).toMatchObject({ faults: 0, autopilot: false });
      expect(view(bea.account.id)).toMatchObject({ faults: 0, autopilot: false });

      await until(() => seats.host.client.state.phase === 'results', 20000, "phase 'results'");
      expect(Date.now() - ridingAt).toBeGreaterThan(9000);
      const heat0 = await services.repos.results.listByRound(roundId(0));
      expect(heat0.map((r) => r.accountId).sort()).toEqual([host.account.id, ana.account.id, bea.account.id, cris.account.id].sort());
      const seed = heat0[0]?.seed;
      expect(typeof seed).toBe('string');
      expect(seed).not.toBe('');
      expect(heat0.every((r) => r.seed === seed)).toBe(true); // one seed per round, the same for its riders
      expect(await services.repos.results.get(roundId(0), ana.account.id)).toMatchObject({
        heightClass: 70,
        faults: 0,
        status: 'finished',
        autopilot: false,
        schoolmaster: false, // the mid-round assists change did not reach this round
        mode: 'ranked',
        rulesVersion: 1,
        courseId: 'live-test',
        courseVersion: 1,
      });
      expect(await services.repos.results.get(roundId(0), bea.account.id)).toMatchObject({ faults: 0, status: 'finished', autopilot: false });
      expect(await services.repos.results.get(roundId(0), cris.account.id)).toMatchObject({ faults: 5, status: 'finished' }); // chip + 1 time fault
      expect(await services.repos.results.get(roundId(0), host.account.id)).toMatchObject({ faults: 5, status: 'finished' });

      await until(() => seats.host.client.state.phase === 'riding' && seats.host.client.state.heatIndex === 1, 5000, 'heat 1 riding');
      expect([...seats.host.client.state.riders.keys()]).toEqual([eva.account.id]);
      await until(() => seats.host.client.state.phase === 'done', 20000, "phase 'done'");
      await until(() => classTable(seats.host) !== undefined, 2000, "the 'class-table' message");
      const table = classTable(seats.host)?.table ?? {};
      expect(Object.keys(table).sort()).toEqual(['70', '80']);
      const t70 = table['70'] ?? [];
      expect(t70).toHaveLength(4);
      // Ana and Bea: zero faults and the same time (same start, same t0, both landed at t0 + 600) → they share place 1.
      expect(t70.slice(0, 2).map((r) => r.riderId).sort()).toEqual([ana.account.id, bea.account.id].sort());
      expect(t70.slice(0, 2).map((r) => r.place)).toEqual([1, 1]);
      expect(t70.slice(2).map((r) => r.riderId).sort()).toEqual([host.account.id, cris.account.id].sort());
      expect(t70[2]?.place).toBe(3); // the next place skips
      expect(t70[3]?.place).toBeGreaterThanOrEqual(3);
      expect(t70.slice(2).map((r) => r.faults)).toEqual([5, 5]);
      expect(table['80']).toEqual([expect.objectContaining({ riderId: eva.account.id, place: 1 })]);
      // 'class-phase' messages follow the phases: heat 0 walk → riding → results, heat 1 riding → results, then done.
      expect(
        inOrder(phaseMessages(seats.host), [
          { phase: 'walk', heatIndex: 0 },
          { phase: 'riding', heatIndex: 0 },
          { phase: 'results', heatIndex: 0 },
          { phase: 'riding', heatIndex: 1 },
          { phase: 'results', heatIndex: 1 },
          { phase: 'done', heatIndex: 1 },
        ]),
      ).toBe(true);
      expect(phaseMessages(seats.host).at(-1)).toMatchObject({ phase: 'done' });
      await sleep(300);
      expect(await services.repos.results.listByAccount(ana.account.id)).toHaveLength(1); // written once, not per tick
      expect(await services.repos.results.listByRound(roundId(0))).toHaveLength(4);
      expect((await services.repos.results.listByAccount(eva.account.id))[0]).toMatchObject({ heightClass: 80 });
      for (const seat of Object.values(seats)) await seat.client.leave();
    },
    60000,
  );

  it(
    'a dropped connection → autopilot until the reconnection with the token; a consented leave eliminates; both flags reach the results',
    async () => {
      const { entry, room, riders, roundId } = await openRoom(2);
      const [host, friend] = riders as [Rider, Rider];
      const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
      const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
      const view = () => hostSeat.client.state.riders.get(friend.account.id);
      await clocksSynced();
      await startRiding(hostSeat);
      await sleep(1000);

      const token = friendSeat.client.reconnectionToken;
      await friendSeat.client.leave(false); // the tab went to sleep: not a consented leave
      await until(() => view()?.autopilot === true, 3000, 'autopilot on after the drop');
      expect(room.clients).toHaveLength(1);
      await sleep(500);
      const back = await sdk(friend.token).reconnect<LobbyState>(token);
      await firstState(back);
      await until(() => view()?.autopilot === false, 3000, 'autopilot off after the reconnection');
      await until(() => back.state.riders.get(friend.account.id)?.autopilot === false, 3000, 'autopilot off in the reconnected session itself');
      expect(room.clients).toHaveLength(2);
      expect(view()?.status).toBe('riding');

      await hostSeat.client.leave(); // consented: the host gives up the round (and the room passes to the friend)
      await until(() => back.state.riders.get(host.account.id)?.status === 'eliminated', 3000, 'the host eliminated');
      await until(() => back.state.phase === 'done', 20000, "phase 'done'");
      expect(await services.repos.results.get(roundId(0), friend.account.id)).toMatchObject({ status: 'finished', autopilot: true, schoolmaster: false });
      expect(await services.repos.results.get(roundId(0), host.account.id)).toMatchObject({ status: 'eliminated', eliminationReason: 'disconnected', timeMs: null, autopilot: false });
      expect(await services.repos.results.listByRound(roundId(0))).toHaveLength(2);
      await back.leave();
    },
    45000,
  );

  it(
    'a fresh join by the same account after the reservation expired: the rider was never withdrawn, control comes back, one row with autopilot',
    async () => {
      const { entry, room, riders } = await openRoom(2, LATE_FENCE_COURSE);
      const [host, friend] = riders as [Rider, Rider];
      const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
      const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
      const view = () => hostSeat.client.state.riders.get(friend.account.id);
      await clocksSynced();
      await startRiding(hostSeat);
      await sleep(800);

      const token = friendSeat.client.reconnectionToken;
      await friendSeat.client.leave(false);
      await until(() => view()?.autopilot === true, 3000, 'autopilot on after the drop');
      await until(() => room.clients.length === 1, 2000, 'the server to register the drop');
      await sleep(TIMING.reconnectSeconds * 1000 + 600); // the reservation is gone; the autopilot budget (10 s) is not
      await expect(sdk(friend.token).reconnect<LobbyState>(token)).rejects.toThrow(); // the expired token is dead
      expect(view()).toMatchObject({ status: 'riding', autopilot: true }); // the horse rides on; nobody withdrew her
      expect(room.state.phase).toBe('riding');
      expect(room.clients).toHaveLength(1);

      const again = await sit(room.roomId, entry.code, friend.token, friend.account.id);
      const ownView = () => again.client.state.riders.get(friend.account.id);
      await until(() => view()?.autopilot === false, 3000, 'control back after the fresh join (host view)');
      await until(() => ownView()?.autopilot === false, 3000, 'control back after the fresh join (own view)');
      again.client.send('room', { type: 'gear', gear: 'extended' });
      await until(() => view()?.gear === 'extended', 2000, 'the gear command of the new connection (host view)');
      await until(() => ownView()?.gear === 'extended', 2000, 'the gear command of the new connection (own view)');
      again.client.send('room', { type: 'gear', gear: 'collected' });
      await until(() => view()?.gear === 'collected', 2000, 'the gear back to collected');

      await until(() => hostSeat.client.state.phase === 'done', 30000, "phase 'done'");
      const rows = await services.repos.results.listByAccount(friend.account.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'finished', autopilot: true, courseId: 'live-late-fence' });
      expect((await services.repos.results.listByAccount(host.account.id))[0]).toMatchObject({ status: 'finished', autopilot: false });
      await again.client.leave();
      await hostSeat.client.leave();
    },
    60000,
  );

  it(
    'two consecutive drops of one account — a token reconnection, then a fresh join while the second reservation is pending — give control back each time',
    async () => {
      const { entry, room, riders } = await openRoom(2, LATE_FENCE_COURSE);
      const [host, friend] = riders as [Rider, Rider];
      const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
      const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
      const view = () => hostSeat.client.state.riders.get(friend.account.id);
      await clocksSynced();
      await startRiding(hostSeat);
      await sleep(800);

      // Drop 1 → back with the token.
      const token = friendSeat.client.reconnectionToken;
      await friendSeat.client.leave(false);
      await until(() => view()?.autopilot === true, 3000, 'autopilot on after drop 1');
      await sleep(300);
      const back = await sdk(friend.token).reconnect<LobbyState>(token);
      await until(() => view()?.autopilot === false, 3000, 'control back after the reconnection');
      back.send('room', { type: 'gear', gear: 'extended' });
      await until(() => view()?.gear === 'extended', 2000, 'the gear command of the reconnected session');
      back.send('room', { type: 'gear', gear: 'collected' });
      await until(() => view()?.gear === 'collected', 2000, 'the gear back to collected (1)');

      // Drop 2 → a fresh join while this reservation is still pending.
      await back.leave(false);
      await until(() => view()?.autopilot === true, 3000, 'autopilot on after drop 2');
      await until(() => room.clients.length === 1, 2000, 'the server to register drop 2');
      const again = await sit(room.roomId, entry.code, friend.token, friend.account.id);
      await until(() => view()?.autopilot === false, 3000, 'control back after the fresh join');
      again.client.send('room', { type: 'gear', gear: 'extended' });
      await until(() => view()?.gear === 'extended', 2000, 'the gear command of the fresh connection');
      again.client.send('room', { type: 'gear', gear: 'collected' });
      await until(() => view()?.gear === 'collected', 2000, 'the gear back to collected (2)');
      expect(room.clients).toHaveLength(2);

      // The pending reservation of drop 2 expires meanwhile: nothing changes for the rider who is connected.
      await sleep(TIMING.reconnectSeconds * 1000 + 600);
      expect(view()).toMatchObject({ status: 'riding', autopilot: false });
      expect(room.clients).toHaveLength(2);

      await until(() => hostSeat.client.state.phase === 'done', 30000, "phase 'done'");
      const rows = await services.repos.results.listByAccount(friend.account.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'finished', autopilot: true });
      await again.client.leave();
      await hostSeat.client.leave();
    },
    60000,
  );

  it(
    'a kick while a reconnection is pending kills the token: the kicked account can neither reconnect nor rejoin',
    async () => {
      const { entry, room, riders } = await openRoom(2);
      const [host, friend] = riders as [Rider, Rider];
      const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
      const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
      await clocksSynced();
      await startRiding(hostSeat);
      await sleep(500);

      const token = friendSeat.client.reconnectionToken;
      await friendSeat.client.leave(false);
      await until(() => hostSeat.client.state.riders.get(friend.account.id)?.autopilot === true, 3000, 'autopilot on after the drop');
      expect(services.rooms.hostAction(entry.code, host.account.id, { type: 'kick', accountId: friend.account.id }).ok).toBe(true);
      await expect(sdk(friend.token).reconnect<LobbyState>(token)).rejects.toThrow();
      await expect(sdk(friend.token).joinById(room.roomId, { code: entry.code })).rejects.toThrow(/not-admitted/);
      expect(room.clients).toHaveLength(1);
      await hostSeat.client.leave();
    },
    30000,
  );

  it(
    'a session revocation while a reconnection is pending kills the token and the cookie',
    async () => {
      const { entry, room, riders } = await openRoom(2);
      const [host, friend] = riders as [Rider, Rider];
      const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
      const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
      await clocksSynced();
      await startRiding(hostSeat);
      await sleep(500);

      const token = friendSeat.client.reconnectionToken;
      await friendSeat.client.leave(false);
      await until(() => hostSeat.client.state.riders.get(friend.account.id)?.autopilot === true, 3000, 'autopilot on after the drop');
      expect((await services.accounts.resetPin(ADMIN_KEY, friend.account.id, '9999')).ok).toBe(true);
      await expect(sdk(friend.token).reconnect<LobbyState>(token)).rejects.toThrow();
      await expect(sdk(friend.token).joinById(room.roomId, { code: entry.code })).rejects.toThrow(/no-session/);
      expect(room.clients).toHaveLength(1);
      await hostSeat.client.leave();
    },
    30000,
  );

  it(
    'every connection gone: the heat goes on with nobody connected, the horses wait after the autopilot budget, the time limit eliminates them as disconnected, a late joiner sees the finished class',
    async () => {
      const { entry, room, riders, roundId } = await openRoom(2, LONG_COURSE);
      const [host, friend] = riders as [Rider, Rider];
      const ids = [host.account.id, friend.account.id];
      const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
      const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
      const view = (id: string) => room.state.riders.get(id); // the server's own state: nobody is connected to read it
      await clocksSynced();
      await startRiding(hostSeat);
      await sleep(800);

      await hostSeat.client.leave(false);
      await friendSeat.client.leave(false);
      await until(() => room.clients.length === 0, 2000, 'both drops');
      await until(() => ids.every((id) => view(id)?.autopilot === true), 3000, 'autopilot for both');
      await sleep(TIMING.reconnectSeconds * 1000 + 600); // both reservations expired; nobody is withdrawn
      expect(room.state.phase).toBe('riding');
      expect(room.state.riders.size).toBe(2);
      for (const id of ids) expect(view(id)).toMatchObject({ status: 'riding' });
      const clockBefore = room.state.roundClockMs;
      await sleep(300);
      expect(room.state.roundClockMs).toBeGreaterThan(clockBefore); // still ticking with nobody connected

      // Autopilot (10 s) clears fences 1 and 2; the horses then stop exactly at fence 3's zone entry and stand there,
      // still riding (the approach itself, 88–100 m, never opens: that is what 'waiting' means).
      const waitingAtM = (LONG_COURSE.fences[2]?.distanceM ?? 0) - RUN.approachZoneM; // 88 m
      const waiting = (id: string) => {
        const rider = view(id);
        return rider !== undefined && rider.positionM === waitingAtM && rider.status === 'riding' && rider.nextFence === 3;
      };
      await until(() => ids.every(waiting), 25000, "the horses standing at fence 3's zone entry (88 m)");
      const standing = ids.map((id) => view(id)?.positionM);
      await sleep(600);
      expect(ids.map((id) => view(id)?.positionM)).toEqual(standing);
      expect(ids.every(waiting)).toBe(true);
      expect(room.state.phase).toBe('riding');

      // Nobody connected: the server clock jumps past the time limit (48 s); the waiting horses are eliminated.
      jumpMs = 60_000;
      await until(() => room.state.phase === 'done', 5000, "phase 'done' after the time limit");

      const back = await sit(room.roomId, entry.code, host.token, host.account.id);
      await until(() => back.client.state.phase === 'done', 2000, "the late joiner's own state at 'done'");
      for (const id of ids) {
        expect(await services.repos.results.get(roundId(0), id)).toMatchObject({ status: 'eliminated', eliminationReason: 'disconnected', autopilot: true, timeMs: null });
        expect(await services.repos.results.listByAccount(id)).toHaveLength(1);
      }
      expect(await services.repos.results.listByRound(roundId(0))).toHaveLength(2);
      await until(() => classTable(back) !== undefined, 2000, "the 'class-table' message for the late joiner");
      const t70 = classTable(back)?.table['70'] ?? [];
      expect(t70.map((r) => r.riderId).sort()).toEqual([...ids].sort());
      for (const row of t70) expect(row).toMatchObject({ place: null, status: 'eliminated', eliminationReason: 'disconnected', autopilot: true, timeMs: null });
      await back.client.leave();
    },
    60000,
  );
});

describe('audit round 1 of B2: one live room per code, checks before the reservation, results that never get lost, presence and clocks', () => {
  it('a second live room for the same code is refused, and the match-maker checks Origin, session and admission before reserving a seat', async () => {
    const { entry, room, riders } = await openRoom(1);
    const [host] = riders as [Rider];
    await expect(colyseus.createRoom(LOBBY_ROOM_NAME, { code: entry.code })).rejects.toThrow(/already|exists|open/);
    const stranger = await registerRider(services, uniqueRiderName('Stranger'));
    const reserve = async (headers: Record<string, string>) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/matchmake/joinById/${room.roomId}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code: entry.code }) });
      return { status: res.status, text: await res.text() };
    };
    const noSession = await reserve({ origin: ORIGIN });
    expect(noSession.status).toBeGreaterThanOrEqual(400);
    expect(noSession.text).toMatch(/no-session/);
    const notAdmitted = await reserve({ origin: ORIGIN, cookie: `${SESSION.cookieName}=${stranger.token}` });
    expect(notAdmitted.status).toBeGreaterThanOrEqual(400);
    expect(notAdmitted.text).toMatch(/not-admitted/);
    const badOrigin = await reserve({ origin: 'https://evil.example', cookie: `${SESSION.cookieName}=${host.token}` });
    expect(badOrigin.status).toBeGreaterThanOrEqual(400);
    expect(badOrigin.text).toMatch(/bad-origin/);
    const ok = await reserve({ origin: ORIGIN, cookie: `${SESSION.cookieName}=${host.token}` });
    expect(ok.status).toBe(200);
    expect(room.clients).toHaveLength(0); // a reservation is not a connection
  });

  it('the last participant leaving during a heat: the heat is closed and every rider of it has exactly one row before the room goes', async () => {
    const { entry, room, riders, roundId } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
    await clocksSynced();
    await startRiding(hostSeat);
    await sleep(1000);
    await friendSeat.client.leave(); // consented
    await until(() => hostSeat.client.state.riders.get(friend.account.id)?.status === 'eliminated', 3000, 'friend eliminated');
    await hostSeat.client.leave(); // consented: the last participant, the room closes
    await until(() => services.rooms.getByCode(entry.code) === undefined, 3000, 'directory entry gone');
    await sleep(300);
    const rows = await services.repos.results.listByRound(roundId(0));
    expect(rows.map((r) => r.accountId).sort()).toEqual([host.account.id, friend.account.id].sort());
    for (const row of rows) expect(row).toMatchObject({ status: 'eliminated', eliminationReason: 'disconnected', timeMs: null });
    expect(insertCalls.filter((c) => c.roundId === roundId(0))).toHaveLength(2);
  }, 30000);

  it('a result write that fails is retried until it lands, and lands exactly once', async () => {
    const { entry, room, riders, roundId } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
    await clocksSynced();
    await startRiding(hostSeat);
    failInserts = 1; // the first write of this heat fails
    await until(() => hostSeat.client.state.phase === 'results', 20000, "phase 'results'");
    await until(() => insertCalls.filter((c) => c.roundId === roundId(0)).length >= 3, 5000, 'a retry of the failed write');
    await sleep(200);
    const rows = await services.repos.results.listByRound(roundId(0));
    expect(rows.map((r) => r.accountId).sort()).toEqual([host.account.id, friend.account.id].sort());
    expect(rows.every((r) => r.status === 'finished')).toBe(true);
    await until(() => hostSeat.client.state.phase === 'done', 5000, "phase 'done'");
    await sleep(1200);
    expect(await services.repos.results.listByRound(roundId(0))).toHaveLength(2); // no duplicate from a late retry
    await friendSeat.client.leave();
    await hostSeat.client.leave();
  }, 45000);

  it('two live sessions of one account: dropping one leaves the other in control, without autopilot', async () => {
    const { entry, room, riders } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const phone = await sit(room.roomId, entry.code, friend.token, friend.account.id);
    const tablet = await sit(room.roomId, entry.code, friend.token, friend.account.id);
    await clocksSynced();
    await startRiding(hostSeat);
    await sleep(300);
    await tablet.client.leave(false); // the tablet sleeps; the phone is still playing
    await sleep(600);
    expect(hostSeat.client.state.riders.get(friend.account.id)?.autopilot).toBe(false);
    phone.client.send('room', { type: 'gear', gear: 'extended' });
    await until(() => hostSeat.client.state.riders.get(friend.account.id)?.gear === 'extended', 2000, 'the phone still drives');
    expect(refusals(phone)).toEqual([]);
    await until(() => hostSeat.client.state.phase === 'done', 25000, "phase 'done'");
    expect((await services.repos.results.listByAccount(friend.account.id))[0]).toMatchObject({ status: 'finished', autopilot: false });
    await phone.client.leave();
    await hostSeat.client.leave();
  }, 45000);

  it('a rider absent since the course walk starts on autopilot and takes over on return; a spectator absent before their own heat too', async () => {
    const { entry, room, riders } = await openRoom(5);
    const [host, ana, bea, cris, eva] = riders as [Rider, Rider, Rider, Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const [anaSeat] = await Promise.all([ana, bea, cris].map((r) => sit(room.roomId, entry.code, r.token, r.account.id)));
    let evaSeat = await sit(room.roomId, entry.code, eva.token, eva.account.id);
    evaSeat.client.send('room', { type: 'height', heightClass: 80 }); // eva rides alone in heat 1
    await clocksSynced();
    hostSeat.client.send('room', { type: 'start-class', order: 'lowest-class-first' });
    await until(() => hostSeat.client.state.phase === 'walk', 5000, "phase 'walk'");
    await anaSeat!.client.leave(false); // ana's tab sleeps during the course walk
    await evaSeat.client.leave(false); // eva (a spectator for heat 0) is gone before her heat
    await until(() => hostSeat.client.state.phase === 'riding', 5000, "phase 'riding'");
    await until(() => hostSeat.client.state.riders.get(ana.account.id)?.autopilot === true, 2000, 'ana on autopilot from the start');
    const anaBack = await sit(room.roomId, entry.code, ana.token, ana.account.id);
    await until(() => anaBack.client.state.riders.get(ana.account.id)?.autopilot === false, 3000, 'ana takes over');
    anaBack.client.send('room', { type: 'gear', gear: 'extended' });
    await until(() => anaBack.client.state.riders.get(ana.account.id)?.gear === 'extended', 2000, 'ana drives');
    await until(() => hostSeat.client.state.phase === 'riding' && hostSeat.client.state.heatIndex === 1, 25000, 'heat 1');
    await until(() => hostSeat.client.state.riders.get(eva.account.id)?.autopilot === true, 2000, 'eva on autopilot from the start of her heat');
    evaSeat = await sit(room.roomId, entry.code, eva.token, eva.account.id);
    await until(() => evaSeat.client.state.riders.get(eva.account.id)?.autopilot === false, 3000, 'eva takes over');
    await until(() => hostSeat.client.state.phase === 'done', 25000, "phase 'done'");
    expect((await services.repos.results.listByAccount(ana.account.id))[0]).toMatchObject({ autopilot: true, status: 'finished' });
    expect((await services.repos.results.listByAccount(eva.account.id))[0]).toMatchObject({ autopilot: true, heightClass: 80 });
    expect((await services.repos.results.listByAccount(bea.account.id))[0]).toMatchObject({ autopilot: false });
    for (const seat of [hostSeat, anaBack, evaSeat]) await seat.client.leave();
  }, 70000);

  it('clocks are measured again before every class: a device that missed the first series answers the next one; a changed skew is measured again', async () => {
    const { entry, room, riders } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id, { mute: true, skewMs: 2500 });
    await clocksSynced();
    friendSeat.muted = false; // the tab wakes up just before the host starts
    hostSeat.client.send('room', { type: 'start-class', order: 'random' });
    await until(() => hostSeat.client.state.phase === 'walk', 5000, "phase 'walk'");
    await until(() => clockPings(friendSeat).length >= 2 * CLASS_PROTOCOL.clockPingCount, 5000, 'a second clock series at the course walk');
    await until(() => hostSeat.client.state.phase === 'riding', 5000, "phase 'riding'");
    await until(() => roundEvents(friendSeat, 'approach', friend.account.id).length > 0, 8000, 'approach');
    tapAtT0(friendSeat, roundEvents(friendSeat, 'approach', friend.account.id)[0] as unknown as ApproachEvent);
    await until(() => roundEvents(hostSeat, 'takeoff', friend.account.id).length > 0, 8000, 'takeoff');
    const first = roundEvents(hostSeat, 'takeoff', friend.account.id)[0] as unknown as TakeoffEvent;
    expect(refusals(friendSeat)).not.toContain('clock-not-ready');
    expect(Math.abs(first.offsetMs ?? 999)).toBeLessThan(120);
    await until(() => hostSeat.client.state.phase === 'done', 25000, "phase 'done'");

    friendSeat.skewMs = -3500; // the device clock was adjusted between classes
    hostSeat.client.send('room', { type: 'start-class', order: 'random' });
    await until(() => clockPings(friendSeat).length >= 3 * CLASS_PROTOCOL.clockPingCount, 5000, 'a third clock series');
    await until(() => roundEvents(friendSeat, 'approach', friend.account.id).length > 1, 10000, 'second approach');
    tapAtT0(friendSeat, roundEvents(friendSeat, 'approach', friend.account.id)[1] as unknown as ApproachEvent);
    await until(() => roundEvents(hostSeat, 'takeoff', friend.account.id).length > 1, 8000, 'second takeoff');
    const second = roundEvents(hostSeat, 'takeoff', friend.account.id)[1] as unknown as TakeoffEvent;
    expect(Math.abs(second.offsetMs ?? 999)).toBeLessThan(120);
    await until(() => hostSeat.client.state.phase === 'done', 25000, "phase 'done' again");
    await friendSeat.client.leave();
    await hostSeat.client.leave();
  }, 90000);
});

describe('audit round 2 of B2: the reservation is for the room the URL names, results outlive the room, the last clock stays', () => {
  it('a seat is reserved only for the room the URL names: code A in the body does not open room B, and B keeps its seats', async () => {
    const a = await openRoom(1);
    const b = await openRoom(2);
    const [hostA] = a.riders as [Rider];
    const [, friendB] = b.riders as [Rider, Rider];
    const reserve = async (token: string, roomId: string, code: string) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/matchmake/joinById/${roomId}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `${SESSION.cookieName}=${token}` }, body: JSON.stringify({ code }) });
      return { status: res.status, text: await res.text() };
    };
    for (let i = 0; i < 16; i += 1) {
      const refused = await reserve(hostA.token, b.room.roomId, a.entry.code); // admitted to A only, naming B
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.text).toMatch(/not-admitted/);
      expect(refused.text).not.toMatch(/sessionId/);
    }
    expect(b.room.clients).toHaveLength(0);
    const own = await reserve(hostA.token, a.room.roomId, a.entry.code);
    expect(own.status).toBe(200);
    const seat = await sit(b.room.roomId, b.entry.code, friendB.token, friendB.account.id); // B's seats were never eaten
    expect(seat.client.state.code).toBe(b.entry.code);
    await seat.client.leave();
  });

  it('rows still unwritten when the room is disposed land later, exactly once, when storage recovers', async () => {
    const { entry, room, riders, roundId } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
    await clocksSynced();
    await startRiding(hostSeat);
    failInserts = 3; // the write at the end of the heat and the next two retries fail
    await until(() => hostSeat.client.state.phase === 'results', 20000, "phase 'results'");
    await friendSeat.client.leave();
    await hostSeat.client.leave(); // the last participant: the room is disposed while its rows are still queued
    await until(() => services.rooms.getByCode(entry.code) === undefined, 3000, 'directory entry gone');
    expect(await services.repos.results.listByRound(roundId(0))).toHaveLength(0);
    await until(async () => (await services.repos.results.listByRound(roundId(0))).length === 2, 8000, 'rows landed after the room was gone').catch(() => undefined);
    const rows = await services.repos.results.listByRound(roundId(0));
    expect(rows.map((r) => r.accountId).sort()).toEqual([host.account.id, friend.account.id].sort());
    expect(insertCalls.filter((c) => c.roundId === roundId(0)).length).toBeGreaterThanOrEqual(5); // 3 failures, then both rows
    await sleep(1200);
    expect(await services.repos.results.listByRound(roundId(0))).toHaveLength(2);
    expect(room.clients).toHaveLength(0);
  }, 45000);

  it('an answered clock measurement stays active through unanswered series; a later answered series replaces it', async () => {
    const { entry, room, riders } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id, { skewMs: 2500 });
    await clocksSynced();
    friendSeat.muted = true; // the device answers nothing from now on: the walk series of classes 1 and 2 stay incomplete
    const rideOnce = async (approachIndex: number) => {
      hostSeat.client.send('room', { type: 'start-class', order: 'random' });
      await until(() => roundEvents(friendSeat, 'approach', friend.account.id).length > approachIndex, 12000, `approach ${approachIndex + 1}`);
      tapAtT0(friendSeat, roundEvents(friendSeat, 'approach', friend.account.id)[approachIndex] as unknown as ApproachEvent);
      await until(() => roundEvents(hostSeat, 'takeoff', friend.account.id).length > approachIndex, 8000, `takeoff ${approachIndex + 1}`);
      const takeoff = roundEvents(hostSeat, 'takeoff', friend.account.id)[approachIndex] as unknown as TakeoffEvent;
      expect(refusals(friendSeat)).not.toContain('clock-not-ready');
      expect(Math.abs(takeoff.offsetMs ?? 999)).toBeLessThan(120);
      await until(() => hostSeat.client.state.phase === 'done' && phaseMessages(hostSeat).filter((m) => m.phase === 'done').length === approachIndex + 1, 25000, `class ${approachIndex + 1} done`);
    };
    await rideOnce(0);
    await rideOnce(1);
    friendSeat.muted = false;
    friendSeat.skewMs = -1500; // the device clock changed; the next answered series must measure it again
    await rideOnce(2);
    await friendSeat.client.leave();
    await hostSeat.client.leave();
  }, 110000);
});

type ApproachSync = { classNumber: number; heatIndex: number; hardTurn: boolean; approach: { fence: number; attempt: number; t0: number; speedMps: number } | null };
const approachSyncs = (seat: Seat) => seat.received.filter((m) => m.type === 'approach-sync').map((m) => m.payload as ApproachSync);

/** A seat for a connection the SDK already holds (a reconnection by token): the same recording and clock answers as sit(). */
function reattach(client: ClientRoom<LobbyState>, rider: Rider, skewMs = 0): Seat {
  const seat: Seat = { id: rider.account.id, token: rider.token, skewMs, muted: false, client, received: [] };
  client.onMessage('*', (type, payload) => seat.received.push({ type: String(type), payload }));
  client.onMessage('clock-ping', (ping: { serverSent: number }) => {
    seat.received.push({ type: 'clock-ping', payload: ping });
    if (!seat.muted) client.send('room', { type: 'clock-pong', serverSent: ping.serverSent, clientTime: Date.now() + seat.skewMs });
  });
  return seat;
}

describe('audit K1 r2 #1: a rider who takes control back is told the approach in progress (approach-sync)', () => {
  /** Two riders on LIVE_COURSE (zone at 18 m ≈ 3.6 s, t0 at 30 m ≈ 6.0 s); the friend's connection goes away at 10 m. */
  async function friendAwayAtTenMetres() {
    const { entry, room, riders } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id, { skewMs: 1500 });
    await clocksSynced();
    await startRiding(hostSeat);
    await until(() => (hostSeat.client.state.riders.get(friend.account.id)?.positionM ?? 0) >= 10, 5000, 'the friend at 10 m');
    const token = friendSeat.client.reconnectionToken;
    await friendSeat.client.leave(false); // the tab went to sleep
    await until(() => hostSeat.client.state.riders.get(friend.account.id)?.autopilot === true, 3000, 'autopilot on after the drop');
    return { entry, room, host, friend, hostSeat, friendSeat, token };
  }

  it('back by the token after the approach opened: approach-sync with that approach reaches her new connection only, a new clock series follows, and her tap at t0 is judged as hers', async () => {
    const { friend, hostSeat, friendSeat, token } = await friendAwayAtTenMetres();
    await until(() => roundEvents(hostSeat, 'approach', friend.account.id).length > 0, 5000, 'her approach opening while she is away');
    const approach = roundEvents(hostSeat, 'approach', friend.account.id)[0] as unknown as ApproachEvent;
    expect(roundEvents(friendSeat, 'approach', friend.account.id)).toEqual([]); // the broadcast never reached her
    const back = reattach(await sdk(friend.token).reconnect<LobbyState>(token), friend, 1500);
    await until(() => approachSyncs(back).length > 0, 2000, 'approach-sync on the new connection');
    expect(approachSyncs(back)).toEqual([{ classNumber: 1, heatIndex: 0, hardTurn: false, approach: { fence: approach.fence, attempt: approach.attempt, t0: approach.t0, speedMps: 5 } }]);
    expect(approachSyncs(hostSeat)).toEqual([]);
    // The reconnected connection is measured again (the series goes to the NEW connection, not the stale one).
    await until(() => clockPings(back).length >= 3, 2000, 'a clock series on the new connection');
    expect(approach.t0 - serverNow()).toBeGreaterThan(300);
    tapAtT0(back, approach);
    await until(() => roundEvents(hostSeat, 'takeoff', friend.account.id).length > 0, 5000, 'her take-off');
    const takeoff = roundEvents(hostSeat, 'takeoff', friend.account.id)[0] as unknown as TakeoffEvent & { fence: number; attempt: number };
    expect(takeoff).toMatchObject({ fence: approach.fence, attempt: approach.attempt });
    expect(takeoff.offsetMs).not.toBeNull(); // her tap, not "no tap" at the deadline
    expect(Math.abs(takeoff.offsetMs ?? 999)).toBeLessThan(120);
    expect(refusals(back)).toEqual([]);
    await back.client.leave();
    await hostSeat.client.leave();
  }, 30000);

  it('back by a fresh join after the approach opened: class-course, class-phase, then approach-sync for it; her tap at t0 is judged as hers', async () => {
    const { entry, room, friend, hostSeat } = await friendAwayAtTenMetres();
    await until(() => roundEvents(hostSeat, 'approach', friend.account.id).length > 0, 5000, 'her approach opening while she is away');
    const approach = roundEvents(hostSeat, 'approach', friend.account.id)[0] as unknown as ApproachEvent;
    const again = await sit(room.roomId, entry.code, friend.token, friend.account.id, { skewMs: 1500 });
    await until(() => approachSyncs(again).length > 0, 2000, 'approach-sync on the fresh connection');
    const order = again.received.map((m) => m.type).filter((type) => type === 'class-course' || type === 'class-phase' || type === 'approach-sync');
    expect(order).toEqual(['class-course', 'class-phase', 'approach-sync']);
    expect(approachSyncs(again)).toEqual([{ classNumber: 1, heatIndex: 0, hardTurn: false, approach: { fence: approach.fence, attempt: approach.attempt, t0: approach.t0, speedMps: 5 } }]);
    expect(approachSyncs(hostSeat)).toEqual([]);
    await until(() => clockPings(again).length >= 4, 2000, 'the fresh clock series'); // three answered pongs make it ready
    expect(approach.t0 - serverNow()).toBeGreaterThan(300);
    tapAtT0(again, approach);
    await until(() => roundEvents(hostSeat, 'takeoff', friend.account.id).length > 0, 5000, 'her take-off');
    const takeoff = roundEvents(hostSeat, 'takeoff', friend.account.id)[0] as unknown as TakeoffEvent;
    expect(takeoff.offsetMs).not.toBeNull();
    expect(Math.abs(takeoff.offsetMs ?? 999)).toBeLessThan(120);
    expect(refusals(again)).toEqual([]);
    await again.client.leave();
    await hostSeat.client.leave();
  }, 30000);

  it('back before the approach opened: approach-sync says null (nothing to arm), and the approach event itself arrives later on the new connection', async () => {
    const { friend, hostSeat, token } = await friendAwayAtTenMetres();
    const back = reattach(await sdk(friend.token).reconnect<LobbyState>(token), friend, 1500);
    await until(() => approachSyncs(back).length > 0, 2000, 'approach-sync on the new connection');
    expect(approachSyncs(back)).toEqual([{ classNumber: 1, heatIndex: 0, hardTurn: false, approach: null }]);
    await until(() => roundEvents(back, 'approach', friend.account.id).length > 0, 5000, 'the approach broadcast on the new connection');
    await back.client.leave();
    await hostSeat.client.leave();
  }, 30000);
});

describe('K1.1 step 5: the approach messages carry the frozen approach speed (speedMps)', () => {
  it("the 'approach' broadcast says each horse's own speed: 6 m/s for the host in extended canter, 5 m/s for the friend in collected", async () => {
    const { entry, room, riders } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
    await clocksSynced();
    await startRiding(hostSeat);
    hostSeat.client.send('room', { type: 'gear', gear: 'extended' });
    await until(
      () => roundEvents(friendSeat, 'approach', host.account.id).length > 0 && roundEvents(friendSeat, 'approach', friend.account.id).length > 0,
      8000,
      'both approach events',
    );
    expect(roundEvents(friendSeat, 'approach', host.account.id)[0]).toMatchObject({ fence: 1, attempt: 1, t0: expect.any(Number), speedMps: 6 });
    expect(roundEvents(friendSeat, 'approach', friend.account.id)[0]).toMatchObject({ fence: 1, attempt: 1, t0: expect.any(Number), speedMps: 5 });
    // Every connection hears the same value: the host's copy of her own event.
    expect(roundEvents(hostSeat, 'approach', host.account.id)[0]).toMatchObject({ speedMps: 6 });
    await friendSeat.client.leave();
    await hostSeat.client.leave();
  }, 30000);
});

describe('audit K1 r2 #2: the state the results phase arrives with carries the final values of the heat', () => {
  /** The first room state a client receives in phase 'results' (the heat screen is drawn from it), as plain JSON. */
  function firstResultsState(seat: Seat): () => { riders: Record<string, { status: string; faults: number }> } | null {
    let captured: { riders: Record<string, { status: string; faults: number }> } | null = null;
    seat.client.onStateChange((state) => {
      if (captured === null && state.phase === 'results') captured = state.toJSON() as unknown as typeof captured;
    });
    return () => captured;
  }

  /** The heat's rows as written from the engine's results (once the outbox has written them). */
  async function engineRows(roundId: string, count: number) {
    await until(async () => (await services.repos.results.listByRound(roundId)).length === count, 5000, 'the rows of the heat');
    return services.repos.results.listByRound(roundId);
  }

  it('the last rider crosses the line with a time fault: at the results boundary the state already says finished with the chip and the time fault, as the engine\'s results', async () => {
    const { entry, room, riders, roundId } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
    const atResults = firstResultsState(hostSeat);
    await clocksSynced();
    await startRiding(hostSeat);
    // The host in extended canter is done at ≈ 8.5 s; the friend, passive in collected canter, is the last at the
    // line at 10.1 s: a chip (4) and one time fault over the 10 s allowed.
    hostSeat.client.send('room', { type: 'gear', gear: 'extended' });
    await until(() => atResults() !== null, 20000, "the first state of phase 'results'");
    const rows = await engineRows(roundId(0), 2);
    expect(rows.find((r) => r.accountId === friend.account.id)).toMatchObject({ status: 'finished', faults: 5 });
    const published = atResults()?.riders ?? {};
    for (const row of rows) expect(published[row.accountId], row.accountId).toMatchObject({ status: row.status, faults: row.faults });
    await friendSeat.client.leave();
    await hostSeat.client.leave();
  }, 40000);

  it('the last rider is withdrawn (leaves for good) after the others are done: at the results boundary the state already says eliminated, as the engine\'s results', async () => {
    const { entry, room, riders, roundId } = await openRoom(2);
    const [host, friend] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
    const atResults = firstResultsState(hostSeat);
    await clocksSynced();
    await startRiding(hostSeat);
    hostSeat.client.send('room', { type: 'gear', gear: 'extended' });
    await until(() => hostSeat.client.state.riders.get(host.account.id)?.status === 'finished', 15000, 'the host at the line');
    expect(hostSeat.client.state.riders.get(friend.account.id)?.status).toBe('riding');
    await friendSeat.client.leave(); // consented: out of the heat now, and the heat ends with her
    await until(() => atResults() !== null, 5000, "the first state of phase 'results'");
    const rows = await engineRows(roundId(0), 2);
    expect(rows.find((r) => r.accountId === friend.account.id)).toMatchObject({ status: 'eliminated', eliminationReason: 'disconnected' });
    const published = atResults()?.riders ?? {};
    for (const row of rows) expect(published[row.accountId], row.accountId).toMatchObject({ status: row.status, faults: row.faults });
    await hostSeat.client.leave();
  }, 40000);
});

describe("the names of the heat's riders and of the class table: a rider who left the room keeps her name", () => {
  it('riders in the state carry riderName and ponyName from the start; a consented leave removes the participant, not the name; the class table rows are named, also for a late joiner; a rider admitted over HTTP who never connected is named from the accounts', async () => {
    const { entry, room, riders } = await openRoom(3);
    const [host, friend, absent] = riders as [Rider, Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const friendSeat = await sit(room.roomId, entry.code, friend.token, friend.account.id);
    // `absent` was admitted over the directory and never opened a WebSocket: the room never saw her profile.
    const view = (id: string) => hostSeat.client.state.riders.get(id);
    await clocksSynced();
    await startRiding(hostSeat);
    expect(view(host.account.id)).toMatchObject({ riderName: host.account.riderName, ponyName: 'Dakota' });
    expect(view(friend.account.id)).toMatchObject({ riderName: friend.account.riderName, ponyName: 'Dakota' });
    await until(() => view(absent.account.id)?.riderName === absent.account.riderName, 2000, 'the absent rider named from the accounts');
    expect(view(absent.account.id)).toMatchObject({ ponyName: 'Dakota', autopilot: true });

    await sleep(500);
    await friendSeat.client.leave(); // consented: out of the room for good, eliminated in the heat
    await until(() => !hostSeat.client.state.participants.has(friend.account.id), 3000, 'the friend gone from the participants');
    await until(() => view(friend.account.id)?.status === 'eliminated', 3000, 'the friend eliminated');
    expect(view(friend.account.id)).toMatchObject({ riderName: friend.account.riderName, ponyName: 'Dakota' });

    await until(() => hostSeat.client.state.phase === 'done', 25000, "phase 'done'");
    // Every row of every class. The absent rider never sent her settings: she rides in the lowest class her pony's
    // category allows (C → 70, audit K1 r3 #2), never in a class of no category.
    const named = (table: Record<string, ClassTableRowWire[]> | undefined) => Object.values(table ?? {}).flat().map((r) => [r.riderId, r.riderName, r.ponyName]).sort();
    const expected = [host, friend, absent].map((r) => [r.account.id, r.account.riderName, 'Dakota']).sort();
    expect(named(classTable(hostSeat)?.table)).toEqual(expected);
    expect((classTable(hostSeat)?.table['70'] ?? []).map((r) => r.riderId)).toContain(absent.account.id);
    // A late joiner after the class is done never saw the friend as a participant: the table itself names her.
    const late = await sit(room.roomId, entry.code, absent.token, absent.account.id);
    await until(() => classTable(late) !== undefined, 2000, 'the table for the late joiner');
    expect(late.client.state.participants.has(friend.account.id)).toBe(false);
    expect(named(classTable(late)?.table)).toEqual(expected);
    await late.client.leave();
    await hostSeat.client.leave();
  }, 45000);
});

describe('a rider admitted over HTTP who never connected rides in a class her pony category allows (audit K1 r3 #2)', () => {
  it('categories C and D, no WebSocket before the start: the lowest class of each category in `riders`, kept after a late connection, and in the class table', async () => {
    const host = await registerRider(services, uniqueRiderName('Host'));
    const entry = services.rooms.createRoom(host.account.id, { clubId: null });
    courseByCode.set(entry.code, LIVE_COURSE);
    const room = await colyseus.createRoom<LobbyRoom>(LOBBY_ROOM_NAME, { code: entry.code });
    const cara = await registerRider(services, uniqueRiderName('Cara'), '1234', 'Luna', 'C');
    const dora = await registerRider(services, uniqueRiderName('Dora'), '1234', 'Nube', 'D');
    for (const rider of [cara, dora]) {
      await services.rooms.requestJoin(entry.code, rider.account.id);
      services.rooms.hostAction(entry.code, host.account.id, { type: 'admit', accountId: rider.account.id });
    }
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const view = (id: string) => hostSeat.client.state.riders.get(id);
    await startRiding(hostSeat);
    // One heat of three; the two absent riders were never seen by onAuth.
    expect(view(cara.account.id)).toMatchObject({ heightClass: 70, riderName: cara.account.riderName, ponyName: 'Luna', autopilot: true });
    expect(view(dora.account.id)).toMatchObject({ heightClass: 80, riderName: dora.account.riderName, ponyName: 'Nube', autopilot: true });
    // Dora connects during the heat: the class frozen at the start stays.
    const doraSeat = await sit(room.roomId, entry.code, dora.token, dora.account.id);
    await sleep(300);
    expect(doraSeat.client.state.riders.get(dora.account.id)?.heightClass).toBe(80);
    expect(view(dora.account.id)?.heightClass).toBe(80);
    await until(() => classTable(hostSeat) !== undefined, 30000, 'the class table');
    const table = classTable(hostSeat)?.table ?? {};
    expect(Object.keys(table).sort()).toEqual(['70', '80']);
    expect((table['70'] ?? []).map((r) => r.riderId).sort()).toEqual([host.account.id, cara.account.id].sort());
    expect((table['80'] ?? []).map((r) => [r.riderId, r.riderName, r.ponyName])).toEqual([[dora.account.id, dora.account.riderName, 'Nube']]);
    await doraSeat.client.leave();
    await hostSeat.client.leave();
  }, 45000);

  it('while the profiles are read a second start-class is refused and one class starts; a profile that cannot be read refuses the start and nothing starts', async () => {
    const { entry, room, riders } = await openRoom(2);
    const [host, absent] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const accounts = services.accounts as unknown as { getPublicProfile: (id: string) => Promise<unknown> };
    const original = accounts.getPublicProfile;
    try {
      // Storage trouble: the start is refused, the room stays in the lobby, no course is announced.
      accounts.getPublicProfile = () => Promise.reject(new Error('storage unavailable (test)'));
      hostSeat.client.send('room', { type: 'start-class', order: 'random' });
      await until(() => refusals(hostSeat).length > 0, 2000, 'the refusal');
      expect(refusals(hostSeat)).toEqual(['class-not-ready']);
      await sleep(200);
      expect(hostSeat.client.state.phase).toBe('lobby');
      expect(hostSeat.received.filter((m) => m.type === 'class-course')).toEqual([]);

      // A slow read: a second start-class meanwhile is refused; once the profile lands exactly one class starts.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      accounts.getPublicProfile = async (id: string) => {
        await gate;
        return original.call(services.accounts, id);
      };
      hostSeat.client.send('room', { type: 'start-class', order: 'random' });
      await sleep(100);
      hostSeat.client.send('room', { type: 'start-class', order: 'random' });
      await until(() => refusals(hostSeat).length > 1, 2000, 'the second refusal');
      expect(refusals(hostSeat)).toEqual(['class-not-ready', 'class-running']);
      expect(hostSeat.client.state.phase).toBe('lobby');
      release();
      await until(() => hostSeat.client.state.phase === 'walk', 3000, "phase 'walk'");
      await sleep(200);
      const courses = hostSeat.received.filter((m) => m.type === 'class-course').map((m) => (m.payload as { classNumber: number }).classNumber);
      expect(courses).toEqual([1]);
      await until(() => hostSeat.client.state.riders.size === 2, 3000, 'the heat in the state');
      expect(hostSeat.client.state.riders.get(absent.account.id)).toMatchObject({ heightClass: 70, riderName: absent.account.riderName });
    } finally {
      accounts.getPublicProfile = original;
    }
    await hostSeat.client.leave();
  }, 30000);
});

describe('a profile read that fails no longer matters once nobody needs it (audit K1 r4 #3)', () => {
  /** getPublicProfile held at a gate, then failing: the read of the start is in flight until the test lets it fail. */
  function failingReadAtGate(): { accounts: { getPublicProfile: (id: string) => Promise<unknown> }; original: (id: string) => Promise<unknown>; fail: () => void; reads: string[] } {
    const accounts = services.accounts as unknown as { getPublicProfile: (id: string) => Promise<unknown> };
    const original = accounts.getPublicProfile;
    let fail: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (fail = resolve));
    const reads: string[] = [];
    accounts.getPublicProfile = async (id: string) => {
      reads.push(id);
      await gate;
      throw new Error('storage unavailable (test)');
    };
    return { accounts, original, fail, reads };
  }

  for (const how of ['kicked', 'left'] as const) {
    it(`the rider whose profile is being read ${how === 'kicked' ? 'is kicked' : 'leaves the room'} meanwhile, then the read fails: the class starts without her`, async () => {
      const { entry, room, riders } = await openRoom(2);
      const [host, absent] = riders as [Rider, Rider];
      const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
      const read = failingReadAtGate();
      try {
        hostSeat.client.send('room', { type: 'start-class', order: 'random' });
        await until(() => read.reads.includes(absent.account.id), 2000, 'the read of her profile');
        if (how === 'kicked') services.rooms.hostAction(entry.code, host.account.id, { type: 'kick', accountId: absent.account.id });
        else services.rooms.leave(entry.code, absent.account.id);
        read.fail();
        await until(() => hostSeat.client.state.phase === 'walk' || refusals(hostSeat).length > 0, 3000, 'the start or its refusal');
        expect(refusals(hostSeat)).toEqual([]);
        expect(hostSeat.client.state.phase).toBe('walk');
        await until(() => hostSeat.client.state.phase === 'riding', 5000, "phase 'riding'");
        expect([...hostSeat.client.state.riders.keys()]).toEqual([host.account.id]);
      } finally {
        read.accounts.getPublicProfile = read.original;
      }
      await hostSeat.client.leave();
    }, 30000);
  }

  it('the rider connects while her profile is being read (onAuth brings it), then the read fails: the class starts with her, named from her own connection', async () => {
    const { entry, room, riders } = await openRoom(2);
    const [host, absent] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const read = failingReadAtGate();
    try {
      hostSeat.client.send('room', { type: 'start-class', order: 'random' });
      await until(() => read.reads.includes(absent.account.id), 2000, 'the read of her profile');
      const absentSeat = await sit(room.roomId, entry.code, absent.token, absent.account.id);
      await until(() => hostSeat.client.state.participants.get(absent.account.id)?.riderName === absent.account.riderName, 2000, 'her connection seated');
      read.fail();
      await until(() => hostSeat.client.state.phase === 'walk' || refusals(hostSeat).length > 0, 3000, 'the start or its refusal');
      expect(refusals(hostSeat)).toEqual([]);
      expect(hostSeat.client.state.phase).toBe('walk');
      await until(() => hostSeat.client.state.phase === 'riding', 5000, "phase 'riding'");
      expect(hostSeat.client.state.riders.get(absent.account.id)).toMatchObject({ riderName: absent.account.riderName, ponyName: 'Dakota', heightClass: 70 });
      await absentSeat.client.leave();
    } finally {
      read.accounts.getPublicProfile = read.original;
    }
    await hostSeat.client.leave();
  }, 30000);

  it('a rider still admitted whose profile is still unknown when the read fails: the start is refused and nothing starts (the guard stays)', async () => {
    const { entry, room, riders } = await openRoom(2);
    const [host, absent] = riders as [Rider, Rider];
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const read = failingReadAtGate();
    try {
      hostSeat.client.send('room', { type: 'start-class', order: 'random' });
      await until(() => read.reads.includes(absent.account.id), 2000, 'the read of her profile');
      read.fail();
      await until(() => refusals(hostSeat).length > 0, 2000, 'the refusal');
      expect(refusals(hostSeat)).toEqual(['class-not-ready']);
      await sleep(200);
      expect(hostSeat.client.state.phase).toBe('lobby');
    } finally {
      read.accounts.getPublicProfile = read.original;
    }
    await hostSeat.client.leave();
  }, 30000);
});

describe("the results boundary says whether another heat follows (audit K1 r3 #6)", () => {
  /** Every (phase, heat, nextHeat) the host's state goes through, in order, without repeats. */
  function phaseLog(seat: Seat): string[] {
    const log: string[] = [];
    seat.client.onStateChange((state) => {
      const entry = `${state.phase}#${String(state.heatIndex)}:${String(state.nextHeat)}`;
      if (log.at(-1) !== entry) log.push(entry);
    });
    return log;
  }
  const resultsOf = (log: string[]) => log.filter((entry) => entry.startsWith('results#'));

  /** The host (category C, 70) with three more riders of 70 and one of category D (80): heats [the four of 70], [the 80]. */
  async function classOfFive() {
    const { entry, room, riders } = await openRoom(4);
    const host = riders[0] as Rider;
    const dora = await registerRider(services, uniqueRiderName('Dora'), '1234', 'Nube', 'D');
    await services.rooms.requestJoin(entry.code, dora.account.id);
    services.rooms.hostAction(entry.code, host.account.id, { type: 'admit', accountId: dora.account.id });
    const hostSeat = await sit(room.roomId, entry.code, host.token, host.account.id);
    const log = phaseLog(hostSeat);
    await startRiding(hostSeat, 'lowest-class-first');
    const heats = (room as unknown as { flow: { schedule: { heats: readonly (readonly string[])[] } } }).flow.schedule.heats;
    expect(heats.map((heat) => heat.length)).toEqual([4, 1]);
    expect(heats[1]).toEqual([dora.account.id]);
    return { entry, host, dora, hostSeat, log };
  }

  it('a class of two riders is one heat: its results say no heat follows', async () => {
    const { entry, room, riders } = await openRoom(2);
    const hostSeat = await sit(room.roomId, entry.code, (riders[0] as Rider).token, (riders[0] as Rider).account.id);
    const log = phaseLog(hostSeat);
    await startRiding(hostSeat);
    await until(() => hostSeat.client.state.phase === 'done', 30000, "phase 'done'");
    expect(resultsOf(log)).toEqual(['results#0:false']);
    expect(hostSeat.client.state.nextHeat).toBe(false);
    await hostSeat.client.leave();
  }, 40000);

  it('a class of five is two heats: the first results say another heat follows, the last say none', async () => {
    const { hostSeat, log } = await classOfFive();
    await until(() => hostSeat.client.state.phase === 'done', 60000, "phase 'done'");
    expect(resultsOf(log)).toEqual(['results#0:true', 'results#1:false']);
    await hostSeat.client.leave();
  }, 70000);

  it('the only rider of the next heat is kicked during the first: the first results say no heat follows, and the class is done after them', async () => {
    const { entry, host, dora, hostSeat, log } = await classOfFive();
    expect(services.rooms.hostAction(entry.code, host.account.id, { type: 'kick', accountId: dora.account.id }).ok).toBe(true);
    await until(() => hostSeat.client.state.phase === 'done', 30000, "phase 'done'");
    expect(resultsOf(log)).toEqual(['results#0:false']);
    // Straight to 'done': the emptied heat is never walked nor ridden.
    expect(log.at(-1)).toMatch(/^done#\d+:false$/);
    expect(log.filter((entry) => entry.startsWith('walk#1') || entry.startsWith('riding#1'))).toEqual([]);
    await hostSeat.client.leave();
  }, 40000);
});
