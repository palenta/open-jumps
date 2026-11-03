// Live fixtures for the client tests: the real server in-process (memory storage, short course and phases),
// a browser-like fetch that keeps the session cookie and sends the Origin, and a "device" = one rider with
// her API, her clock (possibly skewed) and an SDK that carries her cookie to the WebSocket.
import { ColyseusSDK } from '@colyseus/sdk';
import type { CourseSpec } from '@open-jumps/shared';
import { createApp, type App } from '../../server/src/app.js';
import { ADMIN_KEY, buildServices, uniqueRiderName, type Services } from '../../server/test/helpers.js';
import { GameApi, type FetchLike } from '../src/net/api.js';
import { ClientClock } from '../src/net/clientClock.js';
import type { PublicProfile } from '../src/net/types.js';

export const ORIGIN = 'https://play.open-jumps.test';

/** One fence at 30 m on 50 m, norm 250 m/min: allowed 12 s, so a clean passive run (finish ≈ 10.1 s) has no time faults. */
export const LIVE_COURSE: CourseSpec = {
  id: 'client-live',
  version: 1,
  lengthM: 50,
  speedMPerMin: 250,
  fences: [{ number: 1, distanceM: 30, type: 'vertical' }],
  turns: [],
};

export const TIMING = { walkMs: 500, resultsMs: 500 } as const;

export interface LiveApp {
  app: App;
  services: Services;
  port: number;
  base: string;
  endpoint: string;
  close(): Promise<void>;
}

export interface BootOptions {
  course?: CourseSpec;
  timing?: { walkMs: number; resultsMs: number };
  staticDir?: string;
  /** The live room's server clock (default Date.now): a test that must know every offset exactly freezes it. */
  clock?: () => number;
}

/** The whole server on a random port: API, static files (optional) and the live rooms. */
export async function bootApp(options: BootOptions = {}): Promise<LiveApp> {
  const services = buildServices();
  const course = options.course ?? LIVE_COURSE;
  const app = createApp({
    api: {
      accounts: services.accounts,
      sessions: services.sessions,
      clubs: services.clubs,
      rooms: services.rooms,
      config: { allowedOrigins: [ORIGIN], secureCookies: true, adminKey: ADMIN_KEY },
    },
    results: services.repos.results,
    staticDir: options.staticDir ?? null,
    course: () => course,
    timing: options.timing ?? TIMING,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  const port = await app.listen(0, '127.0.0.1');
  return {
    app,
    services,
    port,
    base: `http://127.0.0.1:${port}`,
    endpoint: `ws://127.0.0.1:${port}`,
    close: async () => {
      try {
        await app.close();
      } finally {
        await services.repos.close();
      }
    },
  };
}

/** The cookies a browser would keep for the game's origin (name → value), updated from every response. */
export class CookieJar {
  readonly cookies = new Map<string, string>();

  /** The Cookie header value, or undefined when the jar is empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const attrs = attributes.map((a) => a.trim().toLowerCase());
      const expired =
        attrs.some((a) => a === 'max-age=0' || a.startsWith('max-age=-')) ||
        attrs.some((a) => a.startsWith('expires=') && Date.parse(a.slice('expires='.length)) < Date.now());
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

/** fetch as the game's page does it: relative paths resolved against the origin, cookie + Origin headers, cookies absorbed. */
export function browserFetch(base: string, jar: CookieJar, origin = ORIGIN): FetchLike {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const cookie = jar.header();
    if (cookie) headers.set('cookie', cookie);
    headers.set('origin', origin);
    const res = await fetch(input.startsWith('http') ? input : base + input, { ...init, headers });
    jar.absorb(res);
    return res;
  };
}

export interface Device {
  jar: CookieJar;
  api: GameApi;
  clock: ClientClock;
  skewMs: number;
  profile: PublicProfile;
  /** An SDK that carries this device's cookie and Origin to the matchmaking request and the upgrade. */
  sdk(): ColyseusSDK;
}

/** A registered rider on her own device whose clock may run `skewMs` ahead of the server's (negative: behind). */
export async function newDevice(live: LiveApp, prefix = 'Rider', skewMs = 0, pin = '1234'): Promise<Device> {
  const jar = new CookieJar();
  const api = new GameApi(browserFetch(live.base, jar), '');
  const registered = await api.register({ riderName: uniqueRiderName(prefix), pin, ponyName: 'Dakota', riderGender: 'girl', ponyGender: 'yegua' });
  if (!registered.ok) throw new Error(`registration failed: ${registered.error}`);
  return {
    jar,
    api,
    clock: new ClientClock(() => Date.now() + skewMs),
    skewMs,
    profile: registered.value,
    sdk: () => new ColyseusSDK(live.endpoint, { headers: { cookie: jar.header() ?? '', origin: ORIGIN } }),
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}: not met within ${ms} ms`);
    await sleep(25);
  }
}
