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
import { heatResultsModel, hudModel, namesFrom, resultsModel, riderOnPony, type HudNames } from '../hud/viewModel.js';
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

const CONTROLS: Control[] = ['turn-left', 'turn-right', 'gear', 'tap'];

/**
 * The moment of a press in the clock's units (audit K1 r3 #4, r4 #1): the event's own timeStamp — a
 * DOMHighResTimeStamp in the base of performance.now(), the clock main.ts gives ClientClock — whenever it can be a
 * moment of that clock: finite, after its origin (> 0) and not later than `now` (the clock read while handling).
 * Otherwise the stamp is of another base or none at all — epoch ms or a system uptime in an old engine are later than
 * now, a missing or broken one is 0, negative or not finite — and `now` is used. An old stamp is still the moment of
 * the touch and is kept however old it is: the age of a correct stamp says the page was slow, not that its clock is
 * another, and replacing it with the handling time would make a finger that landed long before the take-off window
 * a fresh tap inside it. What an old press means is then the controller's business: a tap or a turn already older
 * than the judge accepts (INPUT.maxPressAgeMs = PACKET.maxAgeMs) is not sent at all (see InputController.press). The
 * handler runs whenever the main thread is free — 58–122 ms after the touch was measured while frames took 33–77 ms
 * — and the judge must see when the finger landed, not when the page got round to it.
 */
export function pressTime(timeStamp: number, now: number): number {
  if (!Number.isFinite(timeStamp) || timeStamp <= 0 || timeStamp > now) return now;
  return timeStamp;
}

/** Everything the client keeps for one class: re-created at every class-course, so a new class starts clean. */
interface RoundModules {
  classNumber: number;
  course: CourseSpec;
  track: Track;
  hint: InstantHint;
  controller: InputController;
  interpolator: RemoteInterpolator;
  roundClock: RoundClockEstimate;
  /**
   * The own horse's open approach with its take-off moment in SERVER ms, for the armed tap control: translated into
   * device time whenever the control is drawn, so an approach heard before the clock was measured lights up once it
   * is (audit K1 r2 #3).
   */
  armed: { fence: number; attempt: number; t0: number } | null;
  /** The last captioned event and whose horse it was (re-rendered in the locale of the moment). */
  caption: { event: CaptionEvent; riderId: string } | null;
  /**
   * The course walk in progress as the server announced it ('class-phase' walk), in SERVER ms as sent: the fly-over
   * paces itself over [startedAt, endsAt], read through the clock at every frame — never translated once on arrival,
   * when a late joiner's clock may not be measured yet (audit K1 r2 #3). Null until the message arrives and again for
   * a walk of another heat.
   */
  walk: { heatIndex: number; startedAt: number; endsAt: number } | null;
  requestedLine: 'center' | 'angle';
}

/**
 * The DOM contract (data attributes shared by the renderer, the styles and the tests):
 * - root[data-screen] is the Screen ('signin' | 'home' | 'lobby' | 'walk' | 'round' | 'results' | 'ended'); every
 *   visible string comes from translate() in the current locale; [data-action="locale"][data-locale="en"|"es"]
 *   switch it and re-render in place.
 * - signin: form[data-form="register"] (riderName, pin, ponyName, riderGender, ponyGender, ponyCategory) and
 *   form[data-form="login"] (riderName, pin); submit calls the API; a failure shows translate('signin.error.<code>')
 *   in [data-error]; success → home. On start the game asks api.me(): signed in → home, else signin.
 * - home: [data-hello] "Rider on Pony"; [data-action="create-room"] → LobbyFlow.create → connect → lobby;
 *   form[data-form="ring"] with [name="code"] → LobbyFlow.enter: while the host decides the screen is 'lobby'
 *   (screenFor with room 'joining') with [data-code] and [data-status] = translate('lobby.waiting') and a
 *   [data-action="leave"] that gives up; once ready → connect; a refusal returns to home with
 *   translate('lobby.refused.<reason>') in [data-status]; a WebSocket refused after the admission returns to home
 *   with translate('lobby.refused.network') and [data-action="retry"], which rings the same code again (audit K1
 *   r1 #3); [data-action="logout"] → api.logout → signin.
 * - lobby: [data-code]; [data-list="participants"] > [data-id]; for the host [data-list="pending"] > [data-id] with
 *   [data-action="admit"|"deny"][data-id] and [data-list="kicked"] with [data-action="unblock"][data-id] (the host's
 *   LobbyView is fetched on entry, after every door action and whenever the state's pendingCount changes — a
 *   visitor ringing while the host is already in the lobby appears without a reload); input[data-action="entry-open"] and
 *   input[data-action="auto-admit"] (checkboxes); select[data-height] sends {type:'height'}; input[data-assist=
 *   "schoolmaster"|"widerWindow"] send {type:'assists'}; [data-action="start-class"] (host only) sends start-class
 *   with select[data-order]; [data-action="leave"] leaves to home.
 * - ended: shown the moment the session is over for good (kicked, revoked, lost), whatever phase the last state
 *   named — never a frozen walk or round (audit K1 r1 #5): translate('lobby.ended.<kind>') in [data-ended]; for
 *   'lost' a [data-action="reconnect"] button asks the room status and connects a new session; [data-action="leave"]
 *   goes home. The arena takes no input on this screen.
 * - walk: [data-list="fences"] > li (walkModel texts), [data-focus] the focused fence number, the scene mounted in
 *   [data-arena] with the course. The fly-over paces itself over the window the server announces in the
 *   'class-phase' walk message (startedAt / endsAt in server ms) — one window per heat; until it is known, and for a
 *   walk of another heat, the focus is fence 1 (audit K1 r1 #6: no client constant). The window is kept in server
 *   ms and read through the clock at every frame and every clock ping: a late joiner whose clock is not measured
 *   yet sees fence 1 for the moment, then the fence of the server's window and its end at the server's deadline —
 *   never a walk restarted at the join (audit K1 r2 #3).
 * - round: the layout is layoutFor(rect.width, rect.height) of the MEASURED arena rectangle (deps.measure, by
 *   default getBoundingClientRect(); re-measured by resize() and on the window 'resize' event). The four controls
 *   are drawn as [data-control="turn-left"|"turn-right"|"gear"|"tap"], absolutely positioned INSIDE the arena with
 *   style left/top/width/height in px of the layout's zones (arena-local coordinates; the arena is
 *   position: relative). [data-arena] receives pointerdown: the finger's clientX/clientY minus the rectangle's
 *   left/top is tested with hitTest → InputController.press(control, pressTime(event.timeStamp, now), now) with now
 *   = clock.now() at handling; a finger outside the rectangle is ignored. The time of a press is the moment of the
 *   touch (audit K1 r3 #4): the event's timeStamp (performance.now() base, the clock's own units in the browser) is
 *   the clientTime of a 'tap' or a 'turn', the moment the turn window is checked against and the moment the instant
 *   hint judges. The turn window opens when the own horse's 'turn-ahead' is handled, at clock.now() then — the same
 *   clock and units as pressTime — and lasts INPUT.turnWindowMs: a direction press is a turn only when its moment is
 *   inside [opened, opened + INPUT.turnWindowMs) — exactly at the opening is inside, exactly at the end is not — and a
 *   finger that landed before the opening is a line shift even when its handler runs after it, and spends no turn, so
 *   the next deliberate press in the window is the turn (audit K1 r5 #2). A timeStamp that cannot be a moment of the
 *   clock — not finite, 0 or negative, later than clock.now() — is another base or none, and clock.now() at handling is
 *   used instead. A correct timeStamp is never replaced, however old (audit K1 r4 #1): a tap, or a direction press
 *   that is a turn at its moment, already more than INPUT.maxPressAgeMs (= PACKET.maxAgeMs, 300 ms: the judge's
 *   'too-old' limit) before clock.now() when it is handled sends nothing, spends nothing and shows no hint — the tap
 *   zone stays lit and the turn window open, so the next timely press goes out. Its packet would reach the server no
 *   earlier than it is handled, so the judge could accept it only if an error of the clock measurement in its favour
 *   outweighed the whole transit; sending it would only spend the attempt or the turn. A press exactly
 *   INPUT.maxPressAgeMs old when handled still goes out. The gear and a line shift carry no time and go out whatever
 *   the age. [data-hud-fence], [data-hud-faults], [data-hud-time], [data-hud-gear], [data-hud-caption],
 *   [data-badge] (placeholder art) from hudModel; [data-rotate] is shown (hidden attribute removed) when
 *   needsRotation(rect.width, rect.height), and while it is shown every pointerdown on the arena is ignored (the
 *   hidden zones take no input). While the own horse's approach is open (from the 'approach' event
 *   until the 'takeoff' verdict) the tap control carries data-armed="true" and data-takeoff-at = clock.toClient(t0)
 *   (the device time of the take-off moment in the clock's own units — performance.now() ms in the browser), so
 *   the player sees the zone light up and a test can time its finger; both attributes go at the verdict. t0 is
 *   kept in server ms and translated whenever the control is drawn: both attributes appear together, as soon as
 *   the clock is measured (audit K1 r2 #3). The take-off tap itself is armed by the same two events
 *   (InputController.approach / approachClosed): a finger on the tap zone between approaches — before the first
 *   one, or during the flight after a cleared fence, when the state already names the next fence — sends nothing
 *   and spends nothing (audit K1 r1 #1). A rider who takes control
 *   back — the SDK recovered, resume(), or a fresh join through Reconnect — missed the broadcasts of the time away:
 *   the server's 'approach-sync' (the approach open now, or none) arms or disarms the tap, the lit zone and the hint
 *   the same way, and an attempt whose tap already went out is never armed twice (audit K1 r2 #1). Only what went
 *   out is spent: a press while the session cannot send (dropped, connecting — session.send answers false) sends
 *   nothing, shows no hint and spends nothing, so the first tap after the SDK recovered goes out (audit K1 r3 #1).
 *   The round-side modules (InstantHint, InputController, RemoteInterpolator, RoundClockEstimate) are created
 *   anew at every class-course message, so a new class starts clean (a new round key, an empty buffer: the other
 *   horses are drawn from the new class's samples only, never from the last class's positions).
 * - results: once the class table arrived, [data-list="results"] > [data-class] tables with tr[data-id] rows
 *   (resultsModel), [data-action="again"] (host only; sends start-class) and [data-action="leave"]. Before it —
 *   between the heats ('results') and in the moment before the table lands ('done', also for a late joiner who gets
 *   class-course first) — the heat that just ended as [data-heat-done] + [data-list="heat"] > li[data-id]
 *   (heatResultsModel of the state's riders — the heat's final values, which the room publishes in the patch that
 *   says 'results', audit K1 r2 #2), [data-waiting] with the next step, and [data-action="leave"] (audit K1 r1 #2:
 *   never an empty page). The next step is translate('results.nextHeat') only while the state's nextHeat says the
 *   server will ride another heat; the last heat's results and 'done' read translate('results.classDoneWaiting')
 *   (audit K1 r3 #6).
 * - Lifecycle: document 'visibilitychange' (visible) and window 'pageshow' → session.resume(); window 'resize' →
 *   resize(). destroy() removes the listeners, leaves the session and disposes the scene.
 * - Names (captions, the labels over the horses, the heat screen, the class table) come from the state's
 *   participants, then the heat's rider entries, then the class table's rows (namesFrom): a rider who left the room
 *   for good is no participant any more but keeps her name. The pony's gender is known only for the own rider (the
 *   state carries none), others read as 'yegua'.
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
  /** The code to ring again after the room refused the WebSocket (home shows a retry button while set). */
  let retryCode = '';
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
    return screenFor({ signedIn: me !== null, room: session !== null ? 'joined' : joining ? 'joining' : 'none', phase: state()?.phase ?? null, ended: sessionEnd !== null });
  }

  function names(): HudNames {
    const result = namesFrom(state(), table);
    if (me) result[me.id] = { riderName: me.riderName, ponyName: me.ponyName, ponyGender: me.ponyGender };
    return result;
  }

  function captionText(): string {
    if (round?.caption === null || round?.caption === undefined) return '';
    const who = names()[round.caption.riderId];
    const captionNames = who ?? { riderName: round.caption.riderId, ponyName: round.caption.riderId, ponyGender: 'yegua' as const };
    return captionOf(locale, round.caption.event, { rider: captionNames.riderName, pony: captionNames.ponyName, ponyGender: captionNames.ponyGender });
  }

  /** Hands a message to the session; true when it went out (a line the server never heard changes nothing here). */
  function send(message: ClientRoomMessage): boolean {
    const went = session?.send(message) ?? false;
    if (went && message.type === 'line' && round) {
      round.requestedLine = message.line;
      round.hint.setLine(message.line);
    }
    return went;
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
      walk: null,
      requestedLine: 'center',
    };
  }

  /**
   * The fence the fly-over focuses on at device time `now`: the server's window against the server time of `now` as
   * the clock reads it at this very moment (a refined offset moves the focus too). Fence 1 until the window is known,
   * and until the clock is measured — a late joiner's first moments (audit K1 r2 #3).
   */
  function focusAt(now: number): number {
    const walk = round?.walk ?? null;
    if (!round || !walk) return 1;
    const serverNow = deps.clock.toServer(now);
    if (serverNow === null) return 1;
    return walkFocus(walk.endsAt - walk.startedAt, round.course.fences.length, serverNow - walk.startedAt);
  }

  /** A 'class-phase' walk: the window is the server's, kept in server ms as sent (audit K1 r1 #6, r2 #3). */
  function onWalkPhase(message: Extract<ServerMessage, { type: 'class-phase' }>): void {
    if (!round) return;
    round.walk = { heatIndex: message.heatIndex, startedAt: message.startedAt, endsAt: Math.max(message.startedAt, message.endsAt ?? message.startedAt) };
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
    // A walk of another heat never paces itself by the last heat's window: the state's heat decides which one is on.
    if (round.walk !== null && current.phase === 'walk' && current.heatIndex !== round.walk.heatIndex) round.walk = null;
  }

  function onRoundEvent(event: RoundEventWire): void {
    if (!round || me === null) return;
    const own = event.riderId === me.id;
    switch (event.type) {
      case 'approach':
        if (own) {
          round.hint.approach(event);
          round.controller.approach(event);
          round.armed = { fence: event.fence, attempt: event.attempt, t0: event.t0 };
        }
        break;
      case 'takeoff':
        if (own) {
          round.hint.verdict(event);
          round.controller.approachClosed();
          round.armed = null;
        }
        round.caption = { event: { type: 'takeoff', label: event.outcome.label, fence: event.fence }, riderId: event.riderId };
        break;
      case 'turn-ahead':
        // The window opens now, on the clock every press is timed by: a finger that landed before this moment is no
        // turn, however late its handler runs (audit K1 r5 #2).
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

  /**
   * The server's 'approach-sync' on taking control back (audit K1 r2 #1): the approach open for the own horse right now
   * — or none — arms or disarms the tap, the lit zone and the hint together, as the missed 'approach' event or
   * 'takeoff' verdict would have; never from the state's nextFence. A sync of another class or heat changes nothing.
   */
  function onApproachSync(message: Extract<ServerMessage, { type: 'approach-sync' }>): void {
    if (!round || message.classNumber !== round.classNumber) return;
    const current = state();
    if (current !== null && current.heatIndex !== message.heatIndex) return;
    const approach = message.approach;
    round.controller.sync(`${String(message.classNumber)}#${String(message.heatIndex)}`, approach);
    round.hint.sync({ hardTurn: message.hardTurn, approach });
    round.armed = approach === null ? null : { fence: approach.fence, attempt: approach.attempt, t0: approach.t0 };
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
      // The room refused the WebSocket after the HTTP admission (audit K1 r1 #3): the doorbell flow is over, the
      // failed session is dropped and home shows the error with a retry of the same code — never an endless wait.
      if (session === next) {
        dropSession();
        stopJoining();
        retryCode = code;
        homeStatus = t('lobby.refused.network');
        render();
      }
      return;
    }
    if (session !== next) {
      // A newer session took over while this one was still connecting (the rider left or rang again): this late
      // connection must not linger in the room as a second, silent seat.
      void next.leave();
      return;
    }
    stopJoining();
    retryCode = '';
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
      case 'approach-sync':
        onApproachSync(message);
        updateHud();
        break;
      case 'class-phase':
        if (message.phase === 'walk') {
          onWalkPhase(message);
          updateHud();
        }
        break;
      case 'clock-ping':
      case 'clock-offset':
        // The session fed the ping (or the server's own offset, audit K1 r3 #5) to the clock before handing it on: what
        // is drawn from server times (the walk's focus, the take-off moment) follows the new reading at once (audit K1
        // r2 #3).
        updateHud();
        break;
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
    stopJoining();
    retryCode = '';
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

  /** The doorbell is over (connected, failed, or given up): no more polls, no more 'joining' screen. */
  function stopJoining(): void {
    joining = false;
    flow?.stop();
    flow = null;
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
    // Portrait: the rotate overlay covers the arena and the controls are hidden — a finger on it is nothing, never a
    // tap, a turn or a gear change through an invisible zone (audit K1 r1 #7).
    if (needsRotation(rect.width, rect.height)) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[data-arena]') !== arena) return;
    const pointer = event as PointerEvent;
    const x = pointer.clientX - rect.left;
    const y = pointer.clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;
    const control = hitTest(layout, x, y);
    if (control === null) return;
    // When the finger landed, not when this handler got to run (audit K1 r3 #4): the tap's and the turn's clientTime
    // and the instant hint all read the event's own time; a tap or a turn already too old for the judge when it is
    // handled is not sent, spends nothing and shows no hint (audit K1 r4 #1).
    const handledAt = deps.clock.now();
    const at = pressTime(event.timeStamp, handledAt);
    const sent = round.controller.press(control, at, handledAt);
    if (sent?.type === 'tap') {
      const hint = round.hint.tap(at);
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
      ${retryCode !== '' ? `<button type="button" data-action="retry" class="primary">${escapeHtml(t('lobby.retry'))}</button>` : ''}
      <button type="button" data-action="logout" class="link">${escapeHtml(t('home.logout'))}</button>
    </section>`;
  }

  /** The session is over for good: why, and the way on — a reconnect for a lost connection, home for the rest. */
  function renderEnded(): string {
    if (!sessionEnd) return '';
    const message = translateKey(locale, `lobby.ended.${sessionEnd.kind}`);
    const reconnect = sessionEnd.kind === 'lost' ? `<button type="button" data-action="reconnect" class="primary">${escapeHtml(t('lobby.reconnect'))}</button>` : '';
    return `<section class="screen ended">
      <h1>${escapeHtml(t('lobby.title', { code: roomCode }))}</h1>
      <p data-ended class="ended">${escapeHtml(message)}</p>
      ${reconnect}
      <button type="button" data-action="leave" class="link">${escapeHtml(t('lobby.backHome'))}</button>
      ${localeButtons()}
    </section>`;
  }

  function renderLobby(): string {
    const current = state();
    if (!me) return '';
    if (!current) {
      return `<section class="screen lobby">
        <h1>${escapeHtml(t('lobby.title', { code: roomCode }))}</h1>
        <p class="code" data-code>${escapeHtml(roomCode)}</p>
        <p data-status class="status">${escapeHtml(t('lobby.waiting'))}</p>
        <button type="button" data-action="leave" class="link">${escapeHtml(t('lobby.leave'))}</button>
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
    const focus = focusAt(deps.clock.now());
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
    if (!me) return '';
    if (!table) return renderHeatResults(me.id);
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
      ${localeButtons()}
    </section>`;
  }

  /**
   * Between the heats, and until the class table lands: the heat that just ended (the state still carries its riders)
   * and what comes next — never an empty page (audit K1 r1 #2). The host's "again" waits for the table: the server
   * refuses start-class while the class runs.
   */
  function renderHeatResults(ownId: string): string {
    const current = state();
    const rows = current ? heatResultsModel(current, names(), locale, ownId) : [];
    const heat = rows.length === 0
      ? ''
      : `<h1 data-heat-done>${escapeHtml(t('results.heatDone', { heat: (current?.heatIndex ?? 0) + 1 }))}</h1>
      <ul data-list="heat">${rows
        .map((row) => `<li data-id="${escapeHtml(row.accountId)}" ${row.isOwn ? 'class="own"' : ''}>${escapeHtml(row.name)} · ${escapeHtml(row.faultsText)}${row.statusText ? ` · ${escapeHtml(row.statusText)}` : ''}</li>`)
        .join('')}</ul>`;
    // The server says whether another heat follows (audit K1 r3 #6): its results phase lasts as long after the last
    // heat as between two, and only the schedule knows which heat was the last.
    const waiting = current?.phase === 'results' && current.nextHeat ? t('results.nextHeat') : t('results.classDoneWaiting');
    return `<section class="screen results">
      ${heat}
      <p data-waiting class="status">${escapeHtml(waiting)}</p>
      <button type="button" data-action="leave" class="link">${escapeHtml(t('lobby.leave'))}</button>
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
      : current === 'ended' ? renderEnded()
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
      if (focus && round) focus.textContent = String(focusAt(deps.clock.now()));
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
      const takeoffAt = round?.armed ? deps.clock.toClient(round.armed.t0) : null;
      if (takeoffAt !== null) {
        tap.setAttribute('data-armed', 'true');
        tap.setAttribute('data-takeoff-at', String(takeoffAt));
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
      retryCode = '';
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
        retryCode = '';
        void newFlow().create();
        break;
      case 'retry': {
        const code = retryCode;
        homeStatus = '';
        retryCode = '';
        void newFlow().enter(code);
        render();
        break;
      }
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
      deps.scene.render({ phase: 'walk', riders: [], camera: null, focusFence: focusAt(now) });
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
