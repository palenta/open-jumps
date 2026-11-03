// The HTTP API wrapper against the real server (plan 2.2, matrix rows 1 and 2 from the client's side): the
// paths and bodies the client sends, the cookie the browser keeps, the typed results — and the wire types pinned
// to the server's own types, so a change on either side fails to compile here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicProfile as ServerPublicProfile } from '../../server/src/auth/accounts.js';
import type { LobbyView as ServerLobbyView } from '../../server/src/http/rooms.js';
import type { JoinDecision as ServerJoinDecision, ParticipantStatus as ServerParticipantStatus } from '../../server/src/rooms/admission.js';
import type { RoomMessage as ServerRoomMessage } from '../../server/src/rooms/authz.js';
import type { RoundEvent as ServerRoundEvent } from '../../server/src/round/roundEngine.js';
import type { ClassTableRow as ServerClassTableRow } from '../../server/src/round/classFlow.js';
import { GameApi, type FetchLike } from '../src/net/api.js';
import type {
  ClassTableRowWire,
  ClientRoomMessage,
  JoinDecision,
  LobbyView,
  ParticipantStatus,
  PublicProfile,
  RoundEventWire,
} from '../src/net/types.js';
import { bootApp, newDevice, type Device, type LiveApp } from './helpers.js';

// ---- the wire types are the server's types (compile-time only) --------------------------------------------------
// Mutual is `true` only when each type is assignable to the other, `false` otherwise (never `never`: a `never`
// would satisfy `extends true` and the guard would be empty). Assert<> refuses anything but `true`.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ProfileWire = Assert<Mutual<PublicProfile, ServerPublicProfile>>;
export type StatusWire = Assert<Mutual<ParticipantStatus, ServerParticipantStatus>>;
export type DecisionWire = Assert<Mutual<JoinDecision, ServerJoinDecision>>;
export type MessageWire = Assert<Mutual<ClientRoomMessage, ServerRoomMessage>>;
export type TableRowWire = Assert<Mutual<ClassTableRowWire, ServerClassTableRow>>;
// The server may send more than the client reads (never less): server → client assignability.
type Extends<Server, Client> = [Server] extends [Client] ? true : false;
export type LobbyViewWire = Assert<Extends<ServerLobbyView, LobbyView>>;
export type RoundEventWireCheck = Assert<Extends<ServerRoundEvent, RoundEventWire>>;
// Negative controls: the guard itself must reject incompatible types, or a passing typecheck proves nothing.
// @ts-expect-error string and number are not mutually assignable
export type GuardRejectsMutual = Assert<Mutual<string, number>>;
// @ts-expect-error a wider type is not assignable to a narrower one
export type GuardRejectsExtends = Assert<Extends<{ a: number } | { b: number }, { a: number }>>;

let live: LiveApp;

beforeAll(async () => {
  live = await bootApp();
});

afterAll(async () => {
  await live?.close();
});

describe('GameApi: requests as the page sends them', () => {
  /** A fetch that records the call and answers 401 with an error body. */
  function recording(): { fetch: FetchLike; calls: { input: string; init: RequestInit | undefined }[] } {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    return {
      calls,
      fetch: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
      },
    };
  }

  it('GET /api/me: a relative path on the same origin, credentials same-origin, no auth header', async () => {
    const rec = recording();
    const api = new GameApi(rec.fetch, '');
    const result = await api.me();
    expect(result).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.input).toBe('/api/me');
    expect(rec.calls[0]?.init?.method ?? 'GET').toBe('GET');
    expect(rec.calls[0]?.init?.credentials).toBe('same-origin');
    expect(new Headers(rec.calls[0]?.init?.headers).has('authorization')).toBe(false);
  });

  it('POST /api/accounts: JSON body with content-type, the base url prefixed', async () => {
    const rec = recording();
    const api = new GameApi(rec.fetch, 'https://play.open-jumps.test');
    await api.register({ riderName: 'Maria', pin: '1234', ponyName: 'Dakota', riderGender: 'girl', ponyGender: 'yegua', ponyCategory: 'B' });
    expect(rec.calls[0]?.input).toBe('https://play.open-jumps.test/api/accounts');
    expect(rec.calls[0]?.init?.method).toBe('POST');
    expect(new Headers(rec.calls[0]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(rec.calls[0]?.init?.body))).toEqual({ riderName: 'Maria', pin: '1234', ponyName: 'Dakota', riderGender: 'girl', ponyGender: 'yegua', ponyCategory: 'B' });
  });

  it('a fetch that never answers (offline) is a failure with status 0 and error "network", never a throw', async () => {
    const api = new GameApi(async () => {
      throw new TypeError('Failed to fetch');
    }, '');
    expect(await api.me()).toEqual({ ok: false, status: 0, error: 'network' });
    expect(await api.createRoom()).toEqual({ ok: false, status: 0, error: 'network' });
  });

  it('a non-JSON error body is a failure "http-<status>"', async () => {
    const api = new GameApi(async () => new Response('Bad Gateway', { status: 502 }), '');
    expect(await api.me()).toEqual({ ok: false, status: 502, error: 'http-502' });
  });
});

describe('GameApi against the live server: accounts and the session cookie', () => {
  it('register signs in (201 + cookie), me() reads the profile, logout clears the cookie, login signs in again', async () => {
    const device = await newDevice(live, 'Api');
    expect(device.profile).toMatchObject({ ponyName: 'Dakota', ponyGender: 'yegua', ponyCategory: 'C', clubId: null });
    expect(device.jar.header()).toMatch(/oj_session=/);

    const me = await device.api.me();
    expect(me).toEqual({ ok: true, value: device.profile });

    expect(await device.api.logout()).toEqual({ ok: true, value: undefined });
    expect(device.jar.header()).toBeUndefined(); // the server cleared the cookie; the browser forgets it
    expect(await device.api.me()).toEqual({ ok: false, status: 401, error: 'unauthorized' });

    const wrong = await device.api.login(device.profile.riderName, '9999');
    expect(wrong).toEqual({ ok: false, status: 401, error: 'invalid-credentials' });
    const again = await device.api.login(device.profile.riderName, '1234');
    expect(again).toEqual({ ok: true, value: device.profile });
    expect(device.jar.header()).toMatch(/oj_session=/);
  });

  it('registration errors come back as the server codes: a taken name is 409, a bad PIN 400', async () => {
    const device = await newDevice(live, 'Taken');
    const dup = await device.api.register({ riderName: device.profile.riderName, pin: '1234', ponyName: 'Luna', riderGender: 'girl', ponyGender: 'yegua' });
    expect(dup).toEqual({ ok: false, status: 409, error: 'rider-name-taken' });
    const badPin = await device.api.register({ riderName: `${device.profile.riderName}x`, pin: '12', ponyName: 'Luna', riderGender: 'girl', ponyGender: 'yegua' });
    expect(badPin).toEqual({ ok: false, status: 400, error: 'pin-format' });
  });
});

describe('GameApi against the live server: the doorbell', () => {
  let host: Device;
  let friend: Device;
  let other: Device;
  let code: string;
  let roomId: string;

  beforeAll(async () => {
    host = await newDevice(live, 'Host');
    friend = await newDevice(live, 'Friend');
    other = await newDevice(live, 'Other');
  });

  it('the host creates a room: a 6-character code and the live roomId', async () => {
    const created = await host.api.createRoom();
    if (!created.ok) throw new Error(created.error);
    expect(created.value.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(typeof created.value.roomId).toBe('string');
    code = created.value.code;
    roomId = created.value.roomId ?? '';
    expect(await host.api.roomStatus(code)).toEqual({ ok: true, value: { status: 'host', roomId } });
  });

  it('a friend rings: pending for her, listed for the host with her club (none); the lobby view is host-only', async () => {
    expect(await friend.api.knock(code)).toEqual({ ok: true, value: { status: 'pending' } });
    expect(await friend.api.roomStatus(code)).toEqual({ ok: true, value: { status: 'pending' } }); // no roomId while pending
    const view = await host.api.lobby(code);
    if (!view.ok) throw new Error(view.error);
    expect(view.value).toMatchObject({ code, hostId: host.profile.id, entryOpen: true, autoAdmitClub: false, clubId: null, kicked: [] });
    expect(view.value.participants.map((p) => p.id)).toEqual([host.profile.id]);
    expect(view.value.pending).toEqual([{ ...friend.profile, club: null }]);
    expect(await friend.api.lobby(code)).toEqual({ ok: false, status: 403, error: 'forbidden' });
  });

  it('admit: the friend learns the roomId; the door can be closed, which rejects the next visitor; auto-admit toggles', async () => {
    expect(await host.api.door(code, 'admit', friend.profile.id)).toEqual({ ok: true, value: undefined });
    expect(await friend.api.roomStatus(code)).toEqual({ ok: true, value: { status: 'admitted', roomId } });
    expect(await host.api.setEntry(code, false)).toEqual({ ok: true, value: undefined });
    expect(await other.api.knock(code)).toEqual({ ok: true, value: { status: 'rejected', reason: 'closed' } });
    expect(await host.api.setEntry(code, true)).toEqual({ ok: true, value: undefined });
    expect(await host.api.setAutoAdmit(code, true)).toEqual({ ok: true, value: undefined });
    const view = await host.api.lobby(code);
    expect(view.ok && view.value.autoAdmitClub).toBe(true);
  });

  it('kick and unblock: a kicked friend is listed under kicked and must ring again after the unblock', async () => {
    expect(await host.api.door(code, 'kick', friend.profile.id)).toEqual({ ok: true, value: undefined });
    expect(await friend.api.roomStatus(code)).toEqual({ ok: true, value: { status: 'kicked' } });
    const view = await host.api.lobby(code);
    expect(view.ok && view.value.kicked.map((p) => p.id)).toEqual([friend.profile.id]);
    expect(await host.api.door(code, 'unblock', friend.profile.id)).toEqual({ ok: true, value: undefined });
    expect(await friend.api.knock(code)).toEqual({ ok: true, value: { status: 'pending' } });
  });

  it('a guest cannot work the door (403), an unknown code is 404', async () => {
    expect(await friend.api.door(code, 'admit', other.profile.id)).toEqual({ ok: false, status: 403, error: 'forbidden' });
    expect(await friend.api.setEntry(code, false)).toEqual({ ok: false, status: 403, error: 'forbidden' });
    expect(await other.api.knock('ZZZZZZ')).toEqual({ ok: false, status: 404, error: 'unknown-code' });
    expect(await other.api.roomStatus('ZZZZZZ')).toEqual({ ok: false, status: 404, error: 'unknown-code' });
  });

  it('signed out, every room call is 401', async () => {
    await other.api.logout();
    expect(await other.api.createRoom()).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    expect(await other.api.knock(code)).toEqual({ ok: false, status: 401, error: 'unauthorized' });
  });
});
