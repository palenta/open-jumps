// Matrix rows 1, 2, 13, 20, 21 over HTTP: exact response shapes, cookies renewed on every visit, the Origin
// guard, owner-only edits, admin PIN reset killing old cookies, clubs with admin operations, and the room
// doorbell (join → pending → admit; kick; unblock; club auto-admit; rate limit keyed by account; lobby view).
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION } from '../src/auth/sessions.js';
import { PUBLIC_PROFILE_KEYS, createApi } from '../src/http/api.js';
import { ADMIN_KEY, buildServices, type Services } from './helpers.js';

const ORIGIN = 'https://play.open-jumps.test';
const PROFILE_KEYS = [...PUBLIC_PROFILE_KEYS].sort();

let server: Server;
let base: string;
let services: Services;

beforeEach(async () => {
  services = buildServices();
  const handler = createApi({
    accounts: services.accounts,
    sessions: services.sessions,
    clubs: services.clubs,
    rooms: services.rooms,
    config: { allowedOrigins: [ORIGIN], secureCookies: true, adminKey: ADMIN_KEY },
  });
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await services?.repos.close();
});

interface Call {
  method?: string;
  body?: unknown;
  cookie?: string;
  origin?: string | null;
  headers?: Record<string, string>;
}

async function call(path: string, { method = 'GET', body, cookie, origin = ORIGIN, headers = {} }: Call = {}) {
  const h: Record<string, string> = { ...headers };
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (cookie) h.cookie = cookie;
  if (origin) h.origin = origin;
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

const cookieOf = (setCookie: string | null) => setCookie?.split(';')[0] ?? '';
const keysOf = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();
const LOBBY_PERSON_KEYS = [...PUBLIC_PROFILE_KEYS, 'club'].sort();

const registration = (riderName: string) => ({ riderName, pin: '1234', riderGender: 'girl', ponyName: 'Dakota', ponyGender: 'yegua' });

async function register(riderName: string) {
  const res = await call('/api/accounts', { method: 'POST', body: registration(riderName) });
  expect(res.status).toBe(201);
  const id = String((res.json as { account: { id: string } }).account.id);
  return { id, cookie: cookieOf(res.setCookie) };
}

async function createRoom(hostCookie: string, body: Record<string, unknown> = {}) {
  const created = await call('/api/rooms', { method: 'POST', body, cookie: hostCookie });
  expect(created.status).toBe(201);
  return String((created.json as { code: string }).code);
}

describe('accounts and cookies (rows 2, 13)', () => {
  it('registration sets a Secure, HttpOnly, SameSite=Lax, one-year cookie and returns exactly the public profile', async () => {
    const res = await call('/api/accounts', { method: 'POST', body: registration('María') });
    expect(res.status).toBe(201);
    expect(res.setCookie).toMatch(/^oj_session=[A-Za-z0-9_-]+; /);
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=31536000']) expect(res.setCookie).toContain(attr);
    expect(keysOf(res.json)).toEqual(['account']);
    expect(keysOf((res.json as { account: unknown }).account)).toEqual(PROFILE_KEYS);
    expect((res.json as { account: { riderName: string } }).account.riderName).toBe('María');
  });

  it('login returns exactly { account: PublicProfile } and a cookie; wrong PIN 401; locked 423', async () => {
    await register('María');
    const ok = await call('/api/login', { method: 'POST', body: { riderName: 'maría', pin: '1234' } });
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toContain('oj_session=');
    expect(keysOf(ok.json)).toEqual(['account']);
    expect(keysOf((ok.json as { account: unknown }).account)).toEqual(PROFILE_KEYS);
    expect((await call('/api/login', { method: 'POST', body: { riderName: 'María', pin: '0000' } })).status).toBe(401);
    for (let i = 0; i < 4; i += 1) await call('/api/login', { method: 'POST', body: { riderName: 'María', pin: '0000' } });
    expect((await call('/api/login', { method: 'POST', body: { riderName: 'María', pin: '1234' } })).status).toBe(423);
  });

  it('GET /api/me returns exactly the public profile with the cookie and 401 without it', async () => {
    const { cookie } = await register('María');
    const me = await call('/api/me', { cookie });
    expect(me.status).toBe(200);
    expect(keysOf(me.json)).toEqual(PROFILE_KEYS);
    expect((await call('/api/me')).status).toBe(401);
    expect((await call('/api/me', { cookie: 'oj_session=garbage' })).status).toBe(401);
  });

  it('every authenticated visit renews the cookie and slides the server expiry (plan 1.5: a year, renewed)', async () => {
    const { cookie } = await register('María');
    const token = cookie.slice('oj_session='.length);
    const issuedAt = services.clock.now();
    services.clock.advance(100 * 24 * 60 * 60 * 1000); // 100 days later
    const visit = await call('/api/me', { cookie });
    expect(visit.status).toBe(200);
    expect(visit.setCookie).toContain(`oj_session=${token};`);
    expect(visit.setCookie).toContain('Max-Age=31536000');
    services.clock.advance(SESSION.ttlMs - 100 * 24 * 60 * 60 * 1000 + 1000); // past the original expiry
    expect(services.clock.now()).toBeGreaterThan(issuedAt + SESSION.ttlMs);
    expect((await call('/api/me', { cookie })).status).toBe(200);
  });

  it('an expired or revoked cookie is not resurrected by a visit', async () => {
    const expired = await register('María');
    services.clock.advance(SESSION.ttlMs + 1);
    expect((await call('/api/me', { cookie: expired.cookie })).status).toBe(401);
    expect((await call('/api/me', { cookie: expired.cookie })).status).toBe(401);
    services.clock.advance(-(SESSION.ttlMs + 1));
    const revoked = await register('Sofía');
    await call(`/api/admin/accounts/${revoked.id}/reset-pin`, { method: 'POST', body: { pin: '9999' }, headers: { 'x-admin-key': ADMIN_KEY } });
    expect((await call('/api/me', { cookie: revoked.cookie })).status).toBe(401);
  });

  it('logout clears the cookie and the old token stops working', async () => {
    const { cookie } = await register('María');
    const out = await call('/api/logout', { method: 'POST', cookie });
    expect(out.status).toBe(204);
    expect(out.setCookie).toContain('Max-Age=0');
    expect((await call('/api/me', { cookie })).status).toBe(401);
  });

  it('rejects malformed JSON (400) and unknown routes (404)', async () => {
    const res = await fetch(`${base}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{not json' });
    expect(res.status).toBe(400);
    expect((await call('/api/nope')).status).toBe(404);
  });
});

describe('Origin guard (row 20)', () => {
  it('state-changing requests without an allowed Origin get 403; GET passes without Origin', async () => {
    expect((await call('/api/accounts', { method: 'POST', body: registration('María'), origin: null })).status).toBe(403);
    expect((await call('/api/accounts', { method: 'POST', body: registration('María'), origin: 'https://evil.example' })).status).toBe(403);
    const { cookie } = await register('María');
    expect((await call('/api/me', { cookie, origin: null })).status).toBe(200);
    expect((await call('/api/logout', { method: 'POST', cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/me', { cookie })).status).toBe(200);
  });
});

describe('profiles and admin (rows 13, 21)', () => {
  it('PATCH another account → 403; own account → 200 with exactly the public profile; no cookie → 401', async () => {
    const me = await register('María');
    const other = await register('Sofía');
    expect((await call(`/api/accounts/${me.id}`, { method: 'PATCH', body: { ponyName: 'Hacked' }, cookie: other.cookie })).status).toBe(403);
    expect((await call('/api/me', { cookie: me.cookie })).json).toMatchObject({ ponyName: 'Dakota' });
    const mine = await call(`/api/accounts/${me.id}`, { method: 'PATCH', body: { ponyName: 'Buran' }, cookie: me.cookie });
    expect(mine.status).toBe(200);
    expect(keysOf(mine.json)).toEqual(PROFILE_KEYS);
    expect(mine.json).toMatchObject({ ponyName: 'Buran' });
    expect((await call(`/api/accounts/${me.id}`, { method: 'PATCH', body: { ponyName: 'Buran' } })).status).toBe(401);
  });

  it('PIN reset needs the admin key and revokes the old cookie', async () => {
    const me = await register('María');
    expect((await call(`/api/admin/accounts/${me.id}/reset-pin`, { method: 'POST', body: { pin: '9999' } })).status).toBe(403);
    expect((await call(`/api/admin/accounts/${me.id}/reset-pin`, { method: 'POST', body: { pin: '9999' }, headers: { 'x-admin-key': 'wrong' } })).status).toBe(403);
    expect((await call(`/api/admin/accounts/${me.id}/reset-pin`, { method: 'POST', body: { pin: '9999' }, headers: { 'x-admin-key': ADMIN_KEY } })).status).toBe(204);
    expect((await call('/api/me', { cookie: me.cookie })).status).toBe(401);
    expect((await call('/api/login', { method: 'POST', body: { riderName: 'María', pin: '9999' } })).status).toBe(200);
  });
});

describe('clubs over HTTP (rows 1, 21)', () => {
  it('create → request by code → pending list (admin only, public fields) → confirm; reject/remove/transfer are admin-only', async () => {
    const admin = await register('Papá');
    const kid = await register('María');
    const friend = await register('Sofía');
    const created = await call('/api/clubs', { method: 'POST', body: { name: 'Open Sports Barcelona' }, cookie: admin.cookie });
    expect(created.status).toBe(201);
    expect(keysOf(created.json)).toEqual(['code', 'id', 'name']);
    const club = created.json as { id: string; code: string };

    expect((await call(`/api/clubs/${club.code}/join`, { method: 'POST', cookie: kid.cookie })).status).toBe(202);
    expect((await call(`/api/clubs/${club.code}/join`, { method: 'POST', cookie: friend.cookie })).status).toBe(202);
    expect((await call(`/api/clubs/${club.id}/pending`, { cookie: kid.cookie })).status).toBe(403);
    const pending = await call(`/api/clubs/${club.id}/pending`, { cookie: admin.cookie });
    expect(pending.status).toBe(200);
    const list = (pending.json as { pending: Record<string, unknown>[] }).pending;
    expect(list.map((m) => m.accountId).sort()).toEqual([friend.id, kid.id].sort());
    for (const entry of list) expect(keysOf(entry)).toEqual(['accountId', 'ponyName', 'requestedAt', 'riderName']);

    expect((await call(`/api/clubs/${club.id}/confirm/${kid.id}`, { method: 'POST', cookie: kid.cookie })).status).toBe(403);
    expect((await call(`/api/clubs/${club.id}/confirm/${kid.id}`, { method: 'POST', cookie: admin.cookie })).status).toBe(200);
    expect((await call('/api/me', { cookie: kid.cookie })).json).toMatchObject({ clubId: club.id });

    expect((await call(`/api/clubs/${club.id}/reject/${friend.id}`, { method: 'POST', cookie: kid.cookie })).status).toBe(403);
    expect((await call(`/api/clubs/${club.id}/reject/${friend.id}`, { method: 'POST', cookie: admin.cookie })).status).toBe(204);
    expect(((await call(`/api/clubs/${club.id}/pending`, { cookie: admin.cookie })).json as { pending: unknown[] }).pending).toEqual([]);

    expect((await call(`/api/clubs/${club.id}/transfer/${kid.id}`, { method: 'POST', cookie: kid.cookie })).status).toBe(403);
    const transferred = await call(`/api/clubs/${club.id}/transfer/${kid.id}`, { method: 'POST', cookie: admin.cookie });
    expect(transferred.status).toBe(200);
    expect(transferred.json).toEqual({ adminAccountId: kid.id });

    expect((await call(`/api/clubs/${club.id}/remove/${admin.id}`, { method: 'POST', cookie: admin.cookie })).status).toBe(403);
    expect((await call(`/api/clubs/${club.id}/remove/${admin.id}`, { method: 'POST', cookie: kid.cookie })).status).toBe(204);
    expect((await call('/api/me', { cookie: admin.cookie })).json).toMatchObject({ clubId: null });
  });
});

describe('one club per rider and reading your own club (rows 1, 21)', () => {
  it('GET /api/clubs/mine: a freshly signed-in admin gets role, code and members; a member gets no code; no club → 404', async () => {
    const admin = await register('Papá');
    const kid = await register('María');
    const club = (await call('/api/clubs', { method: 'POST', body: { name: 'Open Sports Barcelona' }, cookie: admin.cookie })).json as { id: string; code: string };
    await call(`/api/clubs/${club.code}/join`, { method: 'POST', cookie: kid.cookie });
    await call(`/api/clubs/${club.id}/confirm/${kid.id}`, { method: 'POST', cookie: admin.cookie });
    await call(`/api/clubs/${club.id}/transfer/${kid.id}`, { method: 'POST', cookie: admin.cookie });
    // The new admin signs in on another device: nothing remembered from earlier responses.
    const fresh = await call('/api/login', { method: 'POST', body: { riderName: 'María', pin: '1234' } });
    const freshCookie = cookieOf(fresh.setCookie);
    const mine = await call('/api/clubs/mine', { cookie: freshCookie });
    expect(mine.status).toBe(200);
    expect(keysOf(mine.json)).toEqual(['code', 'id', 'members', 'name', 'pendingCount', 'role']);
    expect(mine.json).toMatchObject({ id: club.id, name: 'Open Sports Barcelona', role: 'admin', code: club.code, pendingCount: 0 });
    const members = (mine.json as { members: Record<string, unknown>[] }).members;
    expect(members.map((m) => m.accountId).sort()).toEqual([admin.id, kid.id].sort());
    for (const member of members) expect(keysOf(member)).toEqual(['accountId', 'ponyName', 'riderName']);
    const asMember = await call('/api/clubs/mine', { cookie: admin.cookie });
    expect(asMember.status).toBe(200);
    expect(asMember.json).toMatchObject({ role: 'member', code: null });
    // The ids from this view are enough to manage the club: the new admin removes the former one.
    expect((await call(`/api/clubs/${club.id}/remove/${admin.id}`, { method: 'POST', cookie: freshCookie })).status).toBe(204);
    expect((await call('/api/clubs/mine', { cookie: admin.cookie })).status).toBe(404);
    expect((await call('/api/clubs/mine', { cookie: (await register('Lucas')).cookie })).status).toBe(404);
  });

  it('a rider already in a club cannot request or create another one (409)', async () => {
    const admin = await register('Papá');
    const kid = await register('María');
    const other = await register('Lucas');
    const club = (await call('/api/clubs', { method: 'POST', body: { name: 'Open Sports Barcelona' }, cookie: admin.cookie })).json as { id: string; code: string };
    const otherClub = (await call('/api/clubs', { method: 'POST', body: { name: 'Otro Club' }, cookie: other.cookie })).json as { id: string; code: string };
    await call(`/api/clubs/${club.code}/join`, { method: 'POST', cookie: kid.cookie });
    await call(`/api/clubs/${club.id}/confirm/${kid.id}`, { method: 'POST', cookie: admin.cookie });
    expect((await call(`/api/clubs/${otherClub.code}/join`, { method: 'POST', cookie: kid.cookie })).status).toBe(409);
    expect((await call('/api/clubs', { method: 'POST', body: { name: 'Tercer Club' }, cookie: kid.cookie })).status).toBe(409);
    expect((await call('/api/clubs', { method: 'POST', body: { name: 'Tercer Club' }, cookie: admin.cookie })).status).toBe(409);
    expect((await call('/api/me', { cookie: kid.cookie })).json).toMatchObject({ clubId: club.id });
  });
});

describe('the room doorbell over HTTP (row 1)', () => {
  it('join → pending → the host sees the request in the lobby view → admits by that id → admitted', async () => {
    const host = await register('María');
    const friend = await register('Sofía');
    const code = await createRoom(host.cookie);
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    const ring = await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: friend.cookie });
    expect(ring.status).toBe(200);
    expect(ring.json).toEqual({ status: 'pending' });
    expect((await call(`/api/rooms/${code}/status`, { cookie: friend.cookie })).json).toEqual({ status: 'pending' });
    expect((await call(`/api/rooms/${code}/status`, { cookie: host.cookie })).json).toEqual({ status: 'host' });

    expect((await call(`/api/rooms/${code}/lobby`, { cookie: friend.cookie })).status).toBe(403);
    const lobby = await call(`/api/rooms/${code}/lobby`, { cookie: host.cookie });
    expect(lobby.status).toBe(200);
    expect(keysOf(lobby.json)).toEqual(['autoAdmitClub', 'clubId', 'code', 'entryOpen', 'hostId', 'kicked', 'participants', 'pending']);
    const pending = (lobby.json as { pending: Record<string, unknown>[] }).pending;
    expect(pending).toHaveLength(1);
    expect(keysOf(pending[0])).toEqual(LOBBY_PERSON_KEYS);
    expect(pending[0]!.club).toBeNull();
    const requesterId = String(pending[0]!.id);
    expect(requesterId).toBe(friend.id);

    expect((await call(`/api/rooms/${code}/admit/${requesterId}`, { method: 'POST', cookie: friend.cookie })).status).toBe(403);
    expect((await call(`/api/rooms/${code}/admit/${requesterId}`, { method: 'POST', cookie: host.cookie })).status).toBe(204);
    expect((await call(`/api/rooms/${code}/status`, { cookie: friend.cookie })).json).toEqual({ status: 'admitted' });
    expect(((await call(`/api/rooms/${code}/lobby`, { cookie: host.cookie })).json as { participants: unknown[] }).participants).toHaveLength(2);
  });

  it('kick → listed as kicked for the host, rejoin rejected; unblock by that id → pending again, never automatic', async () => {
    const host = await register('María');
    const friend = await register('Sofía');
    const code = await createRoom(host.cookie);
    await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: friend.cookie });
    await call(`/api/rooms/${code}/admit/${friend.id}`, { method: 'POST', cookie: host.cookie });
    expect((await call(`/api/rooms/${code}/kick/${friend.id}`, { method: 'POST', cookie: host.cookie })).status).toBe(204);
    expect((await call(`/api/rooms/${code}/status`, { cookie: friend.cookie })).json).toEqual({ status: 'kicked' });
    const kicked = ((await call(`/api/rooms/${code}/lobby`, { cookie: host.cookie })).json as { kicked: { id: string }[] }).kicked;
    expect(kicked.map((k) => k.id)).toEqual([friend.id]);
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: friend.cookie })).json).toEqual({ status: 'rejected', reason: 'kicked' });
    expect((await call(`/api/rooms/${code}/unblock/${friend.id}`, { method: 'POST', cookie: friend.cookie })).status).toBe(403);
    expect((await call(`/api/rooms/${code}/unblock/${kicked[0]!.id}`, { method: 'POST', cookie: host.cookie })).status).toBe(204);
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: friend.cookie })).json).toEqual({ status: 'pending' });
  });

  it('closed entry rejects with reason closed; reopening lets the doorbell ring', async () => {
    const host = await register('María');
    const friend = await register('Sofía');
    const code = await createRoom(host.cookie);
    // A stranger to the room (never rang its doorbell) gets 404 on host routes, like any other unknown code.
    expect((await call(`/api/rooms/${code}/entry`, { method: 'POST', body: { open: false }, cookie: friend.cookie })).status).toBe(404);
    expect((await call(`/api/rooms/${code}/entry`, { method: 'POST', body: { open: false }, cookie: host.cookie })).status).toBe(204);
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: friend.cookie })).json).toEqual({ status: 'rejected', reason: 'closed' });
    expect((await call(`/api/rooms/${code}/entry`, { method: 'POST', body: { open: true }, cookie: host.cookie })).status).toBe(204);
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: friend.cookie })).json).toEqual({ status: 'pending' });
  });

  it('code guessing is limited per authenticated account: five attempts, then 429; a body field cannot reset it; another account is independent', async () => {
    const host = await register('María');
    const guesser = await register('Sofía');
    const other = await register('Lucas');
    await createRoom(host.cookie);
    for (let i = 0; i < 5; i += 1) {
      expect((await call('/api/rooms/ZZZZZZ/join', { method: 'POST', body: { deviceKey: `k${i}` }, cookie: guesser.cookie })).status).toBe(404);
    }
    expect((await call('/api/rooms/ZZZZZZ/join', { method: 'POST', body: { deviceKey: 'fresh' }, cookie: guesser.cookie })).status).toBe(429);
    expect((await call('/api/rooms/ZZZZZZ/join', { method: 'POST', cookie: guesser.cookie })).status).toBe(429);
    expect((await call('/api/rooms/ZZZZZZ/join', { method: 'POST', cookie: other.cookie })).status).toBe(404);
    services.clock.advance(60_001);
    expect((await call('/api/rooms/ZZZZZZ/join', { method: 'POST', cookie: guesser.cookie })).status).toBe(404);
  });

  it('status, lobby and host routes on a room you are not part of look like an unknown code and spend the same budget', async () => {
    const host = await register('María');
    const requester = await register('Sofía');
    const stranger = await register('Lucas');
    const code = await createRoom(host.cookie);
    await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: requester.cookie });
    expect((await call(`/api/rooms/${code}/status`, { cookie: stranger.cookie })).status).toBe(404); // probe 1
    expect((await call(`/api/rooms/${code}/lobby`, { cookie: stranger.cookie })).status).toBe(404); // probe 2
    expect((await call(`/api/rooms/${code}/admit/${requester.id}`, { method: 'POST', cookie: stranger.cookie })).status).toBe(404); // probe 3
    expect((await call(`/api/rooms/${code}/entry`, { method: 'POST', body: { open: false }, cookie: stranger.cookie })).status).toBe(404); // probe 4
    expect((await call('/api/rooms/ZZZZZZ/status', { cookie: stranger.cookie })).status).toBe(404); // probe 5
    expect((await call(`/api/rooms/${code}/status`, { cookie: stranger.cookie })).status).toBe(429);
    expect((await call(`/api/rooms/${code}/lobby`, { cookie: stranger.cookie })).status).toBe(429);
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: stranger.cookie })).status).toBe(429);
    for (let i = 0; i < 10; i += 1) expect((await call(`/api/rooms/${code}/status`, { cookie: requester.cookie })).json).toEqual({ status: 'pending' });
    expect((await call(`/api/rooms/${code}/lobby`, { cookie: requester.cookie })).status).toBe(403);
    expect((await call(`/api/rooms/${code}/status`, { cookie: host.cookie })).json).toEqual({ status: 'host' });
    expect((await call(`/api/rooms/${code}/lobby`, { cookie: host.cookie })).json).toMatchObject({ entryOpen: true });
  });

  it('a known code does not refill the guessing budget (four misses, own room, four misses)', async () => {
    const host = await register('María');
    const code = await createRoom(host.cookie);
    for (let i = 0; i < 4; i += 1) expect((await call('/api/rooms/ZZZZZZ/join', { method: 'POST', cookie: host.cookie })).status).toBe(404);
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: host.cookie })).json).toEqual({ status: 'rejected', reason: 'already-in' });
    expect((await call('/api/rooms/ZZZZZZ/join', { method: 'POST', cookie: host.cookie })).status).toBe(404);
    for (let i = 0; i < 3; i += 1) expect((await call('/api/rooms/ZZZZZZ/join', { method: 'POST', cookie: host.cookie })).status).toBe(429);
    expect((await call(`/api/rooms/${code}/lobby`, { cookie: host.cookie })).status).toBe(200);
  });

  it('club auto-admit end to end: pending until the admin confirms, then automatic; a kicked member returns only via the host', async () => {
    const admin = await register('Papá');
    const kid = await register('María');
    const club = (await call('/api/clubs', { method: 'POST', body: { name: 'Open Sports Barcelona' }, cookie: admin.cookie })).json as { id: string; code: string };
    await call(`/api/clubs/${club.code}/join`, { method: 'POST', cookie: kid.cookie });
    const code = await createRoom(admin.cookie, { autoAdmitClub: true });
    expect(((await call(`/api/rooms/${code}/lobby`, { cookie: admin.cookie })).json as { clubId: string; autoAdmitClub: boolean })).toMatchObject({ clubId: club.id, autoAdmitClub: true });

    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: kid.cookie })).json).toEqual({ status: 'pending' });
    await call(`/api/rooms/${code}/deny/${kid.id}`, { method: 'POST', cookie: admin.cookie });
    await call(`/api/clubs/${club.id}/confirm/${kid.id}`, { method: 'POST', cookie: admin.cookie });
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: kid.cookie })).json).toEqual({ status: 'admitted' });

    await call(`/api/rooms/${code}/kick/${kid.id}`, { method: 'POST', cookie: admin.cookie });
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: kid.cookie })).json).toEqual({ status: 'rejected', reason: 'kicked' });
    await call(`/api/rooms/${code}/unblock/${kid.id}`, { method: 'POST', cookie: admin.cookie });
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: kid.cookie })).json).toEqual({ status: 'pending' });
    expect((await call(`/api/rooms/${code}/admit/${kid.id}`, { method: 'POST', cookie: admin.cookie })).status).toBe(204);
    expect((await call(`/api/rooms/${code}/status`, { cookie: kid.cookie })).json).toEqual({ status: 'admitted' });

    expect((await call(`/api/rooms/${code}/auto-admit`, { method: 'POST', body: { on: false }, cookie: kid.cookie })).status).toBe(403);
    expect((await call(`/api/rooms/${code}/auto-admit`, { method: 'POST', body: { on: false }, cookie: admin.cookie })).status).toBe(204);
  });

  it('the host sees the club of a confirmed member of another club by name, without that club\'s code', async () => {
    const host = await register('María');
    const otherAdmin = await register('Lucas');
    const otherClub = (await call('/api/clubs', { method: 'POST', body: { name: 'Otro Club' }, cookie: otherAdmin.cookie })).json as { id: string; code: string };
    const code = await createRoom(host.cookie);
    await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: otherAdmin.cookie });
    const lobby = (await call(`/api/rooms/${code}/lobby`, { cookie: host.cookie })).json as { pending: Record<string, unknown>[] };
    expect(lobby.pending[0]!.club).toEqual({ id: otherClub.id, name: 'Otro Club' });
    expect(JSON.stringify(lobby)).not.toContain(otherClub.code);
  });

  it('a room for a host without a club has no club and cannot auto-admit anyone', async () => {
    const host = await register('María');
    const friend = await register('Sofía');
    const code = await createRoom(host.cookie, { autoAdmitClub: true });
    expect(((await call(`/api/rooms/${code}/lobby`, { cookie: host.cookie })).json as { clubId: unknown }).clubId).toBeNull();
    expect((await call(`/api/rooms/${code}/join`, { method: 'POST', cookie: friend.cookie })).json).toEqual({ status: 'pending' });
  });
});
