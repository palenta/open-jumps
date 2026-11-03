// The client builds (plan 2.2): Vite produces client/dist with the entry page, the module bundle and the PWA
// manifest, and nothing in the built text is Russian (plan 1.5: no Russian in the game, ever).
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const run = promisify(execFile);

let outDir: string | null = null;

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

/** Every file under dir, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('vite build', () => {
  it('produces index.html, a module bundle and the manifest; no Cyrillic anywhere in the built text', async () => {
    outDir = mkdtempSync(join(tmpdir(), 'open-jumps-dist-'));
    await run(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'client/vite.config.ts', '--outDir', outDir, '--emptyOutDir'], { cwd: ROOT });
    expect(existsSync(join(outDir, 'index.html'))).toBe(true);
    expect(existsSync(join(outDir, 'manifest.webmanifest'))).toBe(true);
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(html).toMatch(/<script type="module"[^>]*src="\/assets\/[^"]+\.js"/);
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/);
    const files = filesUnder(outDir);
    expect(files.some((f) => /\/assets\/.*\.js$/.test(f))).toBe(true);
    const text = files.filter((f) => /\.(html|js|css|webmanifest|json|svg)$/.test(f));
    for (const file of text) expect(readFileSync(file, 'utf8'), file).not.toMatch(/[Ѐ-ӿ]/);
  }, 90000);
});
