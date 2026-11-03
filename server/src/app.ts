// One host for everything (plan 2.2): static client files, the HTTP API and the Colyseus WebSocket on the same
// http server, with the Origin guard applied to state-changing requests and to WebSocket upgrades.
//
// How the two HTTP sides share one server: Colyseus 0.18 serves `/matchmake/*` (and `/__healthcheck`) through
// a `request` listener it prepends to the http server when the game server starts listening; that listener
// answers every request that is not one of its routes with a 404 of its own, so a second plain `request`
// listener would double-answer. The supported way to coexist is the transport's express app (the `express`
// option of the Colyseus Server): Colyseus hands it every request its router does not match, and because the
// app has a root route Colyseus does not add its own "Colyseus <version>" page at `/`. Our handler is that
// app's only middleware: `/api/*` → the API, everything else → static files (or 404).
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { Server as GameServer, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import type { CourseSpec } from '@open-jumps/shared';
import { LOBBY_ROOM_NAME, LobbyRoom, type LobbyRoomDeps } from './colyseus/LobbyRoom.js';
import { createApi, type ApiDeps } from './http/api.js';
import { createUpgradeGuard } from './http/origin.js';
import type { ResultRepository } from './storage/repositories.js';

export interface AppOptions {
  api: ApiDeps;
  /** Where round results are recorded (LobbyRoom deps). */
  results: ResultRepository;
  /** Directory of built client files to serve; null serves nothing but the API. */
  staticDir: string | null;
  /** Test hooks for the class inside the live room (short course, short phases); production uses the defaults. */
  course?: (code: string, classNumber: number) => CourseSpec;
  timing?: { walkMs: number; resultsMs: number };
}

export interface App {
  httpServer: HttpServer;
  gameServer: GameServer;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** What createApp needs from the express app Colyseus mounts (express itself ships no types here). */
interface MountableApp {
  disable(setting: string): unknown;
  use(handler: (req: IncomingMessage, res: ServerResponse) => void): unknown;
}

/** Content types of the client build; anything else goes out as a plain binary. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

/**
 * Colyseus stamps permissive CORS headers (the request's Origin reflected, credentials allowed) on every
 * response of the shared server. They are meant for its matchmaking routes; on the API and the static files
 * they would let a foreign page read a cookie-authenticated response, so they are removed before we answer.
 */
const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-max-age',
] as const;

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not Found');
}

/**
 * The file under `staticRoot` a request target names, or null when the target cannot be decoded or escapes
 * the root. The raw target is used (fetch-style URL parsing would fold `..` away before we see it), decoded
 * once (so `%2e%2e` is `..`), resolved against the root, and the result must stay inside the root.
 */
function resolveStaticFile(staticRoot: string, target: string): string | null {
  const rawPath = target.split('?')[0]?.split('#')[0] ?? '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const pathname = decoded === '/' ? '/index.html' : decoded;
  const file = resolve(staticRoot, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  return file === staticRoot || file.startsWith(staticRoot + sep) ? file : null;
}

/** GET/HEAD only; `/` → index.html; a missing file, a directory or a path outside the root → 404. */
async function serveStatic(staticRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end();
    return;
  }
  const file = resolveStaticFile(staticRoot, req.url ?? '/');
  if (file === null) return notFound(res);
  let info;
  try {
    info = await stat(file);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);
  const extension = extname(file).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(info.size));
  // The page itself is revalidated on every visit so a new build shows at once; hashed assets may be cached.
  if (extension === '.html') res.setHeader('Cache-Control', 'no-cache');
  if (method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * One http.Server for everything (plan 2.2):
 * - `/api/*` → createApi(options.api) (its own Origin guard for state-changing requests);
 * - the Colyseus Server with WebSocketTransport({ server, beforeUpgrade: createUpgradeGuard(allowedOrigins) })
 *   attached to the same http server, LOBBY_ROOM_NAME defined as LobbyRoom and LobbyRoom.configure(...) called
 *   with the services from options (sessions, accounts, rooms, allowedOrigins, results, course, timing); the
 *   client-callable matchmaking methods restricted to joinById and reconnect (rooms are created by the API only);
 * - everything else → static files from staticDir (GET/HEAD only; `/` → index.html; paths are resolved inside
 *   staticDir and anything that escapes it, or does not exist, answers 404); with staticDir null → 404.
 * listen(port, host) resolves with the bound port (0 picks a free one); close() stops the game server, the
 * transport and the http server.
 */
export function createApp(options: AppOptions): App {
  const { allowedOrigins } = options.api.config;
  const staticRoot = options.staticDir === null ? null : resolve(options.staticDir);
  const httpServer = createServer();

  // The live rooms the API hands out: code → Colyseus room id, forgotten when the room is disposed.
  const liveRoomIds = new Map<string, string>();
  const liveRooms: NonNullable<ApiDeps['liveRooms']> = {
    async create(code) {
      const listing = await matchMaker.createRoom(LOBBY_ROOM_NAME, { code });
      liveRoomIds.set(code, listing.roomId);
      return listing.roomId;
    },
    idOf(code) {
      const roomId = liveRoomIds.get(code);
      if (roomId === undefined) return undefined;
      if (!matchMaker.getLocalRoomById(roomId)) {
        liveRoomIds.delete(code);
        return undefined;
      }
      return roomId;
    },
  };

  const api = createApi({ ...options.api, liveRooms: options.api.liveRooms ?? liveRooms });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    for (const name of CORS_HEADERS) res.removeHeader(name);
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/api' || path.startsWith('/api/')) return api(req, res);
    if (staticRoot === null) return notFound(res);
    return serveStatic(staticRoot, req, res);
  };

  // The matchmaking methods a client may call over `POST /matchmake/:method/:roomName`. Live rooms are the
  // server's to create (POST /api/rooms → liveRooms.create → matchMaker.createRoom, which this list does not
  // govern); a client may only take the seat it was handed (joinById) or come back to it (reconnect). Left at
  // the Colyseus default the surface also exposes `create`, `joinOrCreate` and `join`: anyone — no cookie, no
  // admission — could open an extra LobbyRoom for an existing code (onCreate only checks that the code exists)
  // and pile up rooms held open by autoDispose=false, or take a seat in whichever lobby is open. This is a
  // module-level setting of @colyseus/core (`matchMaker.controller` is one object shared by every Server in
  // the process, not a per-server option); it is set here, where the game server is built, and applies
  // process-wide. The route answers a method outside the list with the MATCHMAKE_NO_HANDLER error (HTTP 520).
  matchMaker.controller.exposedMethods = ['joinById', 'reconnect'];

  const transport = new WebSocketTransport({ server: httpServer, beforeUpgrade: createUpgradeGuard(allowedOrigins) });
  const gameServer = new GameServer({
    transport,
    greet: false,
    // Signals are the entry point's business (index.ts); a library-style app never hooks the process.
    gracefullyShutdown: false,
    express: (app: MountableApp) => {
      app.disable('x-powered-by');
      app.use((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        });
      });
    },
  });

  const deps: LobbyRoomDeps = {
    sessions: options.api.sessions,
    accounts: options.api.accounts,
    rooms: options.api.rooms,
    allowedOrigins,
    results: options.results,
    ...(options.course !== undefined ? { course: options.course } : {}),
    ...(options.timing !== undefined ? { timing: options.timing } : {}),
  };
  LobbyRoom.configure(deps);
  gameServer.define(LOBBY_ROOM_NAME, LobbyRoom).on('dispose', (room: { roomId: string }) => {
    for (const [code, roomId] of liveRoomIds) {
      if (roomId === room.roomId) liveRoomIds.delete(code);
    }
  });

  let closing: Promise<void> | null = null;

  return {
    httpServer,
    gameServer,
    async listen(port, host) {
      await gameServer.listen(port, host);
      const address = httpServer.address();
      if (address === null || typeof address === 'string') throw new Error('the http server is not listening on a TCP port');
      return address.port;
    },
    close() {
      closing ??= (async () => {
        // The server's own close event (every connection gone), bounded so a lingering socket cannot hang us.
        const closed = once(httpServer, 'close', { signal: AbortSignal.timeout(5_000) }).then(
          () => undefined,
          () => undefined,
        );
        // Disposes every room (clients disconnected), closes the WebSocket server and the http server,
        // shuts the presence and the driver down — without exiting the process.
        await gameServer.gracefullyShutdown(false);
        httpServer.closeAllConnections();
        if (httpServer.listening) await new Promise<void>((done) => httpServer.close(() => done()));
        await closed;
      })();
      return closing;
    },
  };
}
