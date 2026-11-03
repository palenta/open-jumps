// The browser entry (plan 2.2): real dependencies composed into createGame — the HTTP API on the page's own
// origin (the session cookie travels by itself), the Colyseus SDK on the same host, the device clock
// (performance.now(), the one clock every clientTime is read from), the Three.js arena, and a render loop.
import { ColyseusSDK } from '@colyseus/sdk';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@open-jumps/shared';
import { createGame } from './app/game.js';
import { GameApi } from './net/api.js';
import { ClientClock } from './net/clientClock.js';
import { RoomSession } from './net/roomSession.js';
import { createArenaScene } from './scene/arena.js';

const LOCALE_KEY = 'open-jumps.locale';

function savedLocale(): Locale {
  try {
    const value = localStorage.getItem(LOCALE_KEY);
    if (isLocale(value)) return value;
  } catch {
    // Private mode or storage off: the default locale.
  }
  const browser = navigator.language.toLowerCase();
  return browser.startsWith('es') ? 'es' : DEFAULT_LOCALE;
}

function start(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('no #app element');
  const clock = new ClientClock(() => performance.now());
  const endpoint = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  const game = createGame({
    document,
    window,
    root,
    api: new GameApi((input, init) => fetch(input, init), ''),
    session: () => new RoomSession({ sdk: new ColyseusSDK(endpoint), clock }),
    clock,
    scene: createArenaScene(),
    locale: savedLocale(),
  });
  const observer = new MutationObserver(() => {
    try {
      localStorage.setItem(LOCALE_KEY, game.locale);
    } catch {
      // Storage off: the locale lives for the session only.
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ['data-screen'] });
  const loop = (): void => {
    game.frame(performance.now());
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

start();
