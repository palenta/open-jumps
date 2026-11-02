// HTTP API (plan 2.2, 2.5а): accounts, login, profile, clubs, room creation and the doorbell (join requests,
// status polling, the host's lobby view and decisions). Rooms' live state lives in Colyseus
// (colyseus/LobbyRoom.ts); only admitted accounts may connect there.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PonyCategory } from '@open-jumps/shared';
import type { AccountService, ProfilePatch, PublicProfile } from '../auth/accounts.js';
import { clearSessionCookie, parseCookies, sessionCookie } from '../auth/cookies.js';
import { SESSION, type SessionService } from '../auth/sessions.js';
import type { ClubService } from '../clubs/clubs.js';
import type { AccountRecord, PonyGender, RiderGender } from '../storage/repositories.js';
import { originAllowsRequest } from './origin.js';
import type { HostAction, RoomDirectory } from './rooms.js';

export interface ApiConfig {
  /** Allowed Origin values, e.g. ['https://play.example.com']. */
  allowedOrigins: readonly string[];
  /** Secure cookies (false only for plain-http local development). */
  secureCookies: boolean;
  adminKey: string;
}

export interface ApiDeps {
  accounts: AccountService;
  sessions: SessionService;
  clubs: ClubService;
  rooms: RoomDirectory;
  config: ApiConfig;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Keys of every JSON body that describes an account; nothing else ever leaves the server about an account. */
export const PUBLIC_PROFILE_KEYS = ['id', 'riderName', 'riderGender', 'ponyName', 'ponyGender', 'ponyCategory', 'clubId'] as const;

/** Request bodies larger than this are refused (the API carries names and ids, never media). */
const MAX_BODY_BYTES = 64 * 1024;

type Json = Record<string, unknown>;

interface Reply {
  status: number;
  body?: unknown;
}

const reply = (status: number, body?: unknown): Reply => (body === undefined ? { status } : { status, body });
const failure = (status: number, error: string): Reply => reply(status, { error });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonObject(text: string): Json | null {
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const str = (body: Json, key: string): string | undefined => (typeof body[key] === 'string' ? (body[key] as string) : undefined);
const bool = (body: Json, key: string): boolean | undefined => (typeof body[key] === 'boolean' ? (body[key] as boolean) : undefined);

function toPublic(account: AccountRecord | PublicProfile): PublicProfile {
  return {
    id: account.id,
    riderName: account.riderName,
    riderGender: account.riderGender,
    ponyName: account.ponyName,
    ponyGender: account.ponyGender,
    ponyCategory: account.ponyCategory,
    clubId: account.clubId,
  };
}

const NAME_ERROR_STATUS: Record<string, number> = {
  'rider-name-taken': 409,
  'name-taken': 409,
  'already-member': 409,
  'already-pending': 409,
  'in-another-club': 409,
  'unknown-code': 404,
  'unknown-club': 404,
  'no-club': 404,
  'not-found': 404,
  forbidden: 403,
  'cannot-remove-admin': 403,
  'rate-limited': 429,
};

const statusFor = (error: string, fallback = 400): number => NAME_ERROR_STATUS[error] ?? fallback;

/** Host decisions on the door that take an account id in the path. */
const DOOR_ACTIONS: ReadonlySet<string> = new Set(['admit', 'deny', 'kick', 'unblock']);

/**
 * Routes (JSON in, JSON out; errors as { error: <code> }). Every authenticated visit slides the session
 * expiry and re-sets the cookie (plan 1.5: a year, renewed on each visit). Bodies describing an account are
 * exactly the public profile (PUBLIC_PROFILE_KEYS); the session token travels only in the cookie.
 *  POST  /api/accounts                        register → 201 { account: PublicProfile } + Set-Cookie
 *  POST  /api/login                           → 200 { account: PublicProfile } + Set-Cookie | 401 | 423 locked
 *  POST  /api/logout                          → 204, cookie cleared
 *  GET   /api/me                              → 200 PublicProfile | 401
 *  PATCH /api/accounts/:id                    owner only → 200 PublicProfile | 403
 *  POST  /api/admin/accounts/:id/reset-pin    header X-Admin-Key → 204 | 403
 *  POST  /api/clubs                           → 201 { id, name, code } | 409 in-another-club (one club per rider)
 *  GET   /api/clubs/mine                      confirmed member → 200 { id, name, role, code (admin only, else null),
 *                                               members: [{ accountId, riderName, ponyName }], pendingCount } | 404 no-club
 *  POST  /api/clubs/:code/join                → 202 { status: 'pending' } | 409 already-member, already-pending, in-another-club
 *  GET   /api/clubs/:id/pending               admin → 200 { pending: [{ accountId, riderName, ponyName, requestedAt }] } | 403
 *  POST  /api/clubs/:id/confirm/:accountId    admin → 200 | 403
 *  POST  /api/clubs/:id/reject/:accountId     admin → 204 | 403
 *  POST  /api/clubs/:id/remove/:accountId     admin → 204 | 403
 *  POST  /api/clubs/:id/transfer/:accountId   admin → 200 { adminAccountId } | 403
 *  POST  /api/rooms                           { autoAdmitClub? } → 201 { code } (club = the host's club)
 *  POST  /api/rooms/:code/join                → 200 { status, reason? } | 404 | 429 rate-limited (keyed by account)
 *  GET   /api/rooms/:code/status              → 200 { status } (own relation to the room: host/admitted/pending/kicked)
 *  GET   /api/rooms/:code/lobby               host → 200 LobbyView (people = PublicProfile + club { id, name } | null) | 403
 *  Every /api/rooms/:code/* route answers 404 unknown-code for a room the account has no relation to (never seen
 *  there, or denied) and spends one of the account's five guesses per minute; the sixth guess → 429 on all of them.
 *  POST  /api/rooms/:code/admit/:accountId    host → 204 | 403
 *  POST  /api/rooms/:code/deny/:accountId     host → 204 | 403
 *  POST  /api/rooms/:code/kick/:accountId     host → 204 | 403
 *  POST  /api/rooms/:code/unblock/:accountId  host → 204 | 403
 *  POST  /api/rooms/:code/entry               host { open } → 204 | 403
 *  POST  /api/rooms/:code/auto-admit          host { on } → 204 | 403
 * State-changing requests without an allowed Origin → 403 bad-origin; unknown routes → 404; bad JSON → 400.
 */
export function createApi(deps: ApiDeps): RequestHandler {
  const { accounts, sessions, clubs, rooms, config } = deps;
  const cookieOptions = { secure: config.secureCookies, maxAgeSec: Math.floor(SESSION.ttlMs / 1000) };
  const signedIn = (res: ServerResponse, token: string) => res.setHeader('Set-Cookie', sessionCookie(token, cookieOptions));

  async function route(req: IncomingMessage, res: ServerResponse): Promise<Reply> {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!originAllowsRequest(method, header(req.headers.origin), config.allowedOrigins, false)) return failure(403, 'bad-origin');

    let body: Json = {};
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      let text: string;
      try {
        text = await readBody(req);
      } catch {
        return failure(413, 'too-large');
      }
      const parsed = parseJsonObject(text);
      if (!parsed) return failure(400, 'bad-json');
      body = parsed;
    }

    // Who is visiting: the cookie alone; a valid session is renewed on every visit.
    const token = parseCookies(header(req.headers.cookie))[SESSION.cookieName];
    const viewer = token ? await sessions.resolve(token) : null;
    if (viewer && token) {
      await sessions.refresh(token);
      signedIn(res, token);
    }

    const parts = path.split('/').filter((part) => part !== '');
    if (parts[0] !== 'api') return failure(404, 'not-found');
    const [, p1, p2, p3, p4] = parts;

    // ---- accounts and sessions ----
    if (p1 === 'accounts' && p2 === undefined && method === 'POST') {
      const riderName = str(body, 'riderName');
      const pin = str(body, 'pin');
      const ponyName = str(body, 'ponyName');
      const riderGender = str(body, 'riderGender');
      const ponyGender = str(body, 'ponyGender');
      const ponyCategory = str(body, 'ponyCategory');
      if (riderName === undefined || pin === undefined || ponyName === undefined || riderGender === undefined || ponyGender === undefined) {
        return failure(400, 'bad-request');
      }
      const result = await accounts.register({
        riderName,
        pin,
        ponyName,
        riderGender: riderGender as RiderGender,
        ponyGender: ponyGender as PonyGender,
        ...(ponyCategory !== undefined ? { ponyCategory: ponyCategory as PonyCategory } : {}),
      });
      if (!result.ok) return failure(statusFor(result.error), result.error);
      signedIn(res, result.value.token);
      return reply(201, { account: toPublic(result.value.account) });
    }

    if (p1 === 'login' && p2 === undefined && method === 'POST') {
      const riderName = str(body, 'riderName');
      const pin = str(body, 'pin');
      if (riderName === undefined || pin === undefined) return failure(400, 'bad-request');
      const result = await accounts.login(riderName, pin);
      if (!result.ok) return failure(result.error === 'locked' ? 423 : 401, result.error);
      signedIn(res, result.value.token);
      return reply(200, { account: toPublic(result.value.account) });
    }

    if (p1 === 'logout' && p2 === undefined && method === 'POST') {
      // No per-token revocation in this cycle: signing out ends every session of the account (all devices).
      if (viewer) await sessions.revokeAll(viewer.id);
      res.setHeader('Set-Cookie', clearSessionCookie({ secure: config.secureCookies }));
      return reply(204);
    }

    if (p1 === 'me' && p2 === undefined && method === 'GET') {
      return viewer ? reply(200, toPublic(viewer)) : failure(401, 'unauthorized');
    }

    if (p1 === 'accounts' && p2 !== undefined && p3 === undefined && method === 'PATCH') {
      if (!viewer) return failure(401, 'unauthorized');
      const patch: ProfilePatch = {};
      for (const key of ['riderName', 'ponyName', 'ponyGender', 'ponyCategory'] as const) {
        if (body[key] === undefined) continue;
        const value = str(body, key);
        if (value === undefined) return failure(400, 'bad-request');
        (patch as Record<string, string>)[key] = value;
      }
      const result = await accounts.updateProfile(viewer.id, p2, patch);
      if (!result.ok) return failure(statusFor(result.error), result.error);
      return reply(200, toPublic(result.value));
    }

    if (p1 === 'admin' && p2 === 'accounts' && p3 !== undefined && p4 === 'reset-pin' && method === 'POST') {
      const pin = str(body, 'pin');
      if (pin === undefined) return failure(400, 'bad-request');
      const result = await accounts.resetPin(header(req.headers['x-admin-key']) ?? '', p3, pin);
      if (!result.ok) return failure(statusFor(result.error), result.error);
      return reply(204);
    }

    // ---- clubs ----
    if (p1 === 'clubs') {
      if (!viewer) return failure(401, 'unauthorized');
      if (p2 === undefined && method === 'POST') {
        const name = str(body, 'name');
        if (name === undefined) return failure(400, 'bad-request');
        const result = await clubs.createClub(viewer.id, name);
        if (!result.ok) return failure(statusFor(result.error), result.error);
        return reply(201, { id: result.value.id, name: result.value.name, code: result.value.code });
      }
      if (p2 === 'mine' && p3 === undefined && method === 'GET') {
        const result = await clubs.overview(viewer.id);
        if (!result.ok) return failure(statusFor(result.error), result.error);
        const members = [];
        for (const accountId of result.value.memberIds) {
          const profile = await accounts.getPublicProfile(accountId);
          if (profile) members.push({ accountId: profile.id, riderName: profile.riderName, ponyName: profile.ponyName });
        }
        const { id, name, role, code, pendingCount } = result.value;
        return reply(200, { id, name, role, code, members, pendingCount });
      }
      if (p2 !== undefined && p3 === 'join' && p4 === undefined && method === 'POST') {
        const result = await clubs.requestJoin(viewer.id, p2);
        if (!result.ok) return failure(statusFor(result.error), result.error);
        return reply(202, { status: result.value.status });
      }
      if (p2 !== undefined && p3 === 'pending' && p4 === undefined && method === 'GET') {
        const result = await clubs.listPending(viewer.id, p2);
        if (!result.ok) return failure(statusFor(result.error), result.error);
        const pending = [];
        for (const membership of result.value) {
          const profile = await accounts.getPublicProfile(membership.accountId);
          if (!profile) continue;
          pending.push({ accountId: profile.id, riderName: profile.riderName, ponyName: profile.ponyName, requestedAt: membership.requestedAt });
        }
        return reply(200, { pending });
      }
      if (p2 !== undefined && p3 !== undefined && p4 !== undefined && method === 'POST') {
        switch (p3) {
          case 'confirm': {
            const result = await clubs.confirm(viewer.id, p2, p4);
            return result.ok ? reply(200, { accountId: result.value.accountId, status: result.value.status }) : failure(statusFor(result.error), result.error);
          }
          case 'reject': {
            const result = await clubs.reject(viewer.id, p2, p4);
            return result.ok ? reply(204) : failure(statusFor(result.error), result.error);
          }
          case 'remove': {
            const result = await clubs.removeMember(viewer.id, p2, p4);
            return result.ok ? reply(204) : failure(statusFor(result.error), result.error);
          }
          case 'transfer': {
            const result = await clubs.transferAdmin(viewer.id, p2, p4);
            return result.ok ? reply(200, { adminAccountId: result.value.adminAccountId }) : failure(statusFor(result.error), result.error);
          }
          default:
            return failure(404, 'not-found');
        }
      }
      return failure(404, 'not-found');
    }

    // ---- rooms: the doorbell ----
    if (p1 === 'rooms') {
      if (!viewer) return failure(401, 'unauthorized');
      if (p2 === undefined && method === 'POST') {
        const autoAdmitClub = bool(body, 'autoAdmitClub');
        const entry = rooms.createRoom(viewer.id, { clubId: viewer.clubId, ...(autoAdmitClub !== undefined ? { autoAdmitClub } : {}) });
        return reply(201, { code: entry.code });
      }
      if (p2 === undefined) return failure(404, 'not-found');
      const code = p2;
      if (p3 === 'join' && p4 === undefined && method === 'POST') {
        const result = await rooms.requestJoin(code, viewer.id);
        return result.ok ? reply(200, result.value) : failure(statusFor(result.error), result.error);
      }
      if (p3 === 'status' && p4 === undefined && method === 'GET') {
        const status = rooms.statusOf(code, viewer.id);
        return status === 'unknown-code' || status === 'rate-limited' ? failure(statusFor(status), status) : reply(200, { status });
      }
      if (p3 === 'lobby' && p4 === undefined && method === 'GET') {
        const result = await rooms.lobbyView(code, viewer.id);
        return result.ok ? reply(200, result.value) : failure(statusFor(result.error), result.error);
      }
      let action: HostAction | undefined;
      if (p3 !== undefined && DOOR_ACTIONS.has(p3) && p4 !== undefined && method === 'POST') {
        action = { type: p3 as 'admit' | 'deny' | 'kick' | 'unblock', accountId: p4 };
      } else if (p3 === 'entry' && p4 === undefined && method === 'POST') {
        const open = bool(body, 'open');
        if (open === undefined) return failure(400, 'bad-request');
        action = { type: 'entry', open };
      } else if (p3 === 'auto-admit' && p4 === undefined && method === 'POST') {
        const on = bool(body, 'on');
        if (on === undefined) return failure(400, 'bad-request');
        action = { type: 'auto-admit', on };
      }
      if (action) {
        const result = rooms.hostAction(code, viewer.id, action);
        return result.ok ? reply(204) : failure(statusFor(result.error, 409), result.error);
      }
      return failure(404, 'not-found');
    }

    return failure(404, 'not-found');
  }

  return async (req, res) => {
    let outcome: Reply;
    try {
      outcome = await route(req, res);
    } catch {
      outcome = failure(500, 'internal');
    }
    if (outcome.body === undefined) {
      res.statusCode = outcome.status;
      res.end();
      return;
    }
    res.statusCode = outcome.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(outcome.body));
  };
}
