// Plan 2.2: one host for everything. configFromEnv turns the environment into a validated config (no secrets
// in code; every mistake names its variable); createApp serves the HTTP API, the built client files and the
// Colyseus WebSocket from one http server on one port, so one deployment behind one Origin is enough.
// The live room is reached the way a browser reaches it: register and create the room through the app's own
// API (cookie + Origin), then joinById(roomId) over the app's own WebSocket with the cookie alone — and that is
// the only way in: the match-maker's own create/joinOrCreate/join are not exposed to clients.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ColyseusSDK, type Room, type SeatReservation } from '@colyseus/sdk';
import { matchMaker } from 'colyseus';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { createApp, type App } from '../src/app.js';
import { SESSION } from '../src/auth/sessions.js';
import { LOBBY_ROOM_NAME, type LobbyState } from '../src/colyseus/LobbyRoom.js';
import { configFromEnv, type ServerEnv } from '../src/index.js';
import { ADMIN_KEY, buildServices, uniqueRiderName, type Services } from './helpers.js';

const ORIGIN = 'https://play.open-jumps.test';
const EVIL_ORIGIN = 'https://evil.example';

describe('configFromEnv', () => {
  const minimal: ServerEnv = { ADMIN_KEY: 'k', ALLOWED_ORIGINS: ORIGIN };

  it('ADMIN_KEY and ALLOWED_ORIGINS are required; the error names the missing variable', () => {
    expect(() => configFromEnv({})).toThrow(/ADMIN_KEY/);
    expect(() => configFromEnv({ ADMIN_KEY: 'k' })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => configFromEnv({ ADMIN_KEY: 'k', ALLOWED_ORIGINS: '' })).toThrow(/ALLOWED_ORIGINS/);
  });

  it('a minimal env gives the documented defaults', () => {
    expect(configFromEnv(minimal)).toEqual({
      port: 8080,
      host: '0.0.0.0',
      adminKey: 'k',
      allowedOrigins: [ORIGIN],
      dbPath: './data/open-jumps.sqlite',
      staticDir: null,
      secureCookies: true,
    });
  });

  it('every variable is read: PORT, HOST, DB_PATH, STATIC_DIR, SECURE_COOKIES', () => {
    expect(
      configFromEnv({ ...minimal, PORT: '3000', HOST: '127.0.0.1', DB_PATH: '/var/lib/open-jumps/db.sqlite', STATIC_DIR: '/srv/open-jumps/client', SECURE_COOKIES: 'false' }),
    ).toEqual({
      port: 3000,
      host: '127.0.0.1',
      adminKey: 'k',
      allowedOrigins: [ORIGIN],
      dbPath: '/var/lib/open-jumps/db.sqlite',
      staticDir: '/srv/open-jumps/client',
      secureCookies: false,
    });
  });

  it('ALLOWED_ORIGINS is split on commas and trimmed; an origin keeps its port', () => {
    expect(configFromEnv({ ...minimal, ALLOWED_ORIGINS: 'https://a.test, https://b.test' }).allowedOrigins).toEqual(['https://a.test', 'https://b.test']);
    expect(configFromEnv({ ...minimal, ALLOWED_ORIGINS: 'http://localhost:5173' }).allowedOrigins).toEqual(['http://localhost:5173']);
  });

  it('an origin with a path, or without a scheme, is refused naming ALLOWED_ORIGINS — even as one entry of a list', () => {
    expect(() => configFromEnv({ ...minimal, ALLOWED_ORIGINS: 'https://a.test/x' })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => configFromEnv({ ...minimal, ALLOWED_ORIGINS: 'a.test' })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => configFromEnv({ ...minimal, ALLOWED_ORIGINS: 'https://a.test, b.test' })).toThrow(/ALLOWED_ORIGINS/);
  });

  it('PORT must be an integer 1–65535', () => {
    for (const bad of ['abc', '0', '70000']) expect(() => configFromEnv({ ...minimal, PORT: bad }), bad).toThrow(/PORT/);
    expect(configFromEnv({ ...minimal, PORT: '1' }).port).toBe(1);
    expect(configFromEnv({ ...minimal, PORT: '65535' }).port).toBe(65535);
  });

  it("SECURE_COOKIES accepts only 'true' and 'false'", () => {
    expect(configFromEnv({ ...minimal, SECURE_COOKIES: 'false' }).secureCookies).toBe(false);
    expect(configFromEnv({ ...minimal, SECURE_COOKIES: 'true' }).secureCookies).toBe(true);
    expect(() => configFromEnv({ ...minimal, SECURE_COOKIES: 'maybe' })).toThrow(/SECURE_COOKIES/);
  });

  it('an empty STATIC_DIR is the same as none: null', () => {
    expect(configFromEnv({ ...minimal, STATIC_DIR: '' }).staticDir).toBeNull();
  });
});

const INDEX_HTML = '<!doctype html><title>Open Jumps</title><script type="module" src="/app.js"></script>\n';
const APP_JS = 'console.log("Open Jumps client");\n';
const OUTSIDE_TXT = 'one level above staticDir: must never be served\n';

interface Running {
  app: App;
  port: number;
  base: string;
  services: Services;
  root: string;
}

/** `<root>/public/{index.html,app.js}` is the static directory; `<root>/outside.txt` is what a traversal would reach. */
function clientFiles(): { root: string; staticDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'open-jumps-app-'));
  const staticDir = join(root, 'public');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(staticDir, 'app.js'), APP_JS);
  writeFileSync(join(root, 'outside.txt'), OUTSIDE_TXT);
  return { root, staticDir };
}

/** A fresh app on a random port (never a fixed one: other test files bind their own). */
async function start(withStaticFiles: boolean): Promise<Running> {
  const { root, staticDir } = clientFiles();
  const services = buildServices();
  const app = createApp({
    api: {
      accounts: services.accounts,
      sessions: services.sessions,
      clubs: services.clubs,
      rooms: services.rooms,
      config: { allowedOrigins: [ORIGIN], secureCookies: true, adminKey: ADMIN_KEY },
    },
    results: services.repos.results,
    staticDir: withStaticFiles ? staticDir : null,
  });
  const port = await app.listen(0, '127.0.0.1');
  return { app, port, base: `http://127.0.0.1:${port}`, services, root };
}

async function stop(running: Running | undefined): Promise<void> {
  if (!running) return;
  try {
    await running.app.close();
  } finally {
    await running.services.repos.close();
    rmSync(running.root, { recursive: true, force: true });
  }
}

interface Call {
  method?: string;
  body?: unknown;
  cookie?: string;
  /** null sends no Origin header at all. */
  origin?: string | null;
}

/** A browser-like API call: JSON in/out, the session cookie and the Origin as headers (Origin allowed by default). */
async function call(base: string, path: string, { method = 'GET', body, cookie, origin = ORIGIN }: Call = {}) {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as Record<string, unknown> | null, setCookie: res.headers.get('set-cookie') };
}

/** `name=value` of the session cookie the API set — what a browser sends back on every request and on the upgrade. */
const cookieOf = (setCookie: string | null): string => setCookie?.split(';')[0] ?? '';

/** Register a rider through the API; the cookie it returns is the only credential the rest of the flow uses. */
async function register(base: string, riderName: string): Promise<{ id: string; cookie: string }> {
  const res = await call(base, '/api/accounts', {
    method: 'POST',
    body: { riderName, pin: '1234', riderGender: 'girl', ponyName: 'Dakota', ponyGender: 'yegua' },
  });
  expect(res.status).toBe(201);
  const cookie = cookieOf(res.setCookie);
  expect(cookie.startsWith(`${SESSION.cookieName}=`)).toBe(true);
  return { id: String((res.json as { account: { id: string } }).account.id), cookie };
}

/** Create a room through the API: with liveRooms wired (createApp does), the answer carries the Colyseus roomId. */
async function createRoom(base: string, hostCookie: string): Promise<{ code: string; roomId: string }> {
  const res = await call(base, '/api/rooms', { method: 'POST', body: {}, cookie: hostCookie });
  expect(res.status).toBe(201);
  const { code, roomId } = res.json as { code: string; roomId?: unknown };
  expect(typeof code).toBe('string');
  expect(typeof roomId, 'POST /api/rooms through createApp answers with the live roomId').toBe('string');
  expect(roomId).not.toBe('');
  return { code, roomId: String(roomId) };
}

/**
 * The matchmaking step on its own, the way the SDK does it (POST /matchmake/joinById/:roomId with the join
 * options as JSON): a valid seat reservation, obtained with the allowed Origin and the account's cookie, so the
 * WebSocket upgrade of that very reservation can then be attempted under other headers.
 */
async function reserveSeat(base: string, roomId: string, code: string, cookie: string): Promise<SeatReservation> {
  const res = await fetch(`${base}/matchmake/joinById/${roomId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({ code }),
  });
  expect(res.status, 'the seat reservation with the allowed Origin and the host cookie').toBe(200);
  const reservation = (await res.json()) as SeatReservation;
  expect(reservation.roomId).toBe(roomId);
  expect(typeof reservation.sessionId).toBe('string');
  return reservation;
}

/** The WebSocket endpoint the SDK derives from a reservation (`/<processId>/<roomId>?sessionId=<sessionId>`). */
const upgradeUrl = (port: number, r: SeatReservation): string => `ws://127.0.0.1:${port}/${r.processId}/${r.roomId}?sessionId=${r.sessionId}`;

/**
 * Attempt the WebSocket upgrade itself with raw headers and report how the server answered it: the HTTP status
 * of a refused upgrade (the `unexpected-response` of `ws`), or 'opened' when the server switched protocols.
 */
function upgradeOutcome(url: string, headers: Record<string, string>): Promise<number | 'opened'> {
  return new Promise((resolve, reject) => {
    const ws = new NodeWebSocket(url, { headers });
    ws.on('unexpected-response', (req, res) => {
      res.resume();
      req.destroy();
      resolve(res.statusCode ?? 0);
    });
    ws.on('open', () => {
      ws.close();
      resolve('opened');
    });
    ws.on('error', reject);
  });
}

/** The rejection of a promise, or null when it resolved (so a refusal can be inspected, not only matched). */
const rejectionOf = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error);

/** The first full state a joined client receives (joinById resolves on JOIN_ROOM, before ROOM_STATE arrives). */
async function firstState(client: Room<LobbyState>): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i += 1) {
    let snapshot: Record<string, unknown> | undefined;
    try {
      snapshot = (client.state as { toJSON?: () => Record<string, unknown> } | undefined)?.toJSON?.();
    } catch {
      snapshot = undefined;
    }
    if (snapshot && typeof snapshot.code === 'string' && snapshot.code !== '') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('no lobby state arrived within 3 s');
}

/** A GET whose path goes out verbatim: fetch/URL would fold `..` and `%2e%2e` away before the request is sent. */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createApp: the API, the client files and Colyseus on one port', () => {
  let running: Running;
  beforeAll(async () => {
    running = await start(true);
  });
  afterAll(() => stop(running));

  it("listen(0, host) resolves with the bound port — the http server's own — and exposes both servers", () => {
    expect(running.port).toBeGreaterThan(0);
    expect((running.app.httpServer.address() as AddressInfo).port).toBe(running.port);
    expect(running.app.httpServer.listening).toBe(true);
    expect(running.app.gameServer).toBeDefined();
  });

  it('/api/* is the HTTP API: GET /api/me without a cookie → 401 JSON', async () => {
    const res = await fetch(`${running.base}/api/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('POST /api/accounts with an allowed Origin → 201 and the session cookie', async () => {
    const res = await fetch(`${running.base}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ riderName: 'María', pin: '1234', riderGender: 'girl', ponyName: 'Dakota', ponyGender: 'yegua' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')?.startsWith(`${SESSION.cookieName}=`)).toBe(true);
  });

  it('GET / serves index.html as text/html', async () => {
    const res = await fetch(`${running.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('HEAD / is served too: 200 without a body', async () => {
    const res = await fetch(`${running.base}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('GET /app.js is served with a JavaScript content type', async () => {
    const res = await fetch(`${running.base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toBe(APP_JS);
  });

  it('a file that does not exist → 404', async () => {
    expect((await fetch(`${running.base}/missing.js`)).status).toBe(404);
  });

  it('a path that escapes staticDir → 404, and the file outside is never served (raw `..`, `%2e%2e`, nested)', async () => {
    for (const path of ['/../outside.txt', '/%2e%2e/outside.txt', '/public/../../outside.txt']) {
      const res = await rawGet(running.port, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain(OUTSIDE_TXT.trim());
    }
  });

  it('static files are GET/HEAD only: POST / is never 200 (404 or 405)', async () => {
    const res = await fetch(`${running.base}/`, { method: 'POST', headers: { origin: ORIGIN } });
    expect([404, 405]).toContain(res.status);
  });

  it('Colyseus matchmaking answers on the same port: joinById of an unknown room fails with the Colyseus error, not the static 404', async () => {
    const sdk = new ColyseusSDK(`ws://127.0.0.1:${running.port}`, { headers: { origin: ORIGIN } });
    // A static fallback would make the SDK say "Not Found"; the matchmaker names the room it could not find.
    await expect(sdk.joinById('no-such-room', {})).rejects.toThrow(/room "no-such-room" not found/);
  });

});

describe("createApp: the live room through the app's own API and WebSocket", () => {
  let running: Running;
  beforeAll(async () => {
    running = await start(false);
  });
  afterAll(() => stop(running));

  /** A browser-like client: the cookie and the Origin travel as headers on matchmaking and on the upgrade. */
  const browser = (cookie: string, origin: string | null = ORIGIN) =>
    new ColyseusSDK(`ws://127.0.0.1:${running.port}`, { headers: { cookie, ...(origin ? { origin } : {}) } });

  it('a host registered and a room created through the API joins its live room by roomId with the cookie alone, and receives the lobby state', async () => {
    const host = await register(running.base, uniqueRiderName('Host'));
    const { code, roomId } = await createRoom(running.base, host.cookie);
    const client = await browser(host.cookie).joinById<LobbyState>(roomId, { code });
    try {
      const state = await firstState(client);
      expect(state.code).toBe(code);
      expect(state.phase).toBe('lobby');
      expect(state.hostId).toBe(host.id);
    } finally {
      await client.leave();
    }
  });

  it('GET /api/rooms/:code/status carries the roomId for the host and for an admitted account, never for a pending one — and the admitted account connects', async () => {
    const host = await register(running.base, uniqueRiderName('Host'));
    const { code, roomId } = await createRoom(running.base, host.cookie);
    const friend = await register(running.base, uniqueRiderName('Friend'));

    const ring = await call(running.base, `/api/rooms/${code}/join`, { method: 'POST', cookie: friend.cookie });
    expect(ring.status).toBe(200);
    expect(ring.json).toEqual({ status: 'pending' });
    expect((await call(running.base, `/api/rooms/${code}/status`, { cookie: friend.cookie })).json).toEqual({ status: 'pending' });
    expect((await call(running.base, `/api/rooms/${code}/status`, { cookie: host.cookie })).json).toEqual({ status: 'host', roomId });

    expect((await call(running.base, `/api/rooms/${code}/admit/${friend.id}`, { method: 'POST', cookie: host.cookie })).status).toBe(204);
    expect((await call(running.base, `/api/rooms/${code}/status`, { cookie: friend.cookie })).json).toEqual({ status: 'admitted', roomId });

    const client = await browser(friend.cookie).joinById<LobbyState>(roomId, { code });
    try {
      const state = await firstState(client);
      expect(state.code).toBe(code);
      expect(state.hostId).toBe(host.id);
    } finally {
      await client.leave();
    }
  });

  it('an account that never rang the doorbell is refused: not-admitted', async () => {
    const host = await register(running.base, uniqueRiderName('Host'));
    const { code, roomId } = await createRoom(running.base, host.cookie);
    const stranger = await register(running.base, uniqueRiderName('Stranger'));
    await expect(browser(stranger.cookie).joinById(roomId, { code })).rejects.toThrow(/not-admitted/);
  });

  // The Origin guard on the upgrade (plan 2.2). In Colyseus 0.18 the room's onAuth runs at the WebSocket
  // connection, not at the HTTP seat reservation, so a reservation obtained with the allowed Origin is the
  // probe: its upgrade under a foreign (or missing) Origin must be answered 403 by the guard, before any room
  // code runs. Without the guard the transport would accept the socket and only then LobbyRoom.onAuth would
  // refuse it as bad-origin — which these tests reject as evidence.
  it("a valid reservation's upgrade with a foreign Origin, or with no Origin, is answered 403 by the http server; with the allowed Origin it is switched to WebSocket", async () => {
    const host = await register(running.base, uniqueRiderName('Host'));
    const { code, roomId } = await createRoom(running.base, host.cookie);

    const foreign = await reserveSeat(running.base, roomId, code, host.cookie);
    expect(await upgradeOutcome(upgradeUrl(running.port, foreign), { cookie: host.cookie, origin: EVIL_ORIGIN })).toBe(403);
    const anonymous = await reserveSeat(running.base, roomId, code, host.cookie);
    expect(await upgradeOutcome(upgradeUrl(running.port, anonymous), { cookie: host.cookie })).toBe(403);
    const allowed = await reserveSeat(running.base, roomId, code, host.cookie);
    expect(await upgradeOutcome(upgradeUrl(running.port, allowed), { cookie: host.cookie, origin: ORIGIN })).toBe('opened');
  });

  it("the SDK with the host's cookie but a foreign Origin, or no Origin, cannot consume a valid reservation — refused at the upgrade, never by the room — while a fresh reservation with the allowed Origin connects to the same room", async () => {
    const host = await register(running.base, uniqueRiderName('Host'));
    const { code, roomId } = await createRoom(running.base, host.cookie);

    for (const [label, origin] of [
      ['foreign Origin', EVIL_ORIGIN],
      ['no Origin', null],
    ] as const) {
      const reservation = await reserveSeat(running.base, roomId, code, host.cookie);
      const refusal = await rejectionOf(browser(host.cookie, origin).consumeSeatReservation<LobbyState>(reservation));
      expect(refusal, `${label}: the upgrade is refused`).toBeInstanceOf(Error);
      // The room never saw this socket: a refusal worded by LobbyRoom.onAuth would mean the upgrade got through.
      expect((refusal as Error).message, `${label}: refused before the room, not by it`).not.toMatch(/bad-origin|no-session|not-admitted/);
    }

    // Nothing got in: the room is still open for its host, and the same roomId still admits the allowed Origin.
    expect((await call(running.base, `/api/rooms/${code}/status`, { cookie: host.cookie })).json).toEqual({ status: 'host', roomId });
    const reservation = await reserveSeat(running.base, roomId, code, host.cookie);
    const client = await browser(host.cookie).consumeSeatReservation<LobbyState>(reservation);
    try {
      const state = await firstState(client);
      expect(state.code).toBe(code);
      expect(state.hostId).toBe(host.id);
    } finally {
      await client.leave();
    }
  });

  it('a session cookie the app never issued is refused: no-session', async () => {
    const host = await register(running.base, uniqueRiderName('Host'));
    const { code, roomId } = await createRoom(running.base, host.cookie);
    await expect(browser(`${SESSION.cookieName}=not-a-token-this-app-issued`).joinById(roomId, { code })).rejects.toThrow(/no-session/);
  });

  // The match-maker surface. Colyseus answers `POST /matchmake/:method/:roomName` for every method listed in
  // matchMaker.controller.exposedMethods — out of the box create, joinOrCreate, join, joinById and reconnect.
  // The first three would let anyone open an extra LobbyRoom for an existing code (onCreate only checks that
  // the code exists; the room is then held open by autoDispose=false) or take a seat in whichever lobby is
  // open. Live rooms are the server's to create (POST /api/rooms); a client may only joinById the room it was
  // handed, or reconnect to it. The room count is read from the match-maker itself: the API's status endpoint
  // only knows the room it created, so it alone could not tell a second room from none.
  const lobbyRoomCount = async (): Promise<number> => (await matchMaker.query({ name: LOBBY_ROOM_NAME })).length;

  it('POST /matchmake/{create,joinOrCreate,join}/lobby with no cookie is refused (status ≥ 400): no seat, no second room, and the host still sees the original roomId', async () => {
    const host = await register(running.base, uniqueRiderName('Host'));
    const { code, roomId } = await createRoom(running.base, host.cookie);
    for (const method of ['create', 'joinOrCreate', 'join'] as const) {
      const before = await lobbyRoomCount();
      const res = await call(running.base, `/matchmake/${method}/${LOBBY_ROOM_NAME}`, { method: 'POST', body: { code } });
      expect(res.status, `${method}: refused`).toBeGreaterThanOrEqual(400);
      expect(res.json, `${method}: no seat reservation handed out`).not.toHaveProperty('sessionId');
      expect(await lobbyRoomCount(), `${method}: no room created`).toBe(before);
    }
    expect((await call(running.base, `/api/rooms/${code}/status`, { cookie: host.cookie })).json).toEqual({ status: 'host', roomId });
  });

  it('the SDK with the host cookie and the allowed Origin cannot create, joinOrCreate or join a lobby — refused by the match-maker as an invalid method, never reaching a room — while joinById of the same room still connects', async () => {
    const host = await register(running.base, uniqueRiderName('Host'));
    const { code, roomId } = await createRoom(running.base, host.cookie);
    const sdk = browser(host.cookie);
    const before = await lobbyRoomCount();

    await expect(sdk.create(LOBBY_ROOM_NAME, { code })).rejects.toThrow(/invalid method "create"/);
    await expect(sdk.joinOrCreate(LOBBY_ROOM_NAME, { code })).rejects.toThrow(/invalid method "joinOrCreate"/);
    await expect(sdk.join(LOBBY_ROOM_NAME, { code })).rejects.toThrow(/invalid method "join"/);
    expect(await lobbyRoomCount()).toBe(before);
    expect((await call(running.base, `/api/rooms/${code}/status`, { cookie: host.cookie })).json).toEqual({ status: 'host', roomId });

    const client = await sdk.joinById<LobbyState>(roomId, { code });
    try {
      const state = await firstState(client);
      expect(state.code).toBe(code);
      expect(state.hostId).toBe(host.id);
    } finally {
      await client.leave();
    }
  });

  it('reconnect stays exposed: POST /matchmake/reconnect/:roomId reaches the match-maker (it asks for the reconnection token) instead of being refused as an invalid method', async () => {
    const host = await register(running.base, uniqueRiderName('Host'));
    const { roomId } = await createRoom(running.base, host.cookie);
    const res = await call(running.base, `/matchmake/reconnect/${roomId}`, { method: 'POST', body: {}, cookie: host.cookie });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(String(res.json?.error)).not.toMatch(/invalid method/);
    expect(String(res.json?.error)).toMatch(/reconnectionToken/);
  });
});

describe('createApp with staticDir null', () => {
  let running: Running;
  beforeAll(async () => {
    running = await start(false);
  });
  afterAll(() => stop(running));

  it('serves nothing but the API: GET / and GET /index.html → 404 while GET /api/me still → 401', async () => {
    expect((await fetch(`${running.base}/`)).status).toBe(404);
    expect((await fetch(`${running.base}/index.html`)).status).toBe(404);
    expect((await fetch(`${running.base}/api/me`)).status).toBe(401);
  });
});

describe('createApp close()', () => {
  it('stops listening: a request afterwards is refused', async () => {
    const running = await start(false);
    const url = `${running.base}/api/me`;
    try {
      expect((await fetch(url)).status).toBe(401);
      await running.app.close();
      expect(running.app.httpServer.listening).toBe(false);
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      await running.services.repos.close();
      rmSync(running.root, { recursive: true, force: true });
    }
  });
});
