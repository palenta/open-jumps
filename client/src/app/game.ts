// The application: the screens as DOM, the round-side modules wired to the room session, the touch layout on
// the arena, the tab lifecycle — everything the browser entry (main.ts) composes with real dependencies and the
// tests compose with fakes (happy-dom for the DOM, a scripted session and API, a recording scene). WebGL stays
// behind SceneLike, the only piece that needs a real browser.
import {
  allowedHeightClasses,
  caption as captionOf,
  DEFAULT_LOCALE,
  isLocale,
  translate,
  translateKey,
  type CaptionEvent,
  type CourseSpec,
  type Gear,
  type HeightClass,
  type Locale,
} from '@open-jumps/shared';
import { hudModel, resultsModel, riderOnPony, type HudNames } from '../hud/viewModel.js';
import { InputController } from '../input/controller.js';
import { hitTest, layoutFor, needsRotation, type Control, type Layout } from '../input/layout.js';
import { LobbyFlow, type LobbyPhase } from '../lobby/lobbyFlow.js';
import { lobbyModel } from '../lobby/lobbyModel.js';
import type { GameApi } from '../net/api.js';
import type { ClientClock } from '../net/clientClock.js';
import type { RoomSession, SessionEnd } from '../net/roomSession.js';
import type { ClassTableWire, ClientRoomMessage, LobbyStateSnapshot, LobbyView, PublicProfile, RoundEventWire, ServerMessage } from '../net/types.js';
import { InstantHint } from '../round/hint.js';
import { chaseCamera, type CameraPose } from '../scene/camera.js';
import { RemoteInterpolator, RoundClockEstimate } from '../scene/interpolation.js';
import { buildTrack, pointAt, type Track, type TrackPoint } from '../scene/track.js';
import { walkFocus, walkModel } from '../walk/walkModel.js';
import { screenFor, type Screen } from './screens.js';

/** What the scene draws in one frame: every horse of the running heat at its point, the camera, the walk focus. */
export interface SceneFrame {
  phase: 'walk' | 'riding' | 'results' | 'idle';
  riders: { id: string; point: TrackPoint; isOwn: boolean; label: string }[];
  camera: CameraPose | null;
  /** The fence the course walk focuses on (1-based), null outside the walk. */
  focusFence: number | null;
}

/** The 3D arena. Mounted into the arena element; told the course; drawn once per frame; disposed on destroy. */
export interface SceneLike {
  mount(container: HTMLElement): void;
  setCourse(course: CourseSpec | null): void;
  render(frame: SceneFrame): void;
  dispose(): void;
}

/** The pieces of window the game listens to (resize, pageshow); sizes come from measuring the arena, never from here. */
export interface WindowLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** The available arena rectangle in viewport (client) coordinates: where the controls live and where fingers land. */
export interface ArenaRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The API as the game uses it (public methods only, so a test can hand in a scripted object). */
export type ApiLike = Pick<GameApi, 'register' | 'login' | 'me' | 'logout' | 'createRoom' | 'knock' | 'roomStatus' | 'lobby' | 'door' | 'setEntry' | 'setAutoAdmit'>;

/** The room session as the game uses it (public surface only; a test can hand in a scripted one). */
export type SessionLike = Pick<RoomSession, 'connect' | 'resume' | 'leave' | 'send' | 'state' | 'status' | 'end' | 'reconnectionToken' | 'course' | 'onState' | 'onMessage' | 'onStatus'>;

/** The clock as the game uses it. */
export type ClockLike = Pick<ClientClock, 'now' | 'ready' | 'toClient' | 'toServer' | 'offset'>;

export interface GameDeps {
  document: Document;
  window: WindowLike;
  /** The element the screens are rendered into (emptied first). */
  root: HTMLElement;
  api: ApiLike;
  /** A session for the signed-in rider (the SDK carries the browser's cookie by itself); one per connect. */
  session: () => SessionLike;
  clock: ClockLike;
  scene: SceneLike;
  locale?: Locale;
  /**
   * Measures the arena element (default: its getBoundingClientRect()). The arena is laid out by CSS inside the
   * safe-area insets, so its rectangle IS the available area of plan 1.12; a test hands in the rectangle.
   */
  measure?: (element: HTMLElement) => ArenaRect;
  /** Timers for the lobby polling (injectable for tests). */
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
}

export interface Game {
  readonly screen: Screen;
  readonly locale: Locale;
  /** The current room session, null outside a room. */
  readonly session: SessionLike | null;
  setLocale(locale: Locale): void;
  /** One animation frame at device time `now`: HUD time, horses and camera; main.ts calls it from requestAnimationFrame. */
  frame(now: number): void;
  /** Re-measure the arena (resize / orientation change / the browser bars appearing) and re-place the controls. */
  resize(): void;
  destroy(): void;
}

/** The course walk lasts this long on the client's clock (the server's CLASS_TIMING.walkMs; the client is not told). */
const WALK_MS = 10_000;

const CONTROLS: Control[] = ['turn-left', 'turn-right', 'gear', 'tap'];

/** Everything the client keeps for one class: re-created at every class-course, so a new class starts clean. */
interface RoundModules {
  classNumber: number;
  course: CourseSpec;
  track: Track;
  hint: InstantHint;
  controller: InputController;
  interpolator: RemoteInterpolator;
  roundClock: RoundClockEstimate;
  /** The own horse's open approach: the take-off moment in device time, for the armed tap control. */
  armed: { fence: number; attempt: number; takeoffAt: number } | null;
  /** The last captioned event and whose horse it was (re-rendered in the locale of the moment). */
  caption: { event: CaptionEvent; riderId: string } | null;
  /** When the course walk began on the device clock. */
  walkStartedAt: number | null;
  requestedLine: 'center' | 'angle';
}

/**
 * The DOM contract (data attributes shared by the renderer, the styles and the tests):
 * - root[data-screen] is the Screen ('signin' | 'home' | 'lobby' | 'walk' | 'round' | 'results'); every visible
 *   string comes from translate() in the current locale; [data-action="locale"][data-locale="en"|"es"] switch it
 *   and re-render in place.
 * - signin: form[data-form="register"] (riderName, pin, ponyName, riderGender, ponyGender, ponyCategory) and
 *   form[data-form="login"] (riderName, pin); submit calls the API; a failure shows translate('signin.error.<code>')
 *   in [data-error]; success → home. On start the game asks api.me(): signed in → home, else signin.
 * - home: [data-hello] "Rider on Pony"; [data-action="create-room"] → LobbyFlow.create → connect → lobby;
 *   form[data-form="ring"] with [name="code"] → LobbyFlow.enter: while the host decides the screen is 'lobby'
 *   (screenFor with room 'joining') with [data-code] and [data-status] = translate('lobby.waiting'); once ready →
 *   connect; a refusal returns to home with translate('lobby.refused.<reason>') in [data-status];
 *   [data-action="logout"] → api.logout → signin.
 * - lobby: [data-code]; [data-list="participants"] > [data-id]; for the host [data-list="pending"] > [data-id] with
 *   [data-action="admit"|"deny"][data-id] and [data-list="kicked"] with [data-action="unblock"][data-id] (the host's
 *   LobbyView is fetched on entry, after every door action and whenever the state's pendingCount changes — a
 *   visitor ringing while the host is already in the lobby appears without a reload); input[data-action="entry-open"] and
 *   input[data-action="auto-admit"] (checkboxes); select[data-height] sends {type:'height'}; input[data-assist=
 *   "schoolmaster"|"widerWindow"] send {type:'assists'}; [data-action="start-class"] (host only) sends start-class
 *   with select[data-order]; [data-action="leave"] leaves to home. A session end shows translate('lobby.ended.
 *   <kind>') in [data-ended]; for 'lost' a [data-action="reconnect"] button asks the room status and connects again.
 * - walk: [data-list="fences"] > li (walkModel texts), [data-focus] the focused fence number, the scene mounted in
 *   [data-arena] with the course.
 * - round: the layout is layoutFor(rect.width, rect.height) of the MEASURED arena rectangle (deps.measure, by
 *   default getBoundingClientRect(); re-measured by resize() and on the window 'resize' event). The four controls
 *   are drawn as [data-control="turn-left"|"turn-right"|"gear"|"tap"], absolutely positioned INSIDE the arena with
 *   style left/top/width/height in px of the layout's zones (arena-local coordinates; the arena is
 *   position: relative). [data-arena] receives pointerdown: the finger's clientX/clientY minus the rectangle's
 *   left/top is tested with hitTest → InputController.press(control, clock.now()); a finger outside the rectangle
 *   is ignored. [data-hud-fence], [data-hud-faults], [data-hud-time], [data-hud-gear], [data-hud-caption],
 *   [data-badge] (placeholder art) from hudModel; [data-rotate] is shown (hidden attribute removed) when
 *   needsRotation(rect.width, rect.height). While the own horse's approach is open (from the 'approach' event
 *   until the 'takeoff' verdict) the tap control carries data-armed="true" and data-takeoff-at = clock.toClient(t0)
 *   (the device time of the take-off moment in the clock's own units — performance.now() ms in the browser), so
 *   the player sees the zone light up and a test can time its finger; both attributes go at the verdict.
 *   The round-side modules (InstantHint, InputController, RemoteInterpolator, RoundClockEstimate) are created
 *   anew at every class-course message, so a new class starts clean (a new round key, an empty buffer: the other
 *   horses are drawn from the new class's samples only, never from the last class's positions).
 * - results: [data-list="results"] > [data-class] tables with tr[data-id] rows (resultsModel), [data-action="again"]
 *   (host only; sends start-class) and [data-action="leave"].
 * - Lifecycle: document 'visibilitychange' (visible) and window 'pageshow' → session.resume(); window 'resize' →
 *   resize(). destroy() removes the listeners, leaves the session and disposes the scene.
 * - Captions use the participants' names from the state; the pony's gender is known only for the own rider
 *   (the state carries none), others read as 'yegua'.
 */
export function createGame(deps: GameDeps): Game {
  const doc = deps.document;
  const root = deps.root;
  const measure = deps.measure ?? ((element: HTMLElement): ArenaRect => element.getBoundingClientRect());
  const timers = deps.timers ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

  let locale: Locale = deps.locale ?? DEFAULT_LOCALE;
  let me: PublicProfile | null = null;
  let session: SessionLike | null = null;
  let sessionEnd: SessionEnd | null = null;
  let unsubscribeSession: (() => void)[] = [];
  let roomCode = '';
  let roomId = '';
  /** The doorbell flow while it runs (the lobby screen with the waiting text). */
  let flow: LobbyFlow | null = null;
  let joining = false;
  /** A refusal or an error shown on the home screen. */
  let homeStatus = '';
  let signinError = '';
  let view: LobbyView | null = null;
  let viewPendingCount = -1;
  let heightClass: HeightClass = 70;
  let assists = { schoolmaster: false, widerWindow: false };
  let order: 'random' | 'lowest-class-first' = 'random';
  let round: RoundModules | null = null;
  let table: ClassTableWire | null = null;
  let layout: Layout | null = null;
  let rect: ArenaRect | null = null;
  let destroyed = false;

  // The arena lives once: the scene mounts into it, the controls and the overlay sit in it; screens adopt it.
  const arena = doc.createElement('div');
  arena.dataset.arena = '';
  arena.className = 'arena';
  deps.scene.mount(arena);
  const controlElements = new Map<Control, HTMLElement>();
  for (const control of CONTROLS) {
    const element = doc.createElement('div');
    element.dataset.control = control;
    element.className = `control control-${control}`;
    arena.appendChild(element);
    controlElements.set(control, element);
  }
  const rotate = doc.createElement('div');
  rotate.dataset.rotate = '';
  rotate.className = 'rotate';
  rotate.setAttribute('hidden', '');
  arena.appendChild(rotate);

  // ---- helpers ------------------------------------------------------------------------------------------------

  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]): string => translate(locale, key, params);

  const state = (): LobbyStateSnapshot | null => session?.state ?? null;
  const isHost = (): boolean => me !== null && state()?.hostId === me.id;

  function screen(): Screen {
    return screenFor({ signedIn: me !== null, room: session !== null ? 'joined' : joining ? 'joining' : 'none', phase: state()?.phase ?? null });
  }

  function names(): HudNames {
    const result: HudNames = {};
    const current = state();
    if (current) {
      for (const [id, participant] of Object.entries(current.participants)) {
        result[id] = { riderName: participant.riderName, ponyName: participant.ponyName, ponyGender: me !== null && id === me.id ? me.ponyGender : 'yegua' };
      }
    }
    if (me) result[me.id] = { riderName: me.riderName, ponyName: me.ponyName, ponyGender: me.ponyGender };
    return result;
  }

  function captionText(): string {
    if (round?.caption === null || round?.caption === undefined) return '';
    const who = names()[round.caption.riderId];
    const captionNames = who ?? { riderName: round.caption.riderId, ponyName: round.caption.riderId, ponyGender: 'yegua' as const };
    return captionOf(locale, round.caption.event, { rider: captionNames.riderName, pony: captionNames.ponyName, ponyGender: captionNames.ponyGender });
  }

  function send(message: ClientRoomMessage): void {
    session?.send(message);
    if (message.type === 'line' && round) {
      round.requestedLine = message.line;
      round.hint.setLine(message.line);
    }
  }

  function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- the round modules ------------------------------------------------------------------------------------

  function newRound(course: CourseSpec, classNumber: number): RoundModules {
    const hint = new InstantHint(deps.clock as ClientClock, { heightClass, rules: { mode: 'ranked', assists: { ...assists } } });
    const controller = new InputController({ send });
    return {
      classNumber,
      course,
      track: buildTrack(course),
      hint,
      controller,
      interpolator: new RemoteInterpolator(),
      roundClock: new RoundClockEstimate(),
      armed: null,
      caption: null,
      walkStartedAt: null,
      requestedLine: 'center',
    };
  }

  function roundKey(): string {
    const current = state();
    return `${String(round?.classNumber ?? 0)}#${String(current?.heatIndex ?? -1)}`;
  }

  /** Feed a state patch to the round modules. */
  function onRoundState(current: LobbyStateSnapshot): void {
    if (!round || me === null) return;
    const own = current.riders[me.id];
    round.controller.update({
      riding: current.phase === 'riding' && own !== undefined && own.status === 'riding',
      round: roundKey(),
      nextFence: own?.nextFence ?? 1,
      attempt: own?.attempt ?? 1,
    });
    if (own) round.hint.setGear(own.gear);
    if (current.phase === 'riding') {
      round.roundClock.onPatch(current.roundClockMs, deps.clock.now());
      for (const [id, rider] of Object.entries(current.riders)) {
        if (id !== me.id) round.interpolator.push(id, current.roundClockMs, rider.positionM);
      }
    }
    if (current.phase === 'walk' && round.walkStartedAt === null) round.walkStartedAt = deps.clock.now();
  }

  function onRoundEvent(event: RoundEventWire): void {
    if (!round || me === null) return;
    const own = event.riderId === me.id;
    switch (event.type) {
      case 'approach':
        if (own) {
          round.hint.approach(event);
          const takeoffAt = deps.clock.toClient(event.t0);
          round.armed = takeoffAt === null ? null : { fence: event.fence, attempt: event.attempt, takeoffAt };
        }
        break;
      case 'takeoff':
        if (own) {
          round.hint.verdict(event);
          round.armed = null;
        }
        round.caption = { event: { type: 'takeoff', label: event.outcome.label, fence: event.fence }, riderId: event.riderId };
        break;
      case 'turn-ahead':
        if (own) round.controller.turnAhead(deps.clock.now());
        break;
      case 'turn':
        if (own) {
          round.controller.turnTaken();
          round.hint.setHardTurn(event.outcome.hardTurn);
        }
        round.caption = { event: { type: 'turn', label: event.outcome.label }, riderId: event.riderId };
        break;
      case 'restart':
        round.caption = { event: { type: 'restart', fence: event.fence }, riderId: event.riderId };
        break;
      case 'finish':
        round.caption = { event: { type: 'finish', elapsedMs: event.elapsedMs }, riderId: event.riderId };
        break;
      case 'eliminated':
        round.caption = { event: { type: 'eliminated', reason: event.reason }, riderId: event.riderId };
        break;
      case 'autopilot':
        round.caption = { event: { type: 'autopilot', on: event.on }, riderId: event.riderId };
        break;
      case 'waiting':
        break;
    }
  }

  // ---- the session ------------------------------------------------------------------------------------------

  function dropSession(): void {
    for (const unsubscribe of unsubscribeSession) unsubscribe();
    unsubscribeSession = [];
    session = null;
    sessionEnd = null;
    view = null;
    viewPendingCount = -1;
    round = null;
    table = null;
    deps.scene.setCourse(null);
  }

  async function connectTo(id: string, code: string): Promise<void> {
    const next = deps.session();
    session = next;
    sessionEnd = null;
    roomId = id;
    roomCode = code;
    unsubscribeSession = [
      next.onState((current) => {
        if (session !== next) return;
        onRoundState(current);
        if (isHost() && current.pendingCount !== viewPendingCount) void refreshView();
        render();
      }),
      next.onMessage((message) => {
        if (session !== next) return;
        onServerMessage(message);
      }),
      next.onStatus(() => {
        if (session !== next) return;
        if (next.status === 'ended') sessionEnd = next.end;
        render();
      }),
    ];
    try {
      await next.connect(id, code);
    } catch {
      if (session === next) {
        dropSession();
        homeStatus = t('lobby.refused.network');
      }
      render();
      return;
    }
    if (session !== next) return;
    joining = false;
    flow?.stop();
    flow = null;
    const current = next.state;
    if (current) onRoundState(current);
    render();
    if (isHost()) await refreshView();
  }

  function onServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'class-course': {
        round = newRound(message.course, message.classNumber);
        table = null;
        deps.scene.setCourse(message.course);
        const current = state();
        if (current) onRoundState(current);
        render();
        break;
      }
      case 'round-event':
        onRoundEvent(message.event);
        updateHud();
        break;
      case 'class-table':
        table = message.table;
        render();
        break;
      case 'refused':
        if (round) round.caption = { event: { type: 'refused', error: message.error }, riderId: me?.id ?? '' };
        updateHud();
        break;
      case 'class-phase':
      case 'clock-ping':
      case 'emote':
        break;
    }
  }

  async function refreshView(): Promise<void> {
    if (!session || !isHost()) return;
    const current = state();
    viewPendingCount = current?.pendingCount ?? -1;
    const result = await deps.api.lobby(roomCode);
    if (result.ok) {
      view = result.value;
      render();
    }
  }

  async function leaveRoom(): Promise<void> {
    const current = session;
    if (current) {
      try {
        await current.leave();
      } catch {
        // Leaving a dead connection is still leaving.
      }
    }
    dropSession();
    render();
  }

  async function reconnectAfterLoss(): Promise<void> {
    const status = await deps.api.roomStatus(roomCode);
    if (status.ok && (status.value.status === 'admitted' || status.value.status === 'host') && status.value.roomId !== undefined) {
      dropSession();
      await connectTo(status.value.roomId, roomCode);
    } else {
      dropSession();
      homeStatus = t('lobby.ended.lost');
      render();
    }
  }

  // ---- the doorbell -------------------------------------------------------------------------------------------

  function newFlow(): LobbyFlow {
    flow?.stop();
    const next = new LobbyFlow({ api: deps.api, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    flow = next;
    next.onChange((phase) => {
      if (flow !== next) return;
      onFlowPhase(phase);
    });
    return next;
  }

  function onFlowPhase(phase: LobbyPhase): void {
    switch (phase.kind) {
      case 'knocking':
      case 'waiting':
        joining = true;
        roomCode = phase.code;
        render();
        break;
      case 'ready':
        joining = true;
        roomCode = phase.code;
        void connectTo(phase.roomId, phase.code);
        break;
      case 'refused':
        joining = false;
        homeStatus = translateKey(locale, `lobby.refused.${phase.reason}`);
        render();
        break;
      case 'idle':
      case 'creating':
        break;
    }
  }

  // ---- input -----------------------------------------------------------------------------------------------

  function measureArena(): void {
    rect = measure(arena);
    layout = rect.width > 0 && rect.height > 0 ? layoutFor(rect.width, rect.height) : null;
    placeControls();
  }

  function placeControls(): void {
    const portrait = rect !== null && needsRotation(rect.width, rect.height);
    rotate.textContent = t('hud.rotate');
    if (portrait) rotate.removeAttribute('hidden');
    else rotate.setAttribute('hidden', '');
    for (const control of CONTROLS) {
      const element = controlElements.get(control);
      if (!element) continue;
      const zone = layout?.zones[control];
      if (!zone || portrait) {
        element.style.display = 'none';
        continue;
      }
      element.style.display = '';
      element.textContent = control === 'turn-left' ? t('hud.control.left') : control === 'turn-right' ? t('hud.control.right') : control === 'gear' ? t('hud.control.gear') : t('hud.control.tap');
      element.style.left = `${String(zone.x)}px`;
      element.style.top = `${String(zone.y)}px`;
      element.style.width = `${String(zone.w)}px`;
      element.style.height = `${String(zone.h)}px`;
    }
  }

  function onPointerDown(event: Event): void {
    if (screen() !== 'round' || !round || rect === null || layout === null) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[data-arena]') !== arena) return;
    const pointer = event as PointerEvent;
    const x = pointer.clientX - rect.left;
    const y = pointer.clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;
    const control = hitTest(layout, x, y);
    if (control === null) return;
    const now = deps.clock.now();
    const sent = round.controller.press(control, now);
    if (sent?.type === 'tap') {
      const hint = round.hint.tap(now);
      if (hint) round.caption = { event: { type: 'takeoff', label: hint.outcome.label, fence: hint.fence }, riderId: me?.id ?? '' };
    }
    updateHud();
  }

  // ---- rendering -----------------------------------------------------------------------------------------------

  function localeButtons(): string {
    return `<div class="locale"><span>${escapeHtml(t('home.language'))}:</span> <button type="button" data-action="locale" data-locale="en">EN</button> <button type="button" data-action="locale" data-locale="es">ES</button></div>`;
  }

  function renderSignin(): string {
    const options = (name: string, values: [string, string][]) =>
      `<select name="${name}">${values.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}</select>`;
    return `<section class="screen signin">
      <h1>${escapeHtml(t('signin.title'))}</h1>
      ${localeButtons()}
      <p data-error class="error">${escapeHtml(signinError)}</p>
      <form data-form="register" class="card">
        <h2>${escapeHtml(t('signin.newAccount'))}</h2>
        <label>${escapeHtml(t('signin.riderName'))} <input name="riderName" maxlength="16" autocomplete="off" required /></label>
        <label>${escapeHtml(t('signin.pin'))} <input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required /></label>
        <label>${escapeHtml(t('signin.ponyName'))} <input name="ponyName" maxlength="16" autocomplete="off" required /></label>
        <label>${escapeHtml(t('signin.riderGender'))} ${options('riderGender', [['girl', t('signin.riderGender.girl')], ['boy', t('signin.riderGender.boy')]])}</label>
        <label>${escapeHtml(t('signin.ponyGender'))} ${options('ponyGender', [['yegua', t('signin.ponyGender.yegua')], ['macho', t('signin.ponyGender.macho')]])}</label>
        <label>${escapeHtml(t('signin.ponyCategory'))} ${options('ponyCategory', [['C', 'C'], ['A', 'A'], ['B', 'B'], ['D', 'D']])}</label>
        <button type="submit">${escapeHtml(t('signin.register'))}</button>
      </form>
      <form data-form="login" class="card">
        <h2>${escapeHtml(t('signin.haveAccount'))}</h2>
        <label>${escapeHtml(t('signin.riderName'))} <input name="riderName" maxlength="16" autocomplete="off" required /></label>
        <label>${escapeHtml(t('signin.pin'))} <input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required /></label>
        <button type="submit">${escapeHtml(t('signin.login'))}</button>
      </form>
    </section>`;
  }

  function renderHome(): string {
    if (!me) return '';
    return `<section class="screen home">
      <h1 data-hello>${escapeHtml(t('home.hello', { rider: me.riderName, pony: me.ponyName }))}</h1>
      ${localeButtons()}
      <div class="card"><button type="button" data-action="create-room" class="primary">${escapeHtml(t('home.createRoom'))}</button></div>
      <form data-form="ring" class="card">
        <label>${escapeHtml(t('home.enterCode'))} <input name="code" maxlength="8" autocomplete="off" placeholder="${escapeHtml(t('home.codePlaceholder'))}" /></label>
        <button type="submit">${escapeHtml(t('home.join'))}</button>
      </form>
      <p data-status class="status">${escapeHtml(homeStatus)}</p>
      <button type="button" data-action="logout" class="link">${escapeHtml(t('home.logout'))}</button>
    </section>`;
  }

  function renderEnded(): string {
    if (!sessionEnd) return '';
    const message = translateKey(locale, `lobby.ended.${sessionEnd.kind}`);
    const reconnect = sessionEnd.kind === 'lost' ? `<button type="button" data-action="reconnect" class="primary">${escapeHtml(message)}</button>` : '';
    return `<p data-ended class="ended">${escapeHtml(message)}</p>${reconnect}`;
  }

  function renderLobby(): string {
    const current = state();
    if (!me) return '';
    if (!current) {
      return `<section class="screen lobby">
        <h1>${escapeHtml(t('lobby.title', { code: roomCode }))}</h1>
        <p class="code" data-code>${escapeHtml(roomCode)}</p>
        <p data-status class="status">${escapeHtml(t('lobby.waiting'))}</p>
        ${localeButtons()}
      </section>`;
    }
    const model = lobbyModel({ state: current, view, ownId: me.id, ponyCategory: me.ponyCategory, heightClass, assists, locale });
    const row = (person: { accountId: string; name: string; club?: string | null; tag?: string }, actions: string) =>
      `<li data-id="${escapeHtml(person.accountId)}">${escapeHtml(person.name)}${person.tag ? ` <em>${escapeHtml(person.tag)}</em>` : ''}${person.club ? ` <small>${escapeHtml(person.club)}</small>` : ''} ${actions}</li>`;
    const door = model.isHost
      ? `<h2>${escapeHtml(t('lobby.pending'))} (${String(model.pendingCount)})</h2>
        <ul data-list="pending">${model.pending.map((person) => row(person, `<button type="button" data-action="admit" data-id="${escapeHtml(person.accountId)}">${escapeHtml(t('lobby.admit'))}</button> <button type="button" data-action="deny" data-id="${escapeHtml(person.accountId)}">${escapeHtml(t('lobby.deny'))}</button>`)).join('')}</ul>
        <h2>${escapeHtml(t('lobby.kicked'))}</h2>
        <ul data-list="kicked">${model.kicked.map((person) => row(person, `<button type="button" data-action="unblock" data-id="${escapeHtml(person.accountId)}">${escapeHtml(t('lobby.unblock'))}</button>`)).join('')}</ul>
        <label><input type="checkbox" data-action="entry-open" ${model.entryOpen ? 'checked' : ''} /> ${escapeHtml(model.entryOpen ? t('lobby.entryOpen') : t('lobby.entryClosed'))}</label>
        <label><input type="checkbox" data-action="auto-admit" ${model.autoAdmitClub ? 'checked' : ''} /> ${escapeHtml(t('lobby.autoAdmit'))}</label>`
      : '';
    const start = model.isHost
      ? `<div class="start">
        <select data-order>
          <option value="random" ${order === 'random' ? 'selected' : ''}>${escapeHtml(t('lobby.startOrder.random'))}</option>
          <option value="lowest-class-first" ${order === 'lowest-class-first' ? 'selected' : ''}>${escapeHtml(t('lobby.startOrder.lowest-class-first'))}</option>
        </select>
        <button type="button" data-action="start-class" class="primary" ${model.canStart ? '' : 'disabled'}>${escapeHtml(t('lobby.start'))}</button>
      </div>`
      : '';
    return `<section class="screen lobby">
      <h1>${escapeHtml(model.title)}</h1>
      <p class="code" data-code>${escapeHtml(model.code)}</p>
      <p class="hint">${escapeHtml(t('lobby.shareCode'))}</p>
      ${renderEnded()}
      <h2>${escapeHtml(t('lobby.participants'))}</h2>
      <ul data-list="participants">${model.participants.map((person) => row({ accountId: person.accountId, name: person.name, tag: person.tag }, person.isHost ? '' : model.isHost ? `<button type="button" data-action="kick" data-id="${escapeHtml(person.accountId)}">${escapeHtml(t('lobby.kick'))}</button>` : '')).join('')}</ul>
      ${door}
      <label>${escapeHtml(t('lobby.height'))} <select data-height>${model.heightChoices.map((choice) => `<option value="${String(choice)}" ${choice === model.heightClass ? 'selected' : ''}>${escapeHtml(t('lobby.heightCm', { cm: choice }))}</option>`).join('')}</select></label>
      <fieldset><legend>${escapeHtml(t('lobby.assists'))}</legend>
        <label><input type="checkbox" data-assist="schoolmaster" ${model.schoolmaster ? 'checked' : ''} /> ${escapeHtml(t('lobby.schoolmaster'))}</label>
        <label><input type="checkbox" data-assist="widerWindow" ${model.widerWindow ? 'checked' : ''} /> ${escapeHtml(t('lobby.widerWindow'))}</label>
      </fieldset>
      ${start}
      <button type="button" data-action="leave" class="link">${escapeHtml(t('lobby.leave'))}</button>
      ${localeButtons()}
    </section>`;
  }

  function renderWalk(): string {
    if (!round) return '';
    const walk = walkModel(round.course, heightClass, locale);
    const focus = walkFocus(WALK_MS, round.course.fences.length, round.walkStartedAt === null ? 0 : deps.clock.now() - round.walkStartedAt);
    return `<section class="screen walk">
      <div class="walk-panel">
        <h1>${escapeHtml(walk.title)}</h1>
        <p>${escapeHtml(walk.timeText)}</p>
        <ol data-list="fences">${walk.fences.map((fence) => `<li>${escapeHtml(fence.text)} <small>${escapeHtml(fence.detail)}</small></li>`).join('')}</ol>
        <p class="focus"><span data-focus>${String(focus)}</span></p>
        ${localeButtons()}
      </div>
      <div class="arena-slot"></div>
    </section>`;
  }

  function renderRound(): string {
    return `<section class="screen round">
      <div class="arena-slot"></div>
      <div class="hud">
        <div class="hud-top"><span data-hud-fence></span><span data-hud-faults></span><span data-hud-time></span></div>
        <div class="hud-bottom"><span data-hud-gear></span><span data-hud-caption></span><span data-hud-phase></span></div>
        <div data-badge class="badge">${escapeHtml(t('app.placeholderArt'))}</div>
      </div>
    </section>`;
  }

  function renderResults(): string {
    if (!me || !table) return '';
    const classes = resultsModel(table, names(), locale, me.id);
    return `<section class="screen results">
      <div data-list="results">${classes
        .map(
          (cls) => `<table data-class="${String(cls.heightClass)}"><caption>${escapeHtml(cls.title)}</caption>
          <thead><tr><th>${escapeHtml(t('results.place'))}</th><th>${escapeHtml(t('results.rider'))}</th><th>${escapeHtml(t('results.faults'))}</th><th>${escapeHtml(t('results.time'))}</th></tr></thead>
          <tbody>${cls.rows.map((r) => `<tr data-id="${escapeHtml(r.accountId)}" ${r.isOwn ? 'class="own"' : ''}><td>${escapeHtml(r.placeText)}</td><td>${escapeHtml(r.name)}</td><td>${String(r.faults)}</td><td>${escapeHtml(r.timeText)}${r.note ? ` <small>${escapeHtml(r.note)}</small>` : ''}</td></tr>`).join('')}</tbody></table>`,
        )
        .join('')}</div>
      ${isHost() ? `<button type="button" data-action="again" class="primary">${escapeHtml(t('lobby.again'))}</button>` : ''}
      <button type="button" data-action="leave" class="link">${escapeHtml(t('lobby.leave'))}</button>
      ${renderEnded()}
      ${localeButtons()}
    </section>`;
  }

  let renderedScreen: Screen | null = null;

  function render(): void {
    if (destroyed) return;
    const current = screen();
    const html =
      current === 'signin' ? renderSignin()
      : current === 'home' ? renderHome()
      : current === 'lobby' ? renderLobby()
      : current === 'walk' ? renderWalk()
      : current === 'round' ? renderRound()
      : renderResults();
    if (current === 'round' && renderedScreen === 'round') {
      // The round screen is updated in place: its controls and listeners stay put at 20 Hz.
      updateHud();
      return;
    }
    root.innerHTML = html;
    root.dataset.screen = current;
    renderedScreen = current;
    const slot = root.querySelector('.arena-slot');
    if (slot) {
      slot.appendChild(arena);
      measureArena();
    }
    updateHud();
  }

  function updateHud(): void {
    if (destroyed) return;
    const current = state();
    if (renderedScreen === 'walk') {
      const focus = root.querySelector('[data-focus]');
      if (focus && round) focus.textContent = String(walkFocus(WALK_MS, round.course.fences.length, round.walkStartedAt === null ? 0 : deps.clock.now() - round.walkStartedAt));
      return;
    }
    if (renderedScreen !== 'round' || !current || !me) return;
    const hud = hudModel({
      state: current,
      ownId: me.id,
      locale,
      names: names(),
      fenceCount: round?.course.fences.length ?? 0,
      caption: captionText(),
      requestedGear: round?.controller.requestedGear ?? ('collected' as Gear),
    });
    const set = (selector: string, value: string) => {
      const element = root.querySelector(selector);
      if (element) element.textContent = value;
    };
    set('[data-hud-fence]', hud.fenceText);
    set('[data-hud-faults]', hud.faultsText);
    set('[data-hud-time]', hud.timeText);
    set('[data-hud-gear]', hud.gearText);
    set('[data-hud-caption]', hud.caption);
    set('[data-hud-phase]', hud.phaseText);
    set('[data-badge]', hud.badge);
    const tap = controlElements.get('tap');
    if (tap) {
      if (round?.armed) {
        tap.setAttribute('data-armed', 'true');
        tap.setAttribute('data-takeoff-at', String(round.armed.takeoffAt));
      } else {
        tap.removeAttribute('data-armed');
        tap.removeAttribute('data-takeoff-at');
      }
    }
  }

  // ---- DOM events --------------------------------------------------------------------------------------------

  function fieldValue(form: HTMLFormElement, name: string): string {
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)];
    const first = controls[0];
    if (!first) return '';
    if (first instanceof HTMLInputElement && first.type === 'radio') return controls.find((c) => (c as HTMLInputElement).checked)?.value ?? '';
    return first.value;
  }

  async function onSubmit(event: Event): Promise<void> {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const kind = form.dataset.form;
    if (kind === 'register' || kind === 'login') {
      const riderName = fieldValue(form, 'riderName');
      const pin = fieldValue(form, 'pin');
      const result =
        kind === 'register'
          ? await deps.api.register({
              riderName,
              pin,
              ponyName: fieldValue(form, 'ponyName'),
              riderGender: fieldValue(form, 'riderGender') === 'boy' ? 'boy' : 'girl',
              ponyGender: fieldValue(form, 'ponyGender') === 'macho' ? 'macho' : 'yegua',
              ...(fieldValue(form, 'ponyCategory') !== '' ? { ponyCategory: fieldValue(form, 'ponyCategory') as PublicProfile['ponyCategory'] } : {}),
            })
          : await deps.api.login(riderName, pin);
      if (result.ok) {
        signedIn(result.value);
      } else {
        signinError = translateKey(locale, `signin.error.${result.error}`);
      }
      render();
    } else if (kind === 'ring') {
      homeStatus = '';
      const code = fieldValue(form, 'code');
      void newFlow().enter(code);
      render();
    }
  }

  function signedIn(profile: PublicProfile): void {
    me = profile;
    signinError = '';
    const allowed = allowedHeightClasses(profile.ponyCategory);
    heightClass = allowed[0] ?? 70;
  }

  async function onClick(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actor = target.closest<HTMLElement>('[data-action]');
    if (!actor) return;
    const action = actor.dataset.action;
    const id = actor.dataset.id ?? '';
    switch (action) {
      case 'locale': {
        const next = actor.dataset.locale;
        if (isLocale(next)) setLocale(next);
        break;
      }
      case 'create-room':
        homeStatus = '';
        void newFlow().create();
        break;
      case 'logout':
        await deps.api.logout();
        dropSession();
        me = null;
        render();
        break;
      case 'admit':
      case 'deny':
      case 'kick':
      case 'unblock':
        await deps.api.door(roomCode, action, id);
        await refreshView();
        break;
      case 'start-class':
      case 'again':
        send({ type: 'start-class', order });
        break;
      case 'leave':
        await leaveRoom();
        break;
      case 'reconnect':
        await reconnectAfterLoss();
        break;
      default:
        break;
    }
  }

  async function onChange(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target instanceof HTMLSelectElement && target.hasAttribute('data-height')) {
      const value = Number(target.value) as HeightClass;
      heightClass = value;
      send({ type: 'height', heightClass: value });
      return;
    }
    if (target instanceof HTMLSelectElement && target.hasAttribute('data-order')) {
      order = target.value === 'lowest-class-first' ? 'lowest-class-first' : 'random';
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.assist !== undefined) {
      assists = { ...assists, [target.dataset.assist]: target.checked };
      send({ type: 'assists', schoolmaster: assists.schoolmaster, widerWindow: assists.widerWindow });
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.action === 'entry-open') {
      await deps.api.setEntry(roomCode, target.checked);
      await refreshView();
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.action === 'auto-admit') {
      await deps.api.setAutoAdmit(roomCode, target.checked);
      await refreshView();
    }
  }

  function onVisibility(): void {
    if (doc.visibilityState === 'visible' && session) void session.resume();
  }

  function onPageShow(): void {
    if (session) void session.resume();
  }

  function onResize(): void {
    resize();
  }

  const clickListener = (event: Event): void => void onClick(event);
  const submitListener = (event: Event): void => void onSubmit(event);
  const changeListener = (event: Event): void => void onChange(event);
  root.addEventListener('click', clickListener);
  root.addEventListener('submit', submitListener);
  root.addEventListener('change', changeListener);
  root.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('visibilitychange', onVisibility);
  deps.window.addEventListener('pageshow', onPageShow);
  deps.window.addEventListener('resize', onResize);

  // ---- the public game -----------------------------------------------------------------------------------------

  function setLocale(next: Locale): void {
    locale = next;
    render();
  }

  function frame(now: number): void {
    if (destroyed) return;
    const current = state();
    const currentScreen = screen();
    if (currentScreen === 'walk' && round) {
      updateHud();
      deps.scene.render({ phase: 'walk', riders: [], camera: null, focusFence: walkFocus(WALK_MS, round.course.fences.length, round.walkStartedAt === null ? 0 : now - round.walkStartedAt) });
      return;
    }
    if (currentScreen === 'round' && round && current && me) {
      updateHud();
      const renderTime = round.roundClock.estimate(now) ?? current.roundClockMs;
      const riders: SceneFrame['riders'] = [];
      let ownPoint: TrackPoint | null = null;
      for (const [id, rider] of Object.entries(current.riders)) {
        const isOwn = id === me.id;
        const position = isOwn ? rider.positionM : (round.interpolator.positionAt(id, renderTime) ?? rider.positionM);
        const point = pointAt(round.track, position);
        if (isOwn) ownPoint = point;
        riders.push({ id, point, isOwn, label: riderOnPony(locale, names(), id) });
      }
      const camera = ownPoint ?? riders[0]?.point ?? null;
      deps.scene.render({ phase: 'riding', riders, camera: camera ? chaseCamera(camera) : null, focusFence: null });
      return;
    }
    deps.scene.render({ phase: currentScreen === 'results' ? 'results' : 'idle', riders: [], camera: null, focusFence: null });
  }

  function resize(): void {
    if (destroyed) return;
    measureArena();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    root.removeEventListener('click', clickListener);
    root.removeEventListener('submit', submitListener);
    root.removeEventListener('change', changeListener);
    root.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('visibilitychange', onVisibility);
    deps.window.removeEventListener('pageshow', onPageShow);
    deps.window.removeEventListener('resize', onResize);
    flow?.stop();
    const current = session;
    dropSession();
    if (current) void current.leave();
    deps.scene.dispose();
  }

  const game: Game = {
    get screen() {
      return screen();
    },
    get locale() {
      return locale;
    },
    get session() {
      return session;
    },
    setLocale,
    frame,
    resize,
    destroy,
  };

  // Start: who is signed in?
  render();
  void deps.api.me().then((result) => {
    if (destroyed) return;
    if (result.ok) signedIn(result.value);
    render();
  });

  return game;
}
