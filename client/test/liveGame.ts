// The app itself against the real server, in Node: createGame on a happy-dom document that is NOT installed as the
// global `document` (so the SDK still sends the device's cookie and Origin as headers, as it does in Node), with
// real RoomSessions and the device's own ClientClock — the wiring main.ts does, minus WebGL. Only the DOM classes
// game.ts checks with instanceof are put on globalThis; a test file importing this module owns that change (Vitest
// isolates test files).
import { matchMaker } from 'colyseus';
import { Window } from 'happy-dom';
import type { LobbyState } from '../../server/src/colyseus/LobbyRoom.js';
import { createGame, type Game, type SceneFrame, type SceneLike } from '../src/app/game.js';
import { layoutFor, type Control } from '../src/input/layout.js';
import { RoomSession, type RetrySettings } from '../src/net/roomSession.js';
import type { ClientRoomMessage, ServerMessage } from '../src/net/types.js';
import { ORIGIN, until, type Device } from './helpers.js';

export const dom = new Window({ url: ORIGIN });
Object.assign(globalThis, {
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  HTMLFormElement: dom.HTMLFormElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLSelectElement: dom.HTMLSelectElement,
});

/** The arena of an iPhone 16e in landscape. */
export const ARENA = { left: 0, top: 0, width: 844, height: 390 };
const ARENA_LAYOUT = layoutFor(ARENA.width, ARENA.height);
/** The middle of a control's zone on the arena (viewport coordinates: the arena fills the viewport). */
const middleOf = (control: Control) => {
  const zone = ARENA_LAYOUT.zones[control];
  return { clientX: zone.x + zone.w / 2, clientY: zone.y + zone.h / 2 };
};
const TAP_POINT = middleOf('tap');

/** A scene that draws nothing and keeps every frame the game hands it (the take-off marker, the own horse). */
function recordingScene(frames: SceneFrame[]): SceneLike {
  return { mount: () => undefined, setCourse: () => undefined, render: (frame) => void frames.push(frame), dispose: () => undefined, drawCalls: () => null };
}
const noWindow = { addEventListener: () => undefined, removeEventListener: () => undefined };

export interface AppUnderTest {
  game: Game;
  root: HTMLElement;
  /**
   * Every message a session of the app actually handed to the SDK room, in order: the session reports what went out
   * (it sends nothing while dropped or connecting), so a press the session swallowed is not here.
   */
  sent: ClientRoomMessage[];
  /** Every message the app asked a session to send, in order — also those the session could not send. */
  attempted: ClientRoomMessage[];
  /** Every message every session of the app received, in order. */
  received: ServerMessage[];
  /** The roomId the app connected to (from its first connect). */
  roomId(): string;
  /** The device's own clock, the one the game reads (a finger's timeStamp is in its units, as in the browser). */
  clock: Device['clock'];
  /** Every frame the game handed to the scene, in order (game.frame(now) draws one). */
  frames: SceneFrame[];
}

export interface AppOptions {
  /** The SDK's retry settings for every session (the SDK's own retries are on, as in production). */
  retry?: RetrySettings;
}

/** The game as main.ts builds it, on this device, with real sessions (recorded on the way in and out); resolves on the home screen. */
export async function appFor(device: Device, options: AppOptions = {}): Promise<AppUnderTest> {
  const root = dom.document.createElement('div') as unknown as HTMLElement;
  dom.document.body.appendChild(root as unknown as Parameters<typeof dom.document.body.appendChild>[0]);
  const sent: ClientRoomMessage[] = [];
  const attempted: ClientRoomMessage[] = [];
  const received: ServerMessage[] = [];
  const frames: SceneFrame[] = [];
  let roomId = '';
  const game = createGame({
    document: dom.document as unknown as Document,
    window: noWindow,
    root,
    api: device.api,
    session: () => {
      const session = new RoomSession({ sdk: device.sdk(), clock: device.clock, autoReconnect: true, ...(options.retry ? { retry: options.retry } : {}) });
      const send = session.send.bind(session);
      session.send = (message) => {
        attempted.push(message);
        const went = send(message);
        if (went) sent.push(message);
        return went;
      };
      const connect = session.connect.bind(session);
      session.connect = (id, code) => {
        roomId ||= id;
        return connect(id, code);
      };
      session.onMessage((message) => received.push(message));
      return session;
    },
    clock: device.clock,
    scene: recordingScene(frames),
    locale: 'en',
    measure: () => ({ ...ARENA }),
  });
  await until(() => root.dataset.screen === 'home', 5000, 'the home screen');
  return { game, root, sent, attempted, received, roomId: () => roomId, clock: device.clock, frames };
}

export function click(root: HTMLElement, selector: string): void {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`missing ${selector}`);
  element.click();
}

/** Types a room code into the home screen's ring form and rings. */
export function ring(app: AppUnderTest, code: string): void {
  const form = app.root.querySelector('form[data-form="ring"]');
  const input = form?.querySelector<HTMLInputElement>('[name="code"]');
  if (!form || !input) throw new Error('no ring form on screen');
  input.value = code;
  form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
}

/**
 * A finger on the middle of the tap zone that landed at `timeStamp` (default: now) on the device's clock. In the
 * browser an event's timeStamp and the game's clock share one base, performance.now(); happy-dom stamps its events
 * with its own performance.now() while the device's clock reads Date.now(), so the stamp is set as a browser would.
 */
export function tapZone(app: AppUnderTest, timeStamp: number = app.clock.now()): void {
  const arena = app.root.querySelector('[data-arena]');
  if (arena === null) throw new Error('no arena on screen');
  const event = new dom.PointerEvent('pointerdown', { ...TAP_POINT, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  arena.dispatchEvent(event as unknown as Event);
}

/** A finger on the middle of a control's zone that landed at `timeStamp` (default: now), as tapZone does for the tap. */
export function pressControl(app: AppUnderTest, control: Control, timeStamp: number = app.clock.now()): void {
  const arena = app.root.querySelector('[data-arena]');
  if (arena === null) throw new Error('no arena on screen');
  const event = new dom.PointerEvent('pointerdown', { ...middleOf(control), bubbles: true, cancelable: true });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  arena.dispatchEvent(event as unknown as Event);
}

/** Text of an element with the whitespace collapsed. */
export const text = (element: Element | null): string => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The live room on the server side (its own state, its clients). */
export function serverRoom(roomId: string) {
  return matchMaker.getLocalRoomById(roomId);
}

/** The server's own view of a rider (the room state, which a dropped client cannot read). */
export function serverRider(roomId: string, accountId: string) {
  return (serverRoom(roomId).state as LobbyState).riders.get(accountId);
}

/** The server-side session ids of an account's live connections. */
export function sessionsOf(roomId: string, accountId: string): string[] {
  const room = serverRoom(roomId) as unknown as { accountBySession: Map<string, string> };
  return [...room.accountBySession].filter(([, id]) => id === accountId).map(([sessionId]) => sessionId);
}

/** Close an account's connection from the server side with `code` (a drop, unless it is the consented 4000). */
export function dropFromServer(roomId: string, accountId: string, code: number): void {
  const room = serverRoom(roomId);
  const ids = sessionsOf(roomId, accountId);
  const client = room.clients.find((c) => ids.includes(c.sessionId));
  if (!client) throw new Error('the rider has no connection to drop');
  client.leave(code);
}
