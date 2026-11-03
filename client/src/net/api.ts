// The HTTP API as the browser calls it (plan 2.2): same origin, the session is an HttpOnly cookie the browser
// sends by itself (credentials 'same-origin'), JSON in and out, no auth headers. Every call resolves to an
// ApiResult — the network layer never throws into the UI.
import type { DoorAction, JoinDecision, LobbyView, PublicProfile, RegisterInput, RoomStatusReply } from './types.js';

export type ApiFailure = {
  ok: false;
  /** HTTP status; 0 when the request never got an answer (offline, DNS, aborted). */
  status: number;
  /** The server's error code ('invalid-credentials', 'unknown-code'…), 'network' for status 0, 'http-<status>' when the body has none. */
  error: string;
};
export type ApiResult<T> = { ok: true; value: T } | ApiFailure;

/** The subset of fetch the API uses (injectable: tests pass a cookie-keeping fetch against the real server). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CreateRoomReply {
  code: string;
  /** The live room to joinById (present when the server runs live rooms, which production always does). */
  roomId?: string;
}

type Method = 'GET' | 'POST' | 'PATCH';

/**
 * Paths and methods (server/src/http/api.ts): POST /api/accounts (201), POST /api/login (200), POST /api/logout
 * (204), GET /api/me (200 | 401), POST /api/rooms (201 {code, roomId}), POST /api/rooms/:code/join (200
 * JoinDecision), GET /api/rooms/:code/status (200 {status, roomId?}), GET /api/rooms/:code/lobby (200 LobbyView,
 * host only), POST /api/rooms/:code/{admit|deny|kick|unblock}/:accountId (204), POST /api/rooms/:code/entry
 * {open} (204), POST /api/rooms/:code/auto-admit {on} (204). A non-2xx answer is a failure carrying the body's
 * `error`; 204 answers resolve with value undefined.
 */
export class GameApi {
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(fetchFn: FetchLike, baseUrl = '') {
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl;
  }

  register(input: RegisterInput): Promise<ApiResult<PublicProfile>> {
    return this.call<{ account: PublicProfile }>('POST', '/api/accounts', input).then(unwrap((body) => body.account));
  }

  login(riderName: string, pin: string): Promise<ApiResult<PublicProfile>> {
    return this.call<{ account: PublicProfile }>('POST', '/api/login', { riderName, pin }).then(unwrap((body) => body.account));
  }

  me(): Promise<ApiResult<PublicProfile>> {
    return this.call<PublicProfile>('GET', '/api/me');
  }

  logout(): Promise<ApiResult<void>> {
    return this.call<void>('POST', '/api/logout', {});
  }

  createRoom(autoAdmitClub?: boolean): Promise<ApiResult<CreateRoomReply>> {
    return this.call<CreateRoomReply>('POST', '/api/rooms', autoAdmitClub === undefined ? {} : { autoAdmitClub });
  }

  /** Ring the bell: the server answers with the admission decision (pending until the host decides). */
  knock(code: string): Promise<ApiResult<JoinDecision>> {
    return this.call<JoinDecision>('POST', `/api/rooms/${encodeURIComponent(code)}/join`, {});
  }

  roomStatus(code: string): Promise<ApiResult<RoomStatusReply>> {
    return this.call<RoomStatusReply>('GET', `/api/rooms/${encodeURIComponent(code)}/status`);
  }

  lobby(code: string): Promise<ApiResult<LobbyView>> {
    return this.call<LobbyView>('GET', `/api/rooms/${encodeURIComponent(code)}/lobby`);
  }

  door(code: string, action: DoorAction, accountId: string): Promise<ApiResult<void>> {
    return this.call<void>('POST', `/api/rooms/${encodeURIComponent(code)}/${action}/${encodeURIComponent(accountId)}`, {});
  }

  setEntry(code: string, open: boolean): Promise<ApiResult<void>> {
    return this.call<void>('POST', `/api/rooms/${encodeURIComponent(code)}/entry`, { open });
  }

  setAutoAdmit(code: string, on: boolean): Promise<ApiResult<void>> {
    return this.call<void>('POST', `/api/rooms/${encodeURIComponent(code)}/auto-admit`, { on });
  }

  /** One request: JSON body when given, same-origin credentials, the answer decoded into an ApiResult. */
  private async call<T>(method: Method, path: string, body?: unknown): Promise<ApiResult<T>> {
    const init: RequestInit = { method, credentials: 'same-origin' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, init);
    } catch {
      return { ok: false, status: 0, error: 'network' };
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    let json: unknown = undefined;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const error = typeof json === 'object' && json !== null && typeof (json as { error?: unknown }).error === 'string' ? (json as { error: string }).error : `http-${String(res.status)}`;
      return { ok: false, status: res.status, error };
    }
    return { ok: true, value: json as T };
  }
}

/** Maps a successful body; failures pass through untouched. */
function unwrap<B, T>(pick: (body: B) => T): (result: ApiResult<B>) => ApiResult<T> {
  return (result) => (result.ok ? { ok: true, value: pick(result.value) } : result);
}
