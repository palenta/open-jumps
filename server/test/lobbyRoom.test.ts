// Matrix rows 1, 2 and 20 in the live room: the HttpOnly cookie alone signs a browser in; Origin is enforced
// on matchmaking and on the WebSocket upgrade; admission is checked for the room actually joined; a kick
// between reservation and connection still refuses; a kick disconnects at once; host-only messages are refused;
// the state a client receives carries exactly the public fields; emotes relay only ids of the closed list
// (finding A); a session revocation (PIN reset, logout) drops the account's live connections at once (finding B).
import { Server, type AuthContext, type Client } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ColyseusSDK } from '@colyseus/sdk';
import { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION } from '../src/auth/sessions.js';
import {
  KICKED_CLOSE_CODE,
  LOBBY_ROOM_NAME,
  LobbyRoom,
  SESSION_REVOKED_CLOSE_CODE,
  type LobbyState,
} from '../src/colyseus/LobbyRoom.js';
import { createUpgradeGuard } from '../src/http/origin.js';
import { ADMIN_KEY, buildServices, registerRider, uniqueRiderName, type Services } from './helpers.js';

const ORIGIN = 'https://play.open-jumps.test';
const PORT = 2599;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

let colyseus: ColyseusTestServer;
let services: Services;

beforeAll(async () => {
  services = buildServices();
  LobbyRoom.configure({ sessions: services.sessions, accounts: services.accounts, rooms: services.rooms, allowedOrigins: [ORIGIN], results: services.repos.results });
  const gameServer = new Server({ transport: new WebSocketTransport({ beforeUpgrade: createUpgradeGuard([ORIGIN]) }) });
  gameServer.define(LOBBY_ROOM_NAME, LobbyRoom);
  // @colyseus/testing 0.18.6 boot(server, port) ignores `port` for a ready-made Server (listens on 2567):
  // listen on PORT ourselves so the SDK endpoint above is the one the server actually uses.
  await gameServer.listen(PORT);
  colyseus = new ColyseusTestServer(gameServer);
});

afterAll(async () => {
  await colyseus?.shutdown();
  await services?.repos.close();
});

/** A browser-like client: the HttpOnly cookie and the Origin travel as headers on matchmaking and on the upgrade. */
function clientFor(headers: Record<string, string>) {
  return new ColyseusSDK(ENDPOINT, { headers });
}
const browser = (token: string, origin: string | null = ORIGIN) =>
  clientFor({ cookie: `${SESSION.cookieName}=${token}`, ...(origin ? { origin } : {}) });

async function openRoom(prefix = 'Host') {
  const host = await registerRider(services, uniqueRiderName(prefix));
  const entry = services.rooms.createRoom(host.account.id, { clubId: null });
  const room = await colyseus.createRoom<LobbyRoom>(LOBBY_ROOM_NAME, { code: entry.code });
  return { host, entry, room };
}

async function admitted(entryCode: string, hostId: string, prefix: string) {
  const rider = await registerRider(services, uniqueRiderName(prefix));
  await services.rooms.requestJoin(entryCode, rider.account.id);
  services.rooms.hostAction(entryCode, hostId, { type: 'admit', accountId: rider.account.id });
  return rider;
}

const fakeClient = (sessionId: string) => ({ sessionId }) as unknown as Client;
/** Poll a condition for at most ~2 s (the server's own close event, not the client's). */
async function untilTrue(check: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}
const authContext = (headers: Record<string, string>): AuthContext => ({ ip: '127.0.0.1', headers: new Headers(headers) });

/**
 * The client's OWN decoded state once `check` holds on it (polled for at most ~3 s; the error names `what`).
 * room.waitForNextPatch() waits for the SERVER's next patch, not for this client to receive and decode it: under load
 * the client's state can still be empty, or a patch behind, after it (audit K1 r5 #4, #5). A test that reads a client's
 * state waits here instead.
 */
async function clientStateWhere(
  client: { state: unknown },
  check: (snapshot: Record<string, unknown>) => boolean,
  what: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i += 1) {
    let snapshot: Record<string, unknown> | undefined;
    try {
      snapshot = (client.state as { toJSON?: () => Record<string, unknown> } | undefined)?.toJSON?.();
    } catch {
      snapshot = undefined;
    }
    if (snapshot && check(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} within 3 s`);
}

/**
 * The first full state a joined client holds, as in classRoom.test.ts: joinById resolves on JOIN_ROOM, before ROOM_STATE
 * arrives (audit K1 r5 #4).
 */
const firstState = (client: { state: unknown }) =>
  clientStateWhere(client, (snapshot) => typeof snapshot.code === 'string' && snapshot.code !== '', 'no lobby state arrived');

describe('signing in to the live room', () => {
  it('the cookie alone (no options.sessionToken) connects an admitted host; the received state has exactly the public fields', async () => {
    const { host, entry, room } = await openRoom();
    const client = await browser(host.token).joinById<LobbyState>(room.roomId, { code: entry.code });
    const state = await firstState(client); // the client's own first state, not the server's next patch
    expect(room.clients).toHaveLength(1);
    // B2 added the class fields (phase, heatIndex, roundClockMs, riders; nextHeat with audit K1 r3 #6); still no names
    // of those waiting at the door.
    expect(Object.keys(state).sort()).toEqual(['code', 'entryOpen', 'heatIndex', 'hostId', 'nextHeat', 'participants', 'pendingCount', 'phase', 'riders', 'roundClockMs']);
    expect(state.hostId).toBe(host.account.id);
    const participants = state.participants as Record<string, Record<string, unknown>>;
    expect(Object.keys(participants)).toEqual([host.account.id]);
    expect(Object.keys(participants[host.account.id]!).sort()).toEqual(['accountId', 'isHost', 'ponyName', 'riderName']);
    expect(participants[host.account.id]).toMatchObject({ riderName: host.account.riderName, isHost: true });
    await client.leave();
  });

  it('options.sessionToken also works (non-browser clients), with an allowed Origin', async () => {
    const { host, entry, room } = await openRoom();
    const client = await clientFor({ origin: ORIGIN }).joinById(room.roomId, { code: entry.code, sessionToken: host.token });
    expect(room.clients).toHaveLength(1);
    await client.leave();
  });

  it('no cookie and no token → refused as no-session', async () => {
    const { entry, room } = await openRoom();
    await expect(clientFor({ origin: ORIGIN }).joinById(room.roomId, { code: entry.code })).rejects.toThrow(/no-session/);
    expect(room.clients).toHaveLength(0);
  });

  it('an expired cookie and a revoked cookie are refused as no-session', async () => {
    const { host, entry, room } = await openRoom();
    const other = await registerRider(services, uniqueRiderName('Reset'));
    await services.rooms.requestJoin(entry.code, other.account.id);
    services.rooms.hostAction(entry.code, host.account.id, { type: 'admit', accountId: other.account.id });
    await services.accounts.resetPin(ADMIN_KEY, other.account.id, '9999');
    await expect(browser(other.token).joinById(room.roomId, { code: entry.code })).rejects.toThrow(/no-session/);

    services.clock.advance(SESSION.ttlMs + 1);
    try {
      await expect(browser(host.token).joinById(room.roomId, { code: entry.code })).rejects.toThrow(/no-session/);
    } finally {
      services.clock.advance(-(SESSION.ttlMs + 1));
    }
    expect(room.clients).toHaveLength(0);
  });
});

describe('Origin on the live room (row 20)', () => {
  it('a valid cookie with a foreign or missing Origin is refused; the allowed Origin succeeds', async () => {
    const { host, entry, room } = await openRoom();
    await expect(browser(host.token, 'https://evil.example').joinById(room.roomId, { code: entry.code })).rejects.toThrow();
    await expect(browser(host.token, null).joinById(room.roomId, { code: entry.code })).rejects.toThrow();
    expect(room.clients).toHaveLength(0);
    const client = await browser(host.token).joinById(room.roomId, { code: entry.code });
    expect(room.clients).toHaveLength(1);
    await client.leave();
  });

  it('onAuth itself names the refusal: bad-origin before anything else', async () => {
    const { host, entry, room } = await openRoom();
    const bad = authContext({ cookie: `${SESSION.cookieName}=${host.token}`, origin: 'https://evil.example' });
    await expect(room.onAuth(fakeClient('s1'), { code: entry.code }, bad)).rejects.toThrow(/bad-origin/);
    const none = authContext({ cookie: `${SESSION.cookieName}=${host.token}` });
    await expect(room.onAuth(fakeClient('s2'), { code: entry.code }, none)).rejects.toThrow(/bad-origin/);
  });
});

describe('admission is to the room actually joined (row 1)', () => {
  it('an account admitted to room A cannot join room B by sending code A', async () => {
    const a = await openRoom('HostA');
    const b = await openRoom('HostB');
    const rider = await admitted(a.entry.code, a.host.account.id, 'Guest');
    await expect(browser(rider.token).joinById(b.room.roomId, { code: a.entry.code })).rejects.toThrow(/not-admitted/);
    expect(b.room.clients).toHaveLength(0);
    const client = await browser(rider.token).joinById(a.room.roomId, { code: a.entry.code });
    expect(a.room.clients).toHaveLength(1);
    await client.leave();
  });

  it('a kick between onAuth and onJoin refuses the join', async () => {
    const { host, entry, room } = await openRoom();
    const rider = await admitted(entry.code, host.account.id, 'Late');
    const context = authContext({ cookie: `${SESSION.cookieName}=${rider.token}`, origin: ORIGIN });
    const auth = await room.onAuth(fakeClient('s3'), { code: entry.code }, context);
    expect(auth).toEqual({ accountId: rider.account.id });
    services.rooms.hostAction(entry.code, host.account.id, { type: 'kick', accountId: rider.account.id });
    expect(() => room.onJoin(fakeClient('s3'), { code: entry.code }, auth)).toThrow(/not-admitted/);
  });

  it('a kick by the host disconnects the kicked client immediately and blocks reconnection', async () => {
    const { host, entry, room } = await openRoom();
    const friend = await admitted(entry.code, host.account.id, 'Friend');
    const hostClient = await browser(host.token).joinById(room.roomId, { code: entry.code });
    const friendClient = await browser(friend.token).joinById(room.roomId, { code: entry.code });
    await room.waitForNextPatch();
    expect(room.clients).toHaveLength(2);

    const left = new Promise<number>((resolve) => friendClient.onLeave((code) => resolve(code)));
    hostClient.send('room', { type: 'kick', accountId: friend.account.id });
    expect(await left).toBe(KICKED_CLOSE_CODE);
    // Server and client run in one process here: the client's close event can fire a tick before the server's
    // socket reports the close, so wait for the room itself to register the departure (bounded).
    await untilTrue(() => room.clients.length === 1);
    expect(room.clients).toHaveLength(1);
    await expect(browser(friend.token).joinById(room.roomId, { code: entry.code })).rejects.toThrow(/not-admitted/);
    await hostClient.leave();
  });
});

describe('messages (rows 20, 21)', () => {
  it('a non-host sending a host-only message is refused and nothing changes; malformed messages are ignored; the host succeeds', async () => {
    const { host, entry, room } = await openRoom();
    const friend = await admitted(entry.code, host.account.id, 'Member');
    const third = await registerRider(services, uniqueRiderName('Third'));
    await services.rooms.requestJoin(entry.code, third.account.id);
    const hostClient = await browser(host.token).joinById(room.roomId, { code: entry.code });
    const friendClient = await browser(friend.token).joinById(room.roomId, { code: entry.code });
    await room.waitForNextPatch();

    const refused = new Promise<unknown>((resolve) => friendClient.onMessage('refused', (payload) => resolve(payload)));
    friendClient.send('room', { type: 'admit', accountId: third.account.id });
    expect(await refused).toEqual({ error: 'host-only' });
    expect(services.rooms.statusOf(entry.code, third.account.id)).toBe('pending');

    friendClient.send('room', { type: 'nuke', everything: true });
    friendClient.send('room', 'not an object');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(room.clients).toHaveLength(2);
    expect(services.rooms.statusOf(entry.code, third.account.id)).toBe('pending');

    hostClient.send('room', { type: 'admit', accountId: third.account.id });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(services.rooms.statusOf(entry.code, third.account.id)).toBe('admitted');
    await friendClient.leave();
    await hostClient.leave();
  });

  it('pendingCount in the state follows the door, without exposing names of those waiting', async () => {
    const { host, entry, room } = await openRoom();
    const hostClient = await browser(host.token).joinById<LobbyState>(room.roomId, { code: entry.code });
    const waiting = await registerRider(services, uniqueRiderName('Waiting'));
    await services.rooms.requestJoin(entry.code, waiting.account.id);
    // The host client's own state, not the server's next patch (audit K1 r5 #5).
    await clientStateWhere(hostClient, (snapshot) => snapshot.pendingCount === 1, "the host client's state did not show pendingCount 1");
    expect(hostClient.state.pendingCount).toBe(1);
    expect(JSON.stringify(hostClient.state.toJSON())).not.toContain(waiting.account.riderName);
    await hostClient.leave();
  });

  it('a known emote reaches the other client as exactly { from, emote }; an unknown id and free text are never relayed', async () => {
    const { host, entry, room } = await openRoom();
    const fan = await admitted(entry.code, host.account.id, 'Fan');
    const hostClient = await browser(host.token).joinById(room.roomId, { code: entry.code });
    const fanClient = await browser(fan.token).joinById(room.roomId, { code: entry.code });
    await room.waitForNextPatch();
    const received: unknown[] = [];
    hostClient.onMessage('emote', (payload) => received.push(payload));

    fanClient.send('room', { type: 'emote', emote: 'bravo' });
    await untilTrue(() => received.length === 1);
    expect(received).toEqual([{ from: fan.account.id, emote: 'bravo' }]);
    expect(Object.keys(received[0] as object).sort()).toEqual(['emote', 'from']);

    fanClient.send('room', { type: 'emote', emote: 'side-eye' });
    fanClient.send('room', { type: 'emote', emote: 'hola, ¿quedamos luego en el parque?' });
    fanClient.send('room', { type: 'emote', emote: '¡Bravo!' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(1);
    expect(room.clients).toHaveLength(2);
    await fanClient.leave();
    await hostClient.leave();
  });
});

describe('session revocation reaches the live room (finding B)', () => {
  it('a PIN reset drops the friend’s live connection with SESSION_REVOKED_CLOSE_CODE, keeps the host, and the old cookie cannot rejoin', async () => {
    const { host, entry, room } = await openRoom();
    const friend = await admitted(entry.code, host.account.id, 'Friend');
    const hostClient = await browser(host.token).joinById<LobbyState>(room.roomId, { code: entry.code });
    const friendClient = await browser(friend.token).joinById(room.roomId, { code: entry.code });
    await room.waitForNextPatch();
    expect(room.clients).toHaveLength(2);
    let hostLeftWith: number | null = null;
    hostClient.onLeave((code) => {
      hostLeftWith = code;
    });

    const left = new Promise<number>((resolve) => friendClient.onLeave((code) => resolve(code)));
    const reset = await services.accounts.resetPin(ADMIN_KEY, friend.account.id, '9999');
    expect(reset.ok).toBe(true);
    expect(await left).toBe(SESSION_REVOKED_CLOSE_CODE);
    await untilTrue(() => room.clients.length === 1 && !room.state.participants.has(friend.account.id));
    expect(room.clients).toHaveLength(1);
    expect(room.state.participants.has(friend.account.id)).toBe(false);
    expect(room.state.participants.has(host.account.id)).toBe(true);
    expect(hostLeftWith).toBeNull();

    await expect(browser(friend.token).joinById(room.roomId, { code: entry.code })).rejects.toThrow(/no-session/);
    expect(room.clients).toHaveLength(1);
    // The host's connection still works: a host command goes through and the door state follows.
    hostClient.send('room', { type: 'set-entry', open: false });
    await untilTrue(() => hostClient.state.entryOpen === false);
    expect(hostClient.state.entryOpen).toBe(false);
    expect(hostLeftWith).toBeNull();
    await hostClient.leave();
  });

  it('revoking every session of the host (logout) closes the host’s own connection the same way', async () => {
    const { host, entry, room } = await openRoom();
    const hostClient = await browser(host.token).joinById(room.roomId, { code: entry.code });
    await room.waitForNextPatch();
    expect(room.clients).toHaveLength(1);

    const left = new Promise<number>((resolve) => hostClient.onLeave((code) => resolve(code)));
    await services.sessions.revokeAll(host.account.id);
    expect(await left).toBe(SESSION_REVOKED_CLOSE_CODE);
    await untilTrue(() => room.clients.length === 0);
    expect(room.clients).toHaveLength(0);
    await expect(browser(host.token).joinById(room.roomId, { code: entry.code })).rejects.toThrow(/no-session/);
  });

  it('a revocation between onAuth and onJoin refuses the join synchronously as no-session', async () => {
    const { host, entry, room } = await openRoom();
    const rider = await admitted(entry.code, host.account.id, 'Gap');
    const context = authContext({ cookie: `${SESSION.cookieName}=${rider.token}`, origin: ORIGIN });
    const auth = await room.onAuth(fakeClient('sX'), { code: entry.code }, context);
    expect(auth).toEqual({ accountId: rider.account.id });
    await services.accounts.resetPin(ADMIN_KEY, rider.account.id, '9999');
    expect(() => room.onJoin(fakeClient('sX'), { code: entry.code }, auth)).toThrow(/no-session/);
    expect(room.clients).toHaveLength(0);
    expect(room.state.participants.has(rider.account.id)).toBe(false);
  });
});
