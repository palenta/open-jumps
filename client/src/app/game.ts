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
import { InputController, type PressOutcome } from '../input/controller.js';
import { hitTest, layoutFor, needsRotation, type Control, type Layout } from '../input/layout.js';
import { LobbyFlow, type LobbyPhase } from '../lobby/lobbyFlow.js';
import { lobbyModel } from '../lobby/lobbyModel.js';
import type { GameApi } from '../net/api.js';
import type { ClientClock } from '../net/clientClock.js';
import type { RoomSession, SessionEnd } from '../net/roomSession.js';
import type { ClassTableWire, ClientRoomMessage, LobbyStateSnapshot, LobbyView, PublicProfile, RoundEventWire, ServerMessage } from '../net/types.js';
import { InstantHint } from '../round/hint.js';
import { chaseCamera, type CameraPose } from '../scene/camera.js';
import { markerHalfLengths, markerState, type TakeoffMarker } from '../scene/takeoffMarker.js';
import { RemoteInterpolator, RoundClockEstimate } from '../scene/interpolation.js';
import { buildTrack, pointAt, TRACK, type Track, type TrackPoint } from '../scene/track.js';
import { walkMap } from '../walk/walkMap.js';
import { walkFocus, walkModel } from '../walk/walkModel.js';
import { screenFor, type Screen } from './screens.js';

/**
 * How the own horse's visible position was chosen in a frame (K1.1 step 7) — one value, which the camera follows too:
 * - 'patch': the position of the latest state patch (as in K1);
 * - 'forecast': the own approach is open, the clock is measured and the approach has a speed: the position the
 *   server's own run gives at toServer(now) — fence.distanceM − speedMps × (t0 − toServer(now)) / 1000, never past
 *   the take-off point and never behind the latest server position; from t0 on, the take-off point itself;
 * - 'hold': after the own 'takeoff' verdict, the last visible position is held until the first patch that arrives
 *   AFTER that event (the server sends a tick's events before the state of the same tick: a patch from before the
 *   event is stale); then 'patch'. For a fence cleared (perfecta, cero_faltas, batida_corta, batida_larga) the
 *   position never goes back: a fresh patch behind the held position (the horse not there yet) keeps holding until a
 *   patch ahead of it; for rehuse, desvio and caida the fresh patch puts the horse at fence − 2 m as the server
 *   decided — that step back is allowed.
 */
export type OwnHorseMode = 'patch' | 'forecast' | 'hold';

/** What the scene draws in one frame: every horse of the running heat at its point, the camera, the walk focus. */
export interface SceneFrame {
  phase: 'walk' | 'riding' | 'results' | 'idle';
  riders: { id: string; point: TrackPoint; isOwn: boolean; label: string }[];
  camera: CameraPose | null;
  /** The fence the course walk focuses on (1-based), null outside the walk. */
  focusFence: number | null;
  /**
   * The own horse's take-off marker (K1.1 step 7, takeoffMarker.ts): from the own 'approach' (or an 'approach-sync'
   * with an approach) until the own 'takeoff' verdict, null otherwise — before the first approach, after the verdict,
   * on every screen but the round, for a new class, heat or session. The weak marks at the other fences are the
   * arena's own and need nothing here.
   */
  takeoff: TakeoffMarker | null;
  /** How the own horse's position in `riders` (and the camera) was chosen this frame; null when the own horse is not drawn. */
  ownMode: OwnHorseMode | null;
}

/** The 3D arena. Mounted into the arena element; told the course; drawn once per frame; disposed on destroy. */
export interface SceneLike {
  mount(container: HTMLElement): void;
  setCourse(course: CourseSpec | null): void;
  render(frame: SceneFrame): void;
  dispose(): void;
  /** The draw calls of the last frame drawn (renderer.info.render.calls), null without WebGL — for the debug overlay (K1.1 step 9). */
  drawCalls(): number | null;
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
  /** Timers for the lobby polling and the press feedback of the round screen (injectable for tests). */
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
  /**
   * The debug overlay (K1.1 step 9): on only when the page address asks for it — main.ts passes
   * debugRequested(location.search). Default false: nothing of it in the DOM.
   */
  debug?: boolean;
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

/** The press feedback of the round screen (K1.1 step 3): the flash of a touched zone, the note of an ignored touch, the toast. */
const FEEDBACK = { pressedMs: 150, noteMs: 1_200, toastMs: 1_000 } as const;

/** The outcomes of an ignored touch the press note explains; 'not-riding' and 'no-control' say nothing. */
const NOTED_OUTCOMES: ReadonlySet<PressOutcome> = new Set<PressOutcome>(['not-armed', 'already-tapped', 'cannot-send', 'too-old']);

/** The debug overlay (K1.1 step 9): the presses it lists, the largest gap that confirms the local estimate, the FPS span. */
const DEBUG = { rows: 5, acceptMs: 20, fpsSpanMs: 1_000 } as const;

/** One touch of a zone as the debug overlay lists it. */
interface DebugPress {
  zone: Control;
  timeStamp: number;
  source: PressTimeSource;
  reason: PressTimeReason;
  clientTime: number;
  handledAt: number;
  outcome: PressOutcome;
  /** A tap that went out: its class and heat, fence and attempt, the local offset at the press and the judge's word. */
  tap: { key: string; fence: number; attempt: number; localOffset: number | null; judge: 'pending' | 'accepted' | 'unconfirmed' | 'no-tap'; judgeOffset: number | null } | null;
  /** A turn that went out: its class and heat, and the quality of the own verdict ('' until it arrives). */
  turn: { key: string; quality: string } | null;
}

/** Where the moment of a press came from: the event's own timeStamp, or the clock at handling instead of it. */
export type PressTimeSource = 'event' | 'fallback';

/** Why the event's timeStamp was not the moment: null when it was ('event'); otherwise the first rule it broke. */
export type PressTimeReason = null | 'not-finite' | 'non-positive' | 'later-than-now';

/**
 * The moment of a press (K1.1 step 2): `time` as before, and where it came from — source 'event' with reason null
 * when the timeStamp is the moment (however old), else source 'fallback' with the reason, checked in this order:
 * 'not-finite' (NaN, ±Infinity), 'non-positive' (0 or below), 'later-than-now' (after the clock read while handling).
 */
export interface PressTime {
  readonly time: number;
  readonly source: PressTimeSource;
  readonly reason: PressTimeReason;
}

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
 * — and the judge must see when the finger landed, not when the page got round to it. The result names the source
 * of the moment and, for a fallback, the reason (PressTime); the rule that chooses the moment is unchanged by K1.1.
 */
export function pressTime(timeStamp: number, now: number): PressTime {
  const reason: PressTimeReason = !Number.isFinite(timeStamp) ? 'not-finite' : timeStamp <= 0 ? 'non-positive' : timeStamp > now ? 'later-than-now' : null;
  return reason === null ? { time: timeStamp, source: 'event', reason } : { time: now, source: 'fallback', reason };
}

/**
 * Whether the page address asks for the debug overlay (K1.1 step 9): `search` is location.search; true exactly when
 * its query has a parameter named `debug` — "?debug", "?debug=1", "?x=1&debug" — and false for anything else, a
 * parameter that only contains the word ("?debugger", "?nodebug") included.
 */
export function debugRequested(search: string): boolean {
  return new URLSearchParams(search).has('debug');
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
   * is (audit K1 r2 #3). speedMps is its frozen speed (K1.1 step 5; null: without speed), for the take-off marker
   * and the forecast of the own horse (step 7).
   */
  armed: { fence: number; attempt: number; t0: number; speedMps: number | null } | null;
  /**
   * After the own 'takeoff' verdict: the position the own horse is held at until the first patch after the event
   * (K1.1 step 7, OwnHorseMode 'hold'), and whether the fence was cleared (then a fresh patch behind it holds on).
   */
  hold: { positionM: number; cleared: boolean } | null;
  /** The direction button of the own turn that went out, until the own 'turn' verdict (data-chosen). */
  chosen: Control | null;
  /** The schoolmaster assist frozen for this class (the debug overlay's matching: an automatic take-off is not her tap). */
  schoolmaster: boolean;
  /** The own 'autopilot' event's last word (the debug overlay's matching, together with the state's autopilot). */
  autopilot: boolean;
  /** The class and heat (roundKey) of the latest state: a new heat drops the own approach, the hold and the choice. */
  heatKey: string | null;
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
 *   K1.1 step 4 — the map of the route: the walk screen draws svg[data-walk-map] from walkMap(course) (walkMap.ts)
 *   with aria-label = translate('walk.map.label'): the track as a line, one [data-fence-marker="N"] per fence in
 *   course order, one [data-turn-marker="left"|"right"] arrow per turn point in route order, and the start and finish
 *   marks [data-walk-start] / [data-walk-finish] with the texts translate('walk.map.start') / ('walk.map.finish').
 *   The fence of the fly-over's focus (the same walkFocus as [data-focus], at every frame and clock ping) carries
 *   data-focus="true" on its marker — exactly one marker at a time. The legend is [data-list="fences"] as before,
 *   compact beside the map; the number in the [data-focus] element outside the map stays. The 3D fly-over may stay
 *   behind as a background or go — the map must read on its own. No control is shown on the walk (step 3).
 * - round: the layout is layoutFor(rect.width, rect.height) of the MEASURED arena rectangle (deps.measure, by
 *   default getBoundingClientRect(); re-measured by resize() and on the window 'resize' event). The four controls
 *   are drawn as [data-control="turn-left"|"turn-right"|"gear"|"tap"], absolutely positioned INSIDE the arena with
 *   style left/top/width/height in px of the layout's zones (arena-local coordinates; the arena is
 *   position: relative). [data-arena] receives pointerdown: the finger's clientX/clientY minus the rectangle's
 *   left/top is tested with hitTest → InputController.press(control, pressTime(event.timeStamp, now).time, now) with
 *   now = clock.now() at handling; a finger outside the rectangle is ignored. The time of a press is the moment of the
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
 * - round, K1.1 step 3 — what the controls show (every state below is drawn from the controller's own answers:
 *   InputController.turnWindowOpen, the outcome of InputController.press; game.ts never repeats the controller's
 *   branches):
 *   · [data-control="turn-left"] and [data-control="turn-right"] both carry data-window="open" while the own horse's
 *     turn window is open — set when the own 'turn-ahead' is handled, checked at every HUD update and frame against
 *     clock.now() (turnWindowOpen), gone at the window's end, at the own 'turn' verdict and when a turn went out. The
 *     two buttons always look alike: nothing tells the direction of the turn (owner decision 2026-11-03). The button of
 *     a turn that went out carries data-chosen="true" until the own 'turn' verdict; a line shift or a turn the session
 *     could not send chooses nothing. Another rider's turn-ahead lights nothing.
 *   · [data-control="tap"] keeps data-armed="true" and data-takeoff-at (above) — the smoke route times its finger by
 *     them; the styles give the armed zone a bright fill.
 *   · Every touch that hits a zone sets data-pressed on that control for 150 ms (a deps.timers timer; a new touch of
 *     the same control restarts it): "sent" when the press outcome is 'sent', "ignored" for every other outcome. A
 *     finger outside every zone marks nothing.
 *   · [data-press-note] (in the HUD) shows for 1.2 s the reason an ignored touch of the tap zone or of a direction
 *     button did nothing, in the locale: translate('hud.pressNote.<outcome>') for 'not-armed', 'already-tapped',
 *     'cannot-send' and 'too-old'; nothing for 'not-riding' and 'no-control', and nothing for the pace button. A new
 *     note replaces the one shown and restarts the 1.2 s. While nothing is to be said the element is empty or hidden.
 *   · [data-toast] (in the HUD) shows for 1 s what a press that went out changed: translate('hud.toast.gear.<gear>')
 *     after the pace button, translate('hud.toast.line.<line>') after a line shift; a turn, a tap or a press that did
 *     not go out shows none. While nothing is to be said the element is empty or hidden.
 *   · The controls exist on the round screen only: on the walk (and every other screen) none of the four is shown and
 *     a finger is not handled at all — no message, no data-pressed, no note.
 * - round, K1.1 step 7 — the take-off marker and the own horse on the approach (SceneFrame.takeoff / ownMode):
 *   · The marker of the own open approach is computed at every frame: at the take-off point (pointAt(track,
 *     fence.distanceM)); its half-lengths markerHalfLengths(window, speedMps) with window =
 *     round.hint.approachWindow.windowAt(now) — the very window the instant hint judges with (step 6) — and the
 *     speedMps of the 'approach' / 'approach-sync' (frozen: a later gear change changes cleanMs, never the speed);
 *     its state markerState(clock.toServer(now), t0, window, speedMps). The gear of that window (K1.1 code audit r1,
 *     finding 1): the state patches' gear, and every pace press that went out from its moment on — until a patch
 *     confirms it, the narrower window of the gear before it and the gear asked for, so the band and the hint never
 *     promise more than the judge, who takes the change at its receipt, may use; a stale patch neither undoes nor
 *     flickers it; the schoolmaster, the own autopilot and a wide turn (until the fence is cleared) keep the canter
 *     collected whatever was pressed (ApproachWindow). It goes at the own 'takeoff' verdict (no
 *     bright marker after it), with an 'approach-sync' without an approach, at a new class, heat or session; another
 *     rider's approach changes nothing. The arena frees the marker's resources with the course.
 *   · The own horse's visible position — one value, the camera follows it — is chosen by OwnHorseMode: 'forecast'
 *     while the own approach is open with a speed and a measured clock; 'hold' from the own 'takeoff' verdict until
 *     the first patch after it (with the cleared / not-cleared rules of OwnHorseMode); 'patch' otherwise. A new
 *     approach (the next attempt, the next fence) or an 'approach-sync' with one → 'forecast' with its t0 and speed;
 *     an 'approach-sync' without one → 'patch' (any hold is dropped); a new heat or class, the end of the ride, the
 *     clock lost or re-measured without a t0 → 'patch'. The other horses are drawn as in K1.
 * - results: once the class table arrived, [data-list="results"] > [data-class] tables with tr[data-id] rows
 *   (resultsModel), [data-action="again"] (host only; sends start-class) and [data-action="leave"]. Before it —
 *   between the heats ('results') and in the moment before the table lands ('done', also for a late joiner who gets
 *   class-course first) — the heat that just ended as [data-heat-done] + [data-list="heat"] > li[data-id]
 *   (heatResultsModel of the state's riders — the heat's final values, which the room publishes in the patch that
 *   says 'results', audit K1 r2 #2), [data-waiting] with the next step, and [data-action="leave"] (audit K1 r1 #2:
 *   never an empty page). The next step is translate('results.nextHeat') only while the state's nextHeat says the
 *   server will ride another heat; the last heat's results and 'done' read translate('results.classDoneWaiting')
 *   (audit K1 r3 #6).
 * - debug, K1.1 step 9 — only with deps.debug (main.ts: debugRequested(location.search)); otherwise no [data-debug]
 *   anywhere. An overlay [data-debug] in the root above the game, on every screen (no account or PIN needed: it is
 *   there from the sign-in on), kept across re-renders like the arena. It sends nothing to the server.
 *   · [data-debug-press] rows: the five latest touches that hit a zone, the newest first (a sixth drops the oldest),
 *     whatever the screen of the round, the class or the heat they came in. Each row carries: data-zone (the control),
 *     data-time-stamp (the event's own timeStamp as received, String()), data-source and data-reason (pressTime; the
 *     reason '' when null), data-client-time (pressTime().time), data-handled-at (clock.now() at handling),
 *     data-outcome (the controller's outcome).
 *   · A tap that went out also carries data-local-offset — clientTime − clock.toClient(t0) of its approach, kept at
 *     the press — and data-judge, matched with the own horse's 'takeoff' (riderId = own) of the current class and
 *     heat, the same fence and attempt: 'pending' until it arrives; 'accepted' when its offsetMs is within 20 ms of
 *     the local estimate (|offsetMs − local| ≤ 20) and the own horse has neither schoolmaster (the round's frozen
 *     assists) nor the autopilot (the state's autopilot, or the own 'autopilot' event) at the verdict; 'unconfirmed'
 *     otherwise; 'no-tap' when its offsetMs is null. data-judge-offset is the judge's offsetMs ('' while pending or
 *     for 'no-tap'). Another rider's 'takeoff' — also of the same fence and attempt — is never matched; a new class
 *     or heat clears the matching: a tap of the old one is never matched to a verdict of the new (its row stays,
 *     'pending').
 *   · A turn that went out carries data-turn-quality: outcome.quality of the own 'turn' verdict ('' until it arrives).
 *   · [data-debug-stats] below the rows: data-fps — the frames per second over the last second of frame(now) calls
 *     (the count of frames in (now − 1000, now]) — and data-calls, scene.drawCalls() ('' when null).
 *   · What the owner reads on the phone is the panel's TEXT (English, not localized: a developer tool), not its
 *     attributes: every row reads its data-zone and its data-outcome word ("tap", "sent"); a tap that went out also
 *     reads "local <n> ms" and its data-judge word ("pending", "accepted", "unconfirmed", "no-tap"), and once the
 *     judge's offset is known "judge <n> ms" — <n> the offset rounded to a whole millisecond (Math.round; the
 *     attributes keep the unrounded values); a turn reads its data-turn-quality word once known. [data-debug-stats]
 *     reads "FPS <data-fps>" and "draw calls <data-calls>" ("draw calls n/a" when drawCalls() is null). The panel is
 *     visible (no hidden attribute, never display none) and takes no touch (pointer-events: none): a finger on a
 *     control under it reaches the arena as it would without the panel.
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

  // The press feedback (K1.1 step 3): the flash timers per control, the note and the toast with their timers.
  const pressedTimers = new Map<Control, unknown>();
  let note: { key: string; timer: unknown } | null = null;
  let toast: { key: string; timer: unknown } | null = null;

  // The debug overlay (K1.1 step 9) lives once, like the arena: every render puts it back on top of the screen.
  const debugPanel = deps.debug === true ? doc.createElement('div') : null;
  const debugList = doc.createElement('ol');
  const debugStats = doc.createElement('div');
  let debugPresses: DebugPress[] = [];
  const frameTimes: number[] = [];
  if (debugPanel) {
    debugPanel.dataset.debug = '';
    debugPanel.className = 'debug';
    debugPanel.style.pointerEvents = 'none';
    debugList.className = 'debug-presses';
    debugStats.dataset.debugStats = '';
    debugStats.dataset.fps = '0';
    debugStats.dataset.calls = '';
    debugStats.textContent = 'FPS 0 · draw calls n/a';
    debugPanel.append(debugList, debugStats);
  }

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

  /**
   * Hands a message to the session; true when it went out (a line or a gear the server never heard changes nothing
   * here). A gear that went out reaches the shared window at once, dated now (K1.1 code audit r1, finding 1).
   */
  function send(message: ClientRoomMessage): boolean {
    const went = session?.send(message) ?? false;
    if (went && message.type === 'line' && round) {
      round.requestedLine = message.line;
      round.hint.setLine(message.line);
    }
    if (went && message.type === 'gear' && round) round.hint.requestGear(message.gear, deps.clock.now());
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
      hold: null,
      chosen: null,
      schoolmaster: assists.schoolmaster,
      autopilot: false,
      heatKey: null,
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
    // A new heat starts without the last heat's approach, hold or chosen turn (the controller drops its own approach too).
    const key = roundKey();
    if (round.heatKey !== null && round.heatKey !== key) {
      round.armed = null;
      round.hold = null;
      round.chosen = null;
      round.autopilot = false;
    }
    round.heatKey = key;
    // The first patch after the own verdict ends the hold — for a cleared fence only once it is not behind the held
    // position (the horse never goes back); for a refusal, a run-out or a fall its fence − 2 m is the server's step
    // back. A rider no longer riding is drawn from the patch.
    const hold = round.hold;
    if (hold !== null && (own === undefined || own.status !== 'riding' || !hold.cleared || own.positionM >= hold.positionM)) round.hold = null;
    round.controller.update({
      riding: current.phase === 'riding' && own !== undefined && own.status === 'riding',
      round: roundKey(),
      nextFence: own?.nextFence ?? 1,
      attempt: own?.attempt ?? 1,
    });
    if (own) {
      round.hint.setAutopilot(own.autopilot);
      round.hint.setGear(own.gear);
    }
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
          round.armed = { fence: event.fence, attempt: event.attempt, t0: event.t0, speedMps: event.speedMps };
          round.hold = null;
        }
        break;
      case 'takeoff':
        if (own) {
          // The position drawn up to the verdict is held until a patch from after it: the server sends a tick's
          // events before the state of the same tick, so the patch at hand is stale.
          const visible = ownPosition(deps.clock.now());
          round.hint.verdict(event);
          round.controller.approachClosed();
          round.armed = null;
          round.hold = visible === null ? null : { positionM: visible.positionM, cleared: event.outcome.cleared };
          judgeDebugTap(event);
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
          if (event.outcome.quality === 'wide') round.hint.wideTurn();
          round.chosen = null;
          qualifyDebugTurn(event.outcome.quality);
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
        if (own) {
          round.autopilot = event.on;
          round.hint.setAutopilot(event.on);
        }
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
    round.armed = approach === null ? null : { fence: approach.fence, attempt: approach.attempt, t0: approach.t0, speedMps: approach.speedMps };
    // Taking control back: the approach open now is forecast afresh, and no hold survives a sync without one.
    round.hold = null;
  }

  // ---- the own horse and its take-off marker (K1.1 step 7) ---------------------------------------------------

  /**
   * The own horse's visible position at device time `now` and how it was chosen (OwnHorseMode); null when the own
   * horse is not in the state. The forecast is the server's own run of the open approach: fence − speedMps ×
   * (t0 − toServer(now)), at the take-off point from t0 on, and never behind the latest patch.
   */
  function ownPosition(now: number): { positionM: number; mode: OwnHorseMode } | null {
    const current = state();
    if (!round || me === null || current === null) return null;
    const own = current.riders[me.id];
    if (own === undefined) return null;
    if (round.hold !== null) return { positionM: round.hold.positionM, mode: 'hold' };
    const armed = round.armed;
    const serverNow = deps.clock.toServer(now);
    const fence = armed === null ? undefined : round.course.fences.find((f) => f.number === armed.fence);
    if (armed !== null && armed.speedMps !== null && serverNow !== null && fence !== undefined && own.status === 'riding') {
      const forecast = serverNow >= armed.t0 ? fence.distanceM : fence.distanceM - (armed.speedMps * (armed.t0 - serverNow)) / 1000;
      return { positionM: Math.max(Math.min(forecast, fence.distanceM), own.positionM), mode: 'forecast' };
    }
    return { positionM: own.positionM, mode: 'patch' };
  }

  /**
   * The own open approach's take-off marker at device time `now`: at the fence's take-off point, its band from the
   * very window the instant hint judges with (round.hint.approachWindow) at the frozen speed, its state by the
   * server's time of `now` against t0. Null without an own open approach.
   */
  function takeoffMarker(now: number): TakeoffMarker | null {
    const armed = round?.armed ?? null;
    if (!round || armed === null) return null;
    const fence = round.course.fences.find((f) => f.number === armed.fence);
    if (fence === undefined) return null;
    const window = round.hint.approachWindow.windowAt(now);
    const halves = markerHalfLengths(window, armed.speedMps);
    return {
      fence: fence.number,
      distanceM: fence.distanceM,
      state: markerState(deps.clock.toServer(now), armed.t0, window, armed.speedMps),
      cleanHalfM: halves?.cleanHalfM ?? null,
      perfectHalfM: halves?.perfectHalfM ?? null,
    };
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
      // The controls belong to the round screen alone: the walk (K1.1 step 3) shows the arena without them.
      if (!zone || portrait || renderedScreen !== 'round') {
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
    const moment = pressTime(event.timeStamp, handledAt);
    const at = moment.time;
    const armedT0 = round.armed?.t0 ?? null;
    const { message: sent, outcome } = round.controller.press(control, at, handledAt);
    if (sent?.type === 'tap') {
      const hint = round.hint.tap(at);
      if (hint) round.caption = { event: { type: 'takeoff', label: hint.outcome.label, fence: hint.fence }, riderId: me?.id ?? '' };
    }
    // What the touch shows is drawn from the controller's own answer (K1.1 step 3), never from a second set of rules.
    flash(control, outcome === 'sent' ? 'sent' : 'ignored');
    if (control !== 'gear' && NOTED_OUTCOMES.has(outcome)) note = showFor(note, `hud.pressNote.${outcome}`, FEEDBACK.noteMs, () => (note = null));
    if (sent?.type === 'gear') toast = showFor(toast, `hud.toast.gear.${sent.gear}`, FEEDBACK.toastMs, () => (toast = null));
    if (sent?.type === 'line') toast = showFor(toast, `hud.toast.line.${sent.line}`, FEEDBACK.toastMs, () => (toast = null));
    if (sent?.type === 'turn') round.chosen = control;
    if (debugPanel) {
      const key = roundKey();
      const t0AtDevice = armedT0 === null ? null : deps.clock.toClient(armedT0);
      recordDebugPress({
        zone: control,
        timeStamp: event.timeStamp,
        source: moment.source,
        reason: moment.reason,
        clientTime: at,
        handledAt,
        outcome,
        tap: sent?.type === 'tap' ? { key, fence: sent.fence, attempt: sent.attempt, localOffset: t0AtDevice === null ? null : at - t0AtDevice, judge: 'pending', judgeOffset: null } : null,
        turn: sent?.type === 'turn' ? { key, quality: '' } : null,
      });
    }
    updateHud();
  }

  // ---- the press feedback (K1.1 step 3) ----------------------------------------------------------------------

  /** A touched zone flashes for FEEDBACK.pressedMs: 'sent' or 'ignored'; a new touch of the same control restarts it. */
  function flash(control: Control, kind: 'sent' | 'ignored'): void {
    const element = controlElements.get(control);
    if (!element) return;
    const running = pressedTimers.get(control);
    if (running !== undefined) timers.clearTimeout(running);
    element.setAttribute('data-pressed', kind);
    pressedTimers.set(
      control,
      timers.setTimeout(() => {
        pressedTimers.delete(control);
        element.removeAttribute('data-pressed');
      }, FEEDBACK.pressedMs),
    );
  }

  /** A message of the HUD (a note or a toast) shown for `ms`: it replaces the one shown and restarts the time. */
  function showFor(shown: { key: string; timer: unknown } | null, key: string, ms: number, expire: () => void): { key: string; timer: unknown } {
    if (shown !== null) timers.clearTimeout(shown.timer);
    const timer = timers.setTimeout(() => {
      expire();
      updateHud();
    }, ms);
    return { key, timer };
  }

  // ---- the debug overlay (K1.1 step 9) -----------------------------------------------------------------------

  function recordDebugPress(press: DebugPress): void {
    debugPresses = [press, ...debugPresses].slice(0, DEBUG.rows);
    renderDebugRows();
  }

  /**
   * The own 'takeoff' verdict against the tap rows of the current class and heat with its fence and attempt: 'no-tap'
   * when the judge saw none; 'accepted' when its offset is within DEBUG.acceptMs of the local estimate and neither the
   * schoolmaster nor the autopilot rode the horse; 'unconfirmed' otherwise.
   */
  function judgeDebugTap(event: Extract<RoundEventWire, { type: 'takeoff' }>): void {
    if (!debugPanel || !round || me === null) return;
    const key = roundKey();
    const automatic = round.schoolmaster || round.autopilot || state()?.riders[me.id]?.autopilot === true;
    for (const press of debugPresses) {
      const tap = press.tap;
      if (tap === null || tap.judge !== 'pending' || tap.key !== key || tap.fence !== event.fence || tap.attempt !== event.attempt) continue;
      tap.judgeOffset = event.offsetMs;
      if (event.offsetMs === null) tap.judge = 'no-tap';
      else tap.judge = !automatic && tap.localOffset !== null && Math.abs(event.offsetMs - tap.localOffset) <= DEBUG.acceptMs ? 'accepted' : 'unconfirmed';
    }
    renderDebugRows();
  }

  /** The own 'turn' verdict names the quality of the latest turn that went out in this class and heat. */
  function qualifyDebugTurn(quality: string): void {
    if (!debugPanel) return;
    const key = roundKey();
    const pending = debugPresses.find((press) => press.turn !== null && press.turn.key === key && press.turn.quality === '');
    if (pending?.turn) pending.turn.quality = quality;
    renderDebugRows();
  }

  /** The rows as data attributes and as the English text the owner reads on the phone (offsets in whole ms). */
  function renderDebugRows(): void {
    if (!debugPanel) return;
    const rows = debugPresses.map((press) => {
      const row = doc.createElement('li');
      row.setAttribute('data-debug-press', '');
      row.setAttribute('data-zone', press.zone);
      row.setAttribute('data-time-stamp', String(press.timeStamp));
      row.setAttribute('data-source', press.source);
      row.setAttribute('data-reason', press.reason ?? '');
      row.setAttribute('data-client-time', String(press.clientTime));
      row.setAttribute('data-handled-at', String(press.handledAt));
      row.setAttribute('data-outcome', press.outcome);
      const words: string[] = [press.zone, press.outcome];
      if (press.source === 'fallback') words.push(`fallback ${press.reason ?? ''}`);
      words.push(`delay ${String(Math.round(press.handledAt - press.clientTime))} ms`);
      const tap = press.tap;
      if (tap !== null) {
        row.setAttribute('data-local-offset', tap.localOffset === null ? '' : String(tap.localOffset));
        row.setAttribute('data-judge', tap.judge);
        row.setAttribute('data-judge-offset', tap.judgeOffset === null ? '' : String(tap.judgeOffset));
        if (tap.localOffset !== null) words.push(`local ${String(Math.round(tap.localOffset))} ms`);
        if (tap.judgeOffset !== null) words.push(`judge ${String(Math.round(tap.judgeOffset))} ms`);
        words.push(tap.judge);
      }
      if (press.turn !== null) {
        row.setAttribute('data-turn-quality', press.turn.quality);
        if (press.turn.quality !== '') words.push(press.turn.quality);
      }
      row.textContent = words.join(' · ');
      return row;
    });
    debugList.replaceChildren(...rows);
  }

  /** The line under the rows: the frames of the last second up to `now` and the draw calls of the frame just drawn. */
  function renderDebugStats(now: number): void {
    if (!debugPanel) return;
    frameTimes.push(now);
    while (frameTimes.length > 0 && (frameTimes[0] ?? now) <= now - DEBUG.fpsSpanMs) frameTimes.shift();
    const calls = deps.scene.drawCalls();
    debugStats.dataset.fps = String(frameTimes.length);
    debugStats.dataset.calls = calls === null ? '' : String(calls);
    debugStats.textContent = `FPS ${String(frameTimes.length)} · draw calls ${calls === null ? 'n/a' : String(calls)}`;
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
      <div class="arena-slot"></div>
      <div class="walk-panel">
        <h1>${escapeHtml(walk.title)}</h1>
        <p>${escapeHtml(walk.timeText)}</p>
        <ol data-list="fences">${walk.fences.map((fence) => `<li>${escapeHtml(fence.text)} <small>${escapeHtml(fence.detail)}</small></li>`).join('')}</ol>
        <p class="focus"><span data-focus>${String(focus)}</span></p>
        ${localeButtons()}
      </div>
      <div class="walk-map-panel">${renderWalkMap(round, focus)}</div>
    </section>`;
  }

  /**
   * The map of the route (K1.1 step 4): walkMap(course) as an SVG — the track, a bar across it with its number at
   * every fence (the focused one marked), an arrow along the way out of every turn, the start and the finish.
   */
  function renderWalkMap(current: RoundModules, focus: number): string {
    const map = walkMap(current.course);
    const { width, height } = map.box;
    const f = (value: number): string => value.toFixed(1);
    const route = map.path.map((p) => `${f(p.x)},${f(p.y)}`).join(' ');
    const fences = map.fences
      .map((fence) => {
        // The bar lies across the track; the number sits beside it, on the bar's line.
        const across = { x: -Math.sin(fence.heading), y: Math.cos(fence.heading) };
        const bar = 9;
        const label = { x: fence.at.x + across.x * 18, y: fence.at.y + across.y * 18 };
        return `<g class="walk-fence" data-fence-marker="${String(fence.number)}"${fence.number === focus ? ' data-focus="true"' : ''}>
          <line x1="${f(fence.at.x - across.x * bar)}" y1="${f(fence.at.y - across.y * bar)}" x2="${f(fence.at.x + across.x * bar)}" y2="${f(fence.at.y + across.y * bar)}" />
          <text x="${f(label.x)}" y="${f(label.y)}">${String(fence.number)}</text>
        </g>`;
      })
      .join('');
    const turns = map.turns
      .map((turn) => {
        // The arrowhead points the way the horse leaves the turn: the heading where the turn's arc ends.
        const out = pointAt(current.track, turn.distanceM + (TRACK.turnRadiusM * TRACK.turnAngleRad) / 2).heading;
        const tip = { x: turn.at.x + Math.cos(out) * 10, y: turn.at.y + Math.sin(out) * 10 };
        const side = { x: -Math.sin(out) * 7, y: Math.cos(out) * 7 };
        const back = { x: turn.at.x - Math.cos(out) * 4, y: turn.at.y - Math.sin(out) * 4 };
        return `<polygon class="walk-turn" data-turn-marker="${turn.direction}" points="${f(tip.x)},${f(tip.y)} ${f(back.x + side.x)},${f(back.y + side.y)} ${f(back.x - side.x)},${f(back.y - side.y)}" />`;
      })
      .join('');
    const end = (point: { x: number; y: number }, kind: 'start' | 'finish'): string =>
      `<g class="walk-${kind}" data-walk-${kind}><circle cx="${f(point.x)}" cy="${f(point.y)}" r="5" /><text x="${f(point.x)}" y="${f(point.y - 9)}">${escapeHtml(t(kind === 'start' ? 'walk.map.start' : 'walk.map.finish'))}</text></g>`;
    return `<svg data-walk-map class="walk-map" viewBox="0 0 ${String(width)} ${String(height)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(t('walk.map.label'))}">
      <polyline class="walk-route" points="${route}" />
      ${turns}${fences}${end(map.start, 'start')}${end(map.finish, 'finish')}
    </svg>`;
  }

  function renderRound(): string {
    return `<section class="screen round">
      <div class="arena-slot"></div>
      <div class="hud">
        <div class="hud-top"><span data-hud-fence></span><span data-hud-faults></span><span data-hud-time></span></div>
        <div class="hud-bottom"><span data-hud-gear></span><span data-hud-caption></span><span data-hud-phase></span></div>
        <div data-press-note class="press-note" hidden></div>
        <div data-toast class="toast" hidden></div>
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
    if (debugPanel) root.appendChild(debugPanel);
    updateHud();
  }

  function updateHud(): void {
    if (destroyed) return;
    const current = state();
    if (renderedScreen === 'walk') {
      if (!round) return;
      const focused = focusAt(deps.clock.now());
      const focus = root.querySelector('[data-focus]:not([data-fence-marker])');
      if (focus) focus.textContent = String(focused);
      // Exactly one marker of the map carries the fly-over's focus.
      for (const marker of root.querySelectorAll('[data-walk-map] [data-fence-marker]')) {
        if (marker.getAttribute('data-fence-marker') === String(focused)) marker.setAttribute('data-focus', 'true');
        else marker.removeAttribute('data-focus');
      }
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
    // The own turn window lights both direction buttons alike (no hint of the way); the button of a turn that went
    // out stays chosen until the verdict (K1.1 step 3). Both read the controller, never a copy of its window.
    const windowOpen = round?.controller.turnWindowOpen(deps.clock.now()) ?? false;
    for (const control of ['turn-left', 'turn-right'] as const) {
      const element = controlElements.get(control);
      if (!element) continue;
      if (windowOpen) element.setAttribute('data-window', 'open');
      else element.removeAttribute('data-window');
      if (round?.chosen === control) element.setAttribute('data-chosen', 'true');
      else element.removeAttribute('data-chosen');
    }
    const message = (selector: string, key: string | null): void => {
      const element = root.querySelector(selector);
      if (!element) return;
      element.textContent = key === null ? '' : translateKey(locale, key);
      if (key === null) element.setAttribute('hidden', '');
      else element.removeAttribute('hidden');
    };
    message('[data-press-note]', note?.key ?? null);
    message('[data-toast]', toast?.key ?? null);
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
    drawFrame(now);
    renderDebugStats(now);
  }

  function drawFrame(now: number): void {
    const current = state();
    const currentScreen = screen();
    if (currentScreen === 'walk' && round) {
      updateHud();
      deps.scene.render({ phase: 'walk', riders: [], camera: null, focusFence: focusAt(now), takeoff: null, ownMode: null });
      return;
    }
    if (currentScreen === 'round' && round && current && me) {
      updateHud();
      const renderTime = round.roundClock.estimate(now) ?? current.roundClockMs;
      // One visible position of the own horse (K1.1 step 7): the camera follows the very point drawn.
      const own = ownPosition(now);
      const riders: SceneFrame['riders'] = [];
      let ownPoint: TrackPoint | null = null;
      for (const [id, rider] of Object.entries(current.riders)) {
        const isOwn = id === me.id;
        const position = isOwn ? (own?.positionM ?? rider.positionM) : (round.interpolator.positionAt(id, renderTime) ?? rider.positionM);
        const point = pointAt(round.track, position);
        if (isOwn) ownPoint = point;
        riders.push({ id, point, isOwn, label: riderOnPony(locale, names(), id) });
      }
      const camera = ownPoint ?? riders[0]?.point ?? null;
      deps.scene.render({
        phase: 'riding',
        riders,
        camera: camera ? chaseCamera(camera) : null,
        focusFence: null,
        takeoff: takeoffMarker(now),
        ownMode: ownPoint !== null ? (own?.mode ?? 'patch') : null,
      });
      return;
    }
    deps.scene.render({ phase: currentScreen === 'results' ? 'results' : 'idle', riders: [], camera: null, focusFence: null, takeoff: null, ownMode: null });
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
    for (const timer of pressedTimers.values()) timers.clearTimeout(timer);
    pressedTimers.clear();
    if (note) timers.clearTimeout(note.timer);
    if (toast) timers.clearTimeout(toast.timer);
    note = null;
    toast = null;
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
