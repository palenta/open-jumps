// Entry point: configuration from the environment only (no secrets in code), SQLite storage, one listening app.
//   PORT (default 8080), HOST (default 0.0.0.0), ADMIN_KEY (required), ALLOWED_ORIGINS (comma-separated,
//   required), DB_PATH (default ./data/open-jumps.sqlite), STATIC_DIR (optional), SECURE_COOKIES (default true).
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { AccountService } from './auth/accounts.js';
import { SessionService } from './auth/sessions.js';
import { ClubService } from './clubs/clubs.js';
import { RoomDirectory } from './http/rooms.js';
import { createSqliteRepositories } from './storage/sqlite.js';

export interface ServerEnv {
  PORT?: string;
  HOST?: string;
  ADMIN_KEY?: string;
  ALLOWED_ORIGINS?: string;
  DB_PATH?: string;
  STATIC_DIR?: string;
  SECURE_COOKIES?: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  adminKey: string;
  allowedOrigins: string[];
  dbPath: string;
  staticDir: string | null;
  secureCookies: boolean;
}

const ENV_KEYS = ['PORT', 'HOST', 'ADMIN_KEY', 'ALLOWED_ORIGINS', 'DB_PATH', 'STATIC_DIR', 'SECURE_COOKIES'] as const;

const DEFAULTS = { port: 8080, host: '0.0.0.0', dbPath: './data/open-jumps.sqlite' } as const;

/** Every configuration error names its variable first, so the fix is obvious from the message alone. */
function fail(variable: keyof ServerEnv, problem: string): never {
  throw new Error(`${variable} ${problem}`);
}

/** An absolute origin as a browser sends it: `scheme://host[:port]`, http(s), no path, query or fragment. */
function isAbsoluteOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
}

/** Unset and empty are the same thing for every optional variable. */
const text = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

/**
 * Validate the environment into a config; throws an Error naming the variable when something is wrong:
 * ADMIN_KEY and ALLOWED_ORIGINS are required (ALLOWED_ORIGINS = comma-separated origins, trimmed, each an
 * absolute origin `scheme://host[:port]` without path); PORT must be an integer 1–65535 (default 8080); HOST
 * defaults to 0.0.0.0; DB_PATH defaults to ./data/open-jumps.sqlite; STATIC_DIR is optional (null when unset
 * or empty); SECURE_COOKIES accepts 'true' / 'false' (default true, anything else is an error).
 */
export function configFromEnv(env: ServerEnv): ServerConfig {
  const adminKey = env.ADMIN_KEY ?? '';
  if (adminKey.trim() === '') fail('ADMIN_KEY', 'is required: the owner key that authorises PIN resets');

  const origins = text(env.ALLOWED_ORIGINS);
  if (origins === null) fail('ALLOWED_ORIGINS', 'is required: comma-separated origins such as https://play.example.com');
  const allowedOrigins = origins.split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');
  if (allowedOrigins.length === 0) fail('ALLOWED_ORIGINS', 'must list at least one origin');
  for (const origin of allowedOrigins) {
    if (!isAbsoluteOrigin(origin)) fail('ALLOWED_ORIGINS', `entry "${origin}" is not an absolute origin scheme://host[:port] without a path`);
  }

  let port: number = DEFAULTS.port;
  const rawPort = text(env.PORT);
  if (rawPort !== null) {
    port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT', `must be an integer between 1 and 65535, got "${rawPort}"`);
  }

  let secureCookies = true;
  const rawSecure = text(env.SECURE_COOKIES);
  if (rawSecure !== null) {
    if (rawSecure !== 'true' && rawSecure !== 'false') fail('SECURE_COOKIES', `must be 'true' or 'false', got "${rawSecure}"`);
    secureCookies = rawSecure === 'true';
  }

  return {
    port,
    host: text(env.HOST) ?? DEFAULTS.host,
    adminKey,
    allowedOrigins,
    dbPath: text(env.DB_PATH) ?? DEFAULTS.dbPath,
    staticDir: text(env.STATIC_DIR),
    secureCookies,
  };
}

/** The process environment narrowed to the variables we read (unset ones left out, never `undefined`). */
function envFromProcess(): ServerEnv {
  const env: ServerEnv = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Uniform in [0, 1) from the CSPRNG: room and club codes are secrets, so Math.random is not enough. */
const secureRandom = (): number => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

export async function main(): Promise<void> {
  const config = configFromEnv(envFromProcess());
  mkdirSync(dirname(resolve(config.dbPath)), { recursive: true });
  const repos = createSqliteRepositories(config.dbPath);
  const clock = (): number => Date.now();
  const sessions = new SessionService({ repos, clock });
  const accounts = new AccountService({ repos, sessions, clock, adminKey: config.adminKey });
  const clubs = new ClubService({ repos, clock, rng: secureRandom });
  const rooms = new RoomDirectory({ clock, rng: secureRandom, clubs, accounts });
  const app = createApp({
    api: {
      accounts,
      sessions,
      clubs,
      rooms,
      config: { allowedOrigins: config.allowedOrigins, secureCookies: config.secureCookies, adminKey: config.adminKey },
    },
    results: repos.results,
    staticDir: config.staticDir,
  });

  const port = await app.listen(config.port, config.host);
  console.log(
    `Open Jumps listening on http://${config.host}:${port} — origins ${config.allowedOrigins.join(', ')}; db ${config.dbPath}; static ${config.staticDir ?? '(none)'}`,
  );

  const shutdown = (): void => {
    void app
      .close()
      .then(() => repos.close())
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// Run only when this file is the program (not when a test imports configFromEnv).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
