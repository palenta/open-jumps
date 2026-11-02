// Entry point: configuration from the environment only (no secrets in code), SQLite storage, one listening app.
//   PORT (default 8080), HOST (default 0.0.0.0), ADMIN_KEY (required), ALLOWED_ORIGINS (comma-separated,
//   required), DB_PATH (default ./data/open-jumps.sqlite), STATIC_DIR (optional), SECURE_COOKIES (default true).
import { NotImplementedError } from './errors.js';

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

/** Validate the environment into a config; throws with a clear message when something required is missing. */
export function configFromEnv(_env: ServerEnv): ServerConfig {
  throw new NotImplementedError('configFromEnv');
}

export async function main(): Promise<void> {
  throw new NotImplementedError('main');
}
