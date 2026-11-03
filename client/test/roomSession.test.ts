// The room session against the real server (plan 2.2, 2.3; matrix row 8 client side, row 20): joining by the
// roomId the doorbell handed out, the state as snapshots, every message typed, the clock pings answered so the
// server's clock becomes ready for THIS device, the course announced, and the three ways a session ends plus
// the one way back — a drop followed by resume() reconnects by token.
import { matchMaker } from 'colyseus';
import type { LobbyState } from '../../server/src/colyseus/LobbyRoom.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoomSession, type SessionStatus } from '../src/net/roomSession.js';
import { KICKED_CLOSE_CODE, type RoundEventWire, type ServerMessage } from '../src/net/types.js';
import { bootApp, LIVE_COURSE, newDevice, sleep, until, type Device, type LiveApp } from './helpers.js';

/** An application close code that is a plain drop to the server (anything but consented 4000, kicked 4100, revoked 4101). */
const DROP_CODE = 4005;

let live: LiveApp;

beforeAll(async () => {
  live = await bootApp();
});

afterAll(async () => {
  await live?.close();
});

interface Seat {
  device: Device;
  session: RoomSession;
  messages: ServerMessage[];
  statuses: SessionStatus[];
  states: number;
}

/** Connect a device to a room, recording every message, status change and state patch. */
async function sit(device: Device, roomId: string, code: string, autoReconnect = true): Promise<Seat> {
  const session = new RoomSession({ sdk: device.sdk(), clock: device.clock, autoReconnect });
  const seat: Seat = { device, session, messages: [], statuses: [], states: 0 };
  session.onMessage((m) => seat.messages.push(m));
  session.onStatus((s) => seat.statuses.push(s));
  session.onState(() => {
    seat.states += 1;
  });
  await session.connect(roomId, code);
  return seat;
}

const events = (seat: Seat, type: RoundEventWire['type'], riderId?: string) =>
  seat.messages
    .filter((m): m is Extract<ServerMessage, { type: 'round-event' }> => m.type === 'round-event')
    .map((m) => m.event)
    .filter((e) => e.type === type && (riderId === undefined || e.riderId === riderId));
const refusals = (seat: Seat) => seat.messages.filter((m): m is Extract<ServerMessage, { type: 'refused' }> => m.type === 'refused').map((m) => m.error);

async function openRoom(host: Device): Promise<{ code: string; roomId: string }> {
  const created = await host.api.createRoom();
  if (!created.ok || created.value.roomId === undefined) throw new Error('no live room');
  return { code: created.value.code, roomId: created.value.roomId };
}

describe('RoomSession', () => {
  it('connect: the first full state is there on resolve; status connected; patches and messages flow; pings are answered', async () => {
    const host = await newDevice(live, 'SessHost', 5000); // this device's clock runs 5 s ahead of the server
    const { code, roomId } = await openRoom(host);
    const seat = await sit(host, roomId, code);
    expect(seat.session.status).toBe('connected');
    expect(seat.statuses).toEqual(['connecting', 'connected']);
    expect(seat.session.state).toMatchObject({ code, hostId: host.profile.id, phase: 'lobby', heatIndex: -1, roundClockMs: 0 });
    expect(seat.session.state?.participants[host.profile.id]).toMatchObject({ accountId: host.profile.id, riderName: host.profile.riderName, ponyName: 'Dakota', isHost: true });
    expect(seat.session.reconnectionToken).toEqual(expect.any(String));
    expect(seat.session.course()).toBeNull(); // no class yet

    // The clock series: 8 pings reach the message listeners too, and the ClientClock became ready from them.
    await until(() => seat.messages.filter((m) => m.type === 'clock-ping').length >= 8, 5000, 'the clock series');
    expect(host.clock.ready()).toBe(true);
    expect(host.clock.offset()).toBeGreaterThan(-5100); // server − client ≈ −5000 on a loopback network
    expect(host.clock.offset()).toBeLessThan(-4900);

    // A rider command before the class: refused as 'not-riding' — and never 'clock-not-ready', the pongs went out.
    seat.session.send({ type: 'tap', clientTime: host.clock.now(), fence: 1, attempt: 1 });
    await until(() => refusals(seat).length > 0, 2000, 'the refusal');
    expect(refusals(seat)).toEqual(['not-riding']);

    // The class: the course is announced, phases arrive as messages and as state, a tap at t0 is translated.
    const statesBefore = seat.states;
    seat.session.send({ type: 'start-class', order: 'random' });
    await until(() => seat.session.state?.phase === 'walk', 5000, "phase 'walk'");
    expect(seat.messages.find((m) => m.type === 'class-course')).toEqual({ type: 'class-course', course: LIVE_COURSE, classNumber: 1 });
    expect(seat.session.course()).toEqual(LIVE_COURSE);
    await until(() => seat.session.state?.phase === 'riding', 5000, "phase 'riding'");
    expect(seat.messages.filter((m) => m.type === 'class-phase').map((m) => (m as { phase: string }).phase)).toEqual(['walk', 'riding']);
    expect(seat.states).toBeGreaterThan(statesBefore);
    await until(() => events(seat, 'approach', host.profile.id).length > 0, 8000, 'the approach');
    const approach = events(seat, 'approach', host.profile.id)[0] as Extract<RoundEventWire, { type: 'approach' }>;
    const tapAt = host.clock.toClient(approach.t0);
    if (tapAt === null) throw new Error('clock not ready');
    await sleep(Math.max(0, tapAt + 100 - host.clock.now())); // aim 100 ms after t0: the clean tier, not perfect
    seat.session.send({ type: 'tap', clientTime: host.clock.now(), fence: approach.fence, attempt: approach.attempt });
    await until(() => events(seat, 'takeoff', host.profile.id).length > 0, 5000, 'the take-off');
    const takeoff = events(seat, 'takeoff', host.profile.id)[0] as Extract<RoundEventWire, { type: 'takeoff' }>;
    expect(takeoff.offsetMs).not.toBeNull();
    expect(takeoff.offsetMs ?? 0).toBeGreaterThan(40); // the device's 5 s skew was translated away by the server
    expect(takeoff.offsetMs ?? 0).toBeLessThan(170);
    expect(['clean', 'perfect']).toContain(takeoff.outcome.kind);
    await until(() => seat.session.state?.phase === 'done', 20000, "phase 'done'");
    const table = seat.messages.find((m): m is Extract<ServerMessage, { type: 'class-table' }> => m.type === 'class-table');
    expect(table?.table['70']?.[0]).toMatchObject({ riderId: host.profile.id, place: 1, status: 'finished' });

    await seat.session.leave();
    expect(seat.session.status).toBe('ended');
    expect(seat.session.end).toEqual({ kind: 'left', code: expect.any(Number) });
    expect(seat.statuses.at(-1)).toBe('ended');
  }, 40000);

  it('a late joiner is told the course of the running class on join', async () => {
    const host = await newDevice(live, 'LateHost');
    const friend = await newDevice(live, 'LateFriend');
    const { code, roomId } = await openRoom(host);
    await friend.api.knock(code);
    await host.api.door(code, 'admit', friend.profile.id);
    const hostSeat = await sit(host, roomId, code);
    hostSeat.session.send({ type: 'start-class', order: 'random' });
    await until(() => hostSeat.session.state?.phase === 'walk', 5000, "phase 'walk'");
    const friendSeat = await sit(friend, roomId, code);
    await until(() => friendSeat.session.course() !== null, 2000, 'the course for the late joiner');
    expect(friendSeat.session.course()).toEqual(LIVE_COURSE);
    await friendSeat.session.leave();
    await hostSeat.session.leave();
  }, 20000);

  it('kicked by the host: the session ends with kind kicked and the close code 4100', async () => {
    const host = await newDevice(live, 'KickHost');
    const friend = await newDevice(live, 'KickFriend');
    const { code, roomId } = await openRoom(host);
    await friend.api.knock(code);
    await host.api.door(code, 'admit', friend.profile.id);
    const seat = await sit(friend, roomId, code);
    expect(seat.session.state?.participants[friend.profile.id]).toBeDefined();
    await host.api.door(code, 'kick', friend.profile.id);
    await until(() => seat.session.status === 'ended', 5000, 'the kicked session to end');
    expect(seat.session.end).toEqual({ kind: 'kicked', code: KICKED_CLOSE_CODE });
    expect(() => seat.session.send({ type: 'emote', emote: 'bravo' })).not.toThrow(); // sending after the end is a no-op
  }, 15000);

  /** The host alone in her room, the class started and riding, her clock ready (a seat the server will keep on a drop). */
  async function ridingAlone(autoReconnect: boolean): Promise<{ host: Device; seat: Seat; roomId: string; code: string }> {
    const host = await newDevice(live, 'RideHost');
    const { code, roomId } = await openRoom(host);
    const seat = await sit(host, roomId, code, autoReconnect);
    seat.session.send({ type: 'start-class', order: 'random' });
    await until(() => seat.session.state?.phase === 'riding' && seat.session.state.riders[host.profile.id] !== undefined, 5000, 'riding');
    await until(() => host.clock.ready(), 5000, 'the clock');
    return { host, seat, roomId, code };
  }

  /** The server's own view of a rider's autopilot flag (the room state, not a client's copy). */
  function autopilotOnServer(roomId: string, accountId: string): boolean | undefined {
    const state = matchMaker.getLocalRoomById(roomId).state as LobbyState;
    return state.riders.get(accountId)?.autopilot;
  }

  /**
   * The network goes away under the client (a locked phone): the server closes the socket with a code that is
   * NOT a consented leave (Colyseus's CloseCode.CONSENTED is 4000 — that one would mean "she left on purpose").
   */
  function dropFromServer(roomId: string): void {
    const serverRoom = matchMaker.getLocalRoomById(roomId);
    expect(serverRoom.clients).toHaveLength(1);
    serverRoom.clients[0]?.leave(DROP_CODE);
  }

  it('in the lobby a drop has no seat to come back to (the server keeps seats only during a heat): resume() is false, the session ends as lost, and a fresh connect gets the rider back in', async () => {
    const host = await newDevice(live, 'LobbyDrop');
    const { code, roomId } = await openRoom(host);
    const seat = await sit(host, roomId, code, false);
    expect(await seat.session.resume()).toBe(true); // connected already: nothing to do
    dropFromServer(roomId);
    await until(() => seat.session.status === 'dropped', 5000, 'the drop');
    expect(seat.session.end).toBeNull();
    expect(() => seat.session.send({ type: 'emote', emote: 'bravo' })).not.toThrow(); // dropped silently
    expect(await seat.session.resume()).toBe(false);
    expect(seat.session.status).toBe('ended');
    expect(seat.session.end?.kind).toBe('lost');
    expect(seat.statuses).toEqual(['connecting', 'connected', 'dropped', 'connecting', 'ended']);
    // The app's way back from 'lost' outside a heat: the doorbell still knows her, so a new session simply joins again.
    const again = await sit(host, roomId, code, false);
    expect(again.session.status).toBe('connected');
    expect(again.session.state?.participants[host.profile.id]).toBeDefined();
    await again.session.leave();
  }, 20000);

  it('while riding, a drop puts the horse on autopilot and resume() reconnects by token: the rider is back in control and her commands flow again', async () => {
    const { host, seat, roomId } = await ridingAlone(false);
    const tokenBefore = seat.session.reconnectionToken;
    dropFromServer(roomId);
    await until(() => seat.session.status === 'dropped', 5000, 'the drop');
    expect(seat.session.end).toBeNull();
    // While she is away the server drives her horse (read from the room's own state: no patch reaches a dropped client).
    await until(() => autopilotOnServer(roomId, host.profile.id) === true, 3000, 'autopilot on the server while she is away');

    // The tab is visible again: resume reconnects with the token the server honours (allowReconnection during a heat).
    expect(await seat.session.resume()).toBe(true);
    expect(seat.session.status).toBe('connected');
    expect(seat.session.reconnectionToken).toEqual(expect.any(String));
    expect(seat.session.reconnectionToken).not.toBe(tokenBefore); // a new connection, a new token
    expect(seat.statuses).toEqual(['connecting', 'connected', 'dropped', 'connecting', 'connected']);
    await until(() => seat.session.state?.riders[host.profile.id]?.autopilot === false, 5000, 'autopilot off after the return');
    expect(seat.session.state?.phase).toBe('riding');
    seat.session.send({ type: 'gear', gear: 'extended' }); // a rider command on the new connection reaches her horse
    await until(() => seat.session.state?.riders[host.profile.id]?.gear === 'extended', 3000, 'the gear change');
    expect(refusals(seat)).toEqual([]);
    await seat.session.leave();
  }, 25000);

  it('a seat the server revoked while the rider was away (PIN reset): resume() is false and the session ends as lost', async () => {
    const { host, seat, roomId } = await ridingAlone(false);
    dropFromServer(roomId);
    await until(() => seat.session.status === 'dropped', 5000, 'the drop');
    await live.services.accounts.resetPin('test-admin-key-do-not-use-in-production', host.profile.id, '4321');
    await sleep(100);
    expect(await seat.session.resume()).toBe(false);
    expect(seat.session.status).toBe('ended');
    expect(seat.session.end?.kind).toBe('lost');
  }, 25000);
});
