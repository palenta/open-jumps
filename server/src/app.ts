// One host for everything (plan 2.2): static client files, the HTTP API and the Colyseus WebSocket on the same
// http server, with the Origin guard applied to state-changing requests and to WebSocket upgrades.
import type { Server as HttpServer } from 'node:http';
import type { Server as GameServer } from 'colyseus';
import { NotImplementedError } from '../src/errors.js';
import type { ApiDeps } from './http/api.js';

export interface AppOptions {
  api: ApiDeps;
  /** Directory of built client files to serve; null serves nothing but the API. */
  staticDir: string | null;
}

export interface App {
  httpServer: HttpServer;
  gameServer: GameServer;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createApp(_options: AppOptions): App {
  throw new NotImplementedError('createApp');
}
