// @vitest-environment happy-dom
// The browser entry itself (K1.1 step 9, matrix row 19; tests audit r1 #2): main.ts is imported into a page with an
// #app element, as index.html loads it, and composes the real game with its real pieces — createGame, GameApi,
// ClientClock, RoomSession and the Three.js arena (happy-dom has no WebGL: the arena's renderer stays null and draws
// nothing). Only what would leave the page is stubbed: fetch answers /api/me with 401 (nobody is signed in, so the
// game shows the sign-in screen), and requestAnimationFrame keeps the render loop's callbacks instead of running them.
// The page address alone decides whether the debug overlay is on: "/?debug" shows a visible [data-debug] panel from
// the sign-in on, "/" and "/?debugger" show none. The unit tests of the overlay hand `debug: true` to createGame
// directly; this file is what fails when the entry does not pass the flag from location.search, which would leave
// the overlay unreachable on the owner's phone while every other test is green.
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The render loop's callbacks main.ts handed to requestAnimationFrame (kept, never run on their own). */
let frameCallbacks: FrameRequestCallback[] = [];
/** Every path main.ts fetched, in order. */
let fetched: string[] = [];

/** Lets the pending promise chains of the start (api.me and its answer) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Opens the page at `path` (the query included) and loads main.ts into it, as the browser does with index.html:
 * a fresh #app, a fresh module graph (main.ts starts the game when it is evaluated), then the start settles on the
 * sign-in screen.
 */
async function openPage(path: string): Promise<HTMLElement> {
  history.replaceState(null, '', path);
  expect(location.pathname + location.search).toBe(path);
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app');
  if (root === null) throw new Error('no #app');
  frameCallbacks = [];
  fetched = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  });
  vi.stubGlobal('fetch', (input: string): Promise<Response> => {
    fetched.push(input);
    const body = JSON.stringify({ error: 'unauthenticated' });
    return Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve(body) } as unknown as Response);
  });
  vi.resetModules();
  await import('../src/main.js');
  await settle();
  expect(fetched).toContain('/api/me');
  expect(root.dataset.screen).toBe('signin');
  return root;
}

/** The element is on the page and shown: connected, no hidden attribute, neither display none nor visibility hidden. */
function visible(element: Element | null): boolean {
  if (element === null || !element.isConnected || element.hasAttribute('hidden')) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

describe('the browser entry turns the debug overlay on from the page address (K1.1 step 9)', () => {
  it('"/?debug": the panel [data-debug] is in the game\'s root and visible on the sign-in screen, with no account or PIN', async () => {
    const root = await openPage('/?debug');
    const panel = root.querySelector('[data-debug]');
    expect(panel, 'the debug panel [data-debug] on /?debug').not.toBeNull();
    expect(visible(panel)).toBe(true);
    expect(document.querySelectorAll('[data-debug]')).toHaveLength(1);
    // The render loop runs with the panel on (its line of frames and draw calls is fed by game.frame).
    expect(frameCallbacks.length).toBeGreaterThan(0);
    frameCallbacks[0]?.(performance.now());
    expect(visible(root.querySelector('[data-debug]'))).toBe(true);
  });

  it('negative: "/" shows no panel', async () => {
    const root = await openPage('/');
    expect(root.querySelector('[data-debug]')).toBeNull();
    expect(document.querySelector('[data-debug]')).toBeNull();
  });

  it('negative: "/?debugger" (a parameter that only contains the word) shows no panel', async () => {
    const root = await openPage('/?debugger');
    expect(root.querySelector('[data-debug]')).toBeNull();
    expect(document.querySelector('[data-debug]')).toBeNull();
  });
});
