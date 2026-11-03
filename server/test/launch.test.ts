// The server starts as a program (plan 2.2; closes the backlog item "no runner for server/src/index.ts"): tsx runs
// the TypeScript entry, the config comes from the environment, the API, the static client files and SQLite work,
// and SIGTERM shuts it down cleanly.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = 2602; // other live test files bind their own ports or random ones
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;

let root: string;
let child: ChildProcess;
let stdout = '';
let stderr = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'open-jumps-launch-'));
  const staticDir = join(root, 'public');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Open Jumps</title>\n');
  child = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['server/src/index.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ADMIN_KEY: 'launch-test-key',
      ALLOWED_ORIGINS: ORIGIN,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: join(root, 'data', 'launch.sqlite'),
      STATIC_DIR: staticDir,
      SECURE_COOKIES: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 20000;
  while (!stdout.includes('Open Jumps listening')) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr}`);
    if (Date.now() > deadline) throw new Error(`server did not announce itself: ${stdout}\n${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}, 30000);

afterAll(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('the server as a program', () => {
  it('announces the port, the origins, the database and the static directory', () => {
    expect(stdout).toMatch(new RegExp(`listening on http://127\\.0\\.0\\.1:${PORT}`));
    expect(stdout).toContain(ORIGIN);
    expect(stdout).toContain('launch.sqlite');
  });

  it('serves the client page at /, the API under /api, and sets the cookie without Secure when told so', async () => {
    const page = await fetch(`${BASE}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Open Jumps');

    const me = await fetch(`${BASE}/api/me`);
    expect(me.status).toBe(401);

    const created = await fetch(`${BASE}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ riderName: 'Launch', pin: '1234', ponyName: 'Dakota', riderGender: 'girl', ponyGender: 'yegua' }),
    });
    expect(created.status).toBe(201);
    const cookie = created.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^oj_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/Secure/);
    expect(existsSync(join(root, 'data', 'launch.sqlite'))).toBe(true);
  });

  it('SIGTERM stops it with exit code 0', async () => {
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8000))]);
    expect(code).toBe(0);
    // Node's own note that node:sqlite is experimental is the only thing allowed on stderr (backlog: experimental module).
    const unexpected = stderr
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('ExperimentalWarning: SQLite') && !line.includes('--trace-warnings'));
    expect(unexpected).toEqual([]);
  }, 10000);
});
