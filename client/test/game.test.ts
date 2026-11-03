// @vitest-environment happy-dom
// The application in a DOM (plan 2.2; the 1.7 cycle sign-in → home → lobby → course walk → round → results →
// again; 1.12 touch layout; 1.13 HUD; 2.3 instant hint and reconnection): createGame composed with fakes —
// happy-dom for the document, a scripted API, a scripted room session, a recording scene, a settable clock and
// window — and pinned through the DOM contract in game.ts (data attributes, pointerdown on the arena, the
// lifecycle events, the round modules re-created per class-course).
import { caption as captionOf, clubCourse, isMessageKey, PACKET, translateKey, type ApproachState, type CourseSpec, type Locale, type TakeoffOutcome } from '@open-jumps/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGame,
  debugRequested,
  pressTime,
  type ApiLike,
  type ArenaRect,
  type ClockLike,
  type Game,
  type SceneFrame,
  type SceneLike,
  type SessionLike,
  type WindowLike,
} from '../src/app/game.js';
import { hitTest, layoutFor, type Control, type Layout } from '../src/input/layout.js';
import { chaseCamera } from '../src/scene/camera.js';
import { buildTrack, pointAt } from '../src/scene/track.js';
import type { ApiResult, CreateRoomReply } from '../src/net/api.js';
import { ClientClock } from '../src/net/clientClock.js';
import type { SessionEnd, SessionStatus } from '../src/net/roomSession.js';
import type {
  ClassTableWire,
  ClientRoomMessage,
  JoinDecision,
  LobbyPerson,
  LobbyStateSnapshot,
  LobbyView,
  ParticipantView,
  PublicProfile,
  RegisterInput,
  RiderView,
  RoomStatusReply,
  RoundEventWire,
  ServerMessage,
} from '../src/net/types.js';

// ---- the scripted API --------------------------------------------------------------------------------------

interface Script {
  register?: ApiResult<PublicProfile>[];
  login?: ApiResult<PublicProfile>[];
  me?: ApiResult<PublicProfile>[];
  logout?: ApiResult<void>[];
  createRoom?: ApiResult<CreateRoomReply>[];
  knock?: ApiResult<JoinDecision>[];
  roomStatus?: ApiResult<RoomStatusReply>[];
  lobby?: ApiResult<LobbyView>[];
  door?: ApiResult<void>[];
  setEntry?: ApiResult<void>[];
  setAutoAdmit?: ApiResult<void>[];
}

type ApiMethod = keyof Script;

interface ApiCall {
  method: ApiMethod;
  args: unknown[];
}

interface FakeApi {
  api: ApiLike;
  /** Every call in order with its arguments. */
  calls: ApiCall[];
  /** The argument lists of every call of one method, in order. */
  callsOf(method: ApiMethod): unknown[][];
}

/** An API answering from scripted queues (one reply per call, in order) and recording every call; an unscripted call throws. */
function fakeApi(script: Script): FakeApi {
  const calls: ApiCall[] = [];
  const queues = {
    register: [...(script.register ?? [])],
    login: [...(script.login ?? [])],
    me: [...(script.me ?? [])],
    logout: [...(script.logout ?? [])],
    createRoom: [...(script.createRoom ?? [])],
    knock: [...(script.knock ?? [])],
    roomStatus: [...(script.roomStatus ?? [])],
    lobby: [...(script.lobby ?? [])],
    door: [...(script.door ?? [])],
    setEntry: [...(script.setEntry ?? [])],
    setAutoAdmit: [...(script.setAutoAdmit ?? [])],
  };
  const next = <T>(queue: T[], method: ApiMethod, args: unknown[]): Promise<T> => {
    calls.push({ method, args });
    const reply = queue.shift();
    if (reply === undefined) throw new Error(`unscripted api call: ${method}(${JSON.stringify(args)})`);
    return Promise.resolve(reply);
  };
  const api: ApiLike = {
    register: (input) => next(queues.register, 'register', [input]),
    login: (riderName, pin) => next(queues.login, 'login', [riderName, pin]),
    me: () => next(queues.me, 'me', []),
    logout: () => next(queues.logout, 'logout', []),
    createRoom: (autoAdmitClub) => next(queues.createRoom, 'createRoom', autoAdmitClub === undefined ? [] : [autoAdmitClub]),
    knock: (code) => next(queues.knock, 'knock', [code]),
    roomStatus: (code) => next(queues.roomStatus, 'roomStatus', [code]),
    lobby: (code) => next(queues.lobby, 'lobby', [code]),
    door: (code, action, accountId) => next(queues.door, 'door', [code, action, accountId]),
    setEntry: (code, open) => next(queues.setEntry, 'setEntry', [code, open]),
    setAutoAdmit: (code, on) => next(queues.setAutoAdmit, 'setAutoAdmit', [code, on]),
  };
  return { api, calls, callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.args) };
}

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const failed = <T>(status: number, error: string): ApiResult<T> => ({ ok: false, status, error });
/** A 204 answer. */
const done: ApiResult<void> = { ok: true, value: undefined };

// ---- the scripted room session ----------------------------------------------------------------------------

/** How the next session's connect() behaves: resolves with the state, rejects (the room refused the WebSocket), or waits for release(). */
type ConnectMode = 'ok' | 'fail' | 'hold';

/** A room session driven by the test: connect() installs the first full state; the test emits later states, messages and status changes. */
class FakeSession implements SessionLike {
  status: SessionStatus = 'idle';
  state: LobbyStateSnapshot | null = null;
  end: SessionEnd | null = null;
  reconnectionToken: string | null = null;
  /** Every connect(roomId, code), in order. */
  readonly connects: [string, string][] = [];
  /** Every message sent through the session, in order. */
  readonly sent: ClientRoomMessage[] = [];
  resumes = 0;
  leaves = 0;
  /** What resume() answers (true: connected afterwards). */
  resumeAnswer = true;
  private courseValue: CourseSpec | null = null;
  private readonly stateListeners = new Set<(state: LobbyStateSnapshot) => void>();
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly statusListeners = new Set<(status: SessionStatus) => void>();
  /** A held connect(), settled by release(). */
  private held: { resolve: () => void; reject: (error: unknown) => void } | null = null;

  constructor(
    private readonly stateOnConnect: LobbyStateSnapshot,
    private readonly connectMode: ConnectMode = 'ok',
  ) {}

  connect(roomId: string, code: string): Promise<void> {
    this.connects.push([roomId, code]);
    if (this.connectMode === 'fail') {
      this.status = 'idle';
      return Promise.reject(new Error('the room refused the WebSocket'));
    }
    if (this.connectMode === 'hold') {
      return new Promise<void>((resolve, reject) => {
        this.held = {
          resolve: () => {
            this.installState();
            resolve();
          },
          reject,
        };
      });
    }
    this.installState();
    return Promise.resolve();
  }

  /** Settles a held connect(): connected with the state, or rejected with `error`. */
  release(error?: unknown): void {
    const held = this.held;
    if (held === null) throw new Error('no connect() is held');
    this.held = null;
    if (error === undefined) held.resolve();
    else held.reject(error);
  }

  private installState(): void {
    this.reconnectionToken = `token-${String(this.connects.length)}`;
    this.state = this.stateOnConnect;
    this.emitStatus('connected');
    this.emitState(this.stateOnConnect);
  }

  resume(): Promise<boolean> {
    this.resumes += 1;
    if (this.resumeAnswer) {
      if (this.status !== 'connected') this.emitStatus('connected');
    } else {
      this.end = { kind: 'lost', code: 1006 };
      this.emitStatus('ended');
    }
    return Promise.resolve(this.resumeAnswer);
  }

  leave(): Promise<void> {
    this.leaves += 1;
    this.end = { kind: 'left', code: 1000 };
    this.emitStatus('ended');
    return Promise.resolve();
  }

  /** As the real session: handed out (recorded) only while connected; false otherwise, nothing recorded. */
  send(message: ClientRoomMessage): boolean {
    if (this.status !== 'connected') return false;
    this.sent.push(message);
    return true;
  }

  course(): CourseSpec | null {
    return this.courseValue;
  }

  onState(listener: (state: LobbyStateSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: (status: SessionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** A state patch arrived. */
  emitState(state: LobbyStateSnapshot): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }

  /** A server message arrived ('class-course' is remembered as course(), as the real session does). */
  emitMessage(message: ServerMessage): void {
    if (message.type === 'class-course') this.courseValue = message.course;
    for (const listener of [...this.messageListeners]) listener(message);
  }

  emitStatus(status: SessionStatus): void {
    this.status = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  /** The session is over for good with this end. */
  endWith(end: SessionEnd): void {
    this.end = end;
    this.emitStatus('ended');
  }

  /** The messages of one type, in order. */
  sentOf<T extends ClientRoomMessage['type']>(type: T): Extract<ClientRoomMessage, { type: T }>[] {
    return this.sent.filter((message): message is Extract<ClientRoomMessage, { type: T }> => message.type === type);
  }
}

// ---- the recording scene, the window, the clock, the timers -------------------------------------------------

class FakeScene implements SceneLike {
  mounted: HTMLElement | null = null;
  readonly courses: (CourseSpec | null)[] = [];
  readonly frames: SceneFrame[] = [];
  disposed = 0;

  mount(container: HTMLElement): void {
    this.mounted = container;
  }

  setCourse(course: CourseSpec | null): void {
    this.courses.push(course);
  }

  render(frame: SceneFrame): void {
    this.frames.push(frame);
  }

  dispose(): void {
    this.disposed += 1;
  }

  /** What drawCalls() answers (the debug overlay's line of K1.1 step 9). */
  calls: number | null = null;

  drawCalls(): number | null {
    return this.calls;
  }
}

/** The window as the game listens to it: listeners the test can fire (sizes come from the measured arena). */
class FakeWindow implements WindowLike {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  /** Event types passed to removeEventListener, in order. */
  readonly removed: string[] = [];

  readonly addEventListener = (type: string, listener: (event: Event) => void): void => {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  };

  readonly removeEventListener = (type: string, listener: (event: Event) => void): void => {
    this.removed.push(type);
    this.listeners.get(type)?.delete(listener);
  };

  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(new Event(type));
  }
}

interface TestClock extends ClockLike {
  /** The device time now, in ms (the test moves it). */
  t: number;
}

/** A ready clock whose server offset is zero: server time and client time read the same. */
function testClock(): TestClock {
  const clock: TestClock = {
    t: 10_000,
    now: () => clock.t,
    ready: () => true,
    toClient: (serverTime) => serverTime,
    toServer: (clientTime) => clientTime,
    offset: () => 0,
  };
  return clock;
}

interface Timer {
  handle: number;
  fn: () => void;
  ms: number;
  /** When it is due on the timers' own time (advance() moves it). */
  due: number;
}

/**
 * Timers fired by hand (the lobby polling schedules one poll at a time): fire() runs the earliest scheduled one;
 * advance(ms) moves the timers' own time and runs every timer due by then, in the order they fall due (the press
 * feedback of K1.1 step 3: 150 ms flash, 1.2 s note, 1 s toast).
 */
class ManualTimers {
  readonly pending: Timer[] = [];
  readonly cleared: unknown[] = [];
  private nextHandle = 1;
  private elapsed = 0;

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const timer: Timer = { handle: this.nextHandle, fn, ms, due: this.elapsed + ms };
    this.nextHandle += 1;
    this.pending.push(timer);
    return timer.handle;
  };

  /** Moves the timers' time on by `ms`, running every timer due by then (also those scheduled meanwhile). */
  advance(ms: number): void {
    const until = this.elapsed + ms;
    for (;;) {
      const next = [...this.pending].sort((a, b) => a.due - b.due || a.handle - b.handle)[0];
      if (next === undefined || next.due > until) break;
      this.pending.splice(this.pending.indexOf(next), 1);
      this.elapsed = next.due;
      next.fn();
    }
    this.elapsed = until;
  }

  readonly clearTimeout = (handle: unknown): void => {
    this.cleared.push(handle);
    const index = this.pending.findIndex((timer) => timer.handle === handle);
    if (index >= 0) this.pending.splice(index, 1);
  };

  /** Fires the earliest pending timer. */
  fire(): void {
    const timer = this.pending.shift();
    if (timer === undefined) throw new Error('no pending timer to fire');
    timer.fn();
  }
}

// ---- fixtures ----------------------------------------------------------------------------------------------

const me: PublicProfile = {
  id: 'host',
  riderName: 'Maria',
  riderGender: 'girl',
  ponyName: 'Dakota',
  ponyGender: 'yegua',
  ponyCategory: 'C',
  clubId: null,
};

/** One fence at 30 m on 50 m, as the live client fixture. */
const course: CourseSpec = {
  id: 'c',
  version: 1,
  lengthM: 50,
  speedMPerMin: 250,
  fences: [{ number: 1, distanceM: 30, type: 'vertical' }],
  turns: [],
};

const person = (id: string, riderName: string, ponyName: string, over: Partial<LobbyPerson> = {}): LobbyPerson => ({
  id,
  riderName,
  riderGender: 'girl',
  ponyName,
  ponyGender: 'yegua',
  ponyCategory: 'C',
  clubId: null,
  club: null,
  ...over,
});

/** The host's door view: Maria and Ana are in, Bea rings the bell. */
const view = (over: Partial<LobbyView> = {}): LobbyView => ({
  code: 'ABCDEF',
  hostId: 'host',
  entryOpen: true,
  autoAdmitClub: false,
  clubId: null,
  participants: [person('host', 'Maria', 'Dakota'), person('ana', 'Ana', 'Luna')],
  pending: [person('bea', 'Bea', 'Nube', { ponyGender: 'macho' })],
  kicked: [],
  ...over,
});

const participant = (accountId: string, riderName: string, ponyName: string, isHost: boolean): ParticipantView => ({ accountId, riderName, ponyName, isHost });

const rider = (accountId: string, over: Partial<RiderView> = {}): RiderView => ({
  accountId,
  heightClass: 70,
  positionM: 0,
  gear: 'collected',
  nextFence: 1,
  attempt: 1,
  faults: 0,
  status: 'riding',
  autopilot: false,
  lastLabel: '',
  riderName: '',
  ponyName: '',
  ...over,
});

/** The room in its lobby with Maria (the host) and Ana in, Bea at the door. */
const snapshot = (over: Partial<LobbyStateSnapshot> = {}): LobbyStateSnapshot => ({
  code: 'ABCDEF',
  hostId: 'host',
  entryOpen: true,
  pendingCount: 1,
  participants: {
    host: participant('host', 'Maria', 'Dakota', true),
    ana: participant('ana', 'Ana', 'Luna', false),
  },
  phase: 'lobby',
  heatIndex: -1,
  nextHeat: false,
  roundClockMs: 0,
  riders: {},
  ...over,
});

/** The same room seen by a guest: Ana is the host, Maria (the signed-in rider) a participant. */
const guestSnapshot = (over: Partial<LobbyStateSnapshot> = {}): LobbyStateSnapshot =>
  snapshot({
    hostId: 'ana',
    pendingCount: 0,
    participants: {
      ana: participant('ana', 'Ana', 'Luna', true),
      host: participant('host', 'Maria', 'Dakota', false),
    },
    ...over,
  });

/** Heat 1 of a class: Maria and Ana both at fence 1, attempt 1, in the 70 cm class. */
const ridingState = (over: Partial<LobbyStateSnapshot> = {}): LobbyStateSnapshot =>
  snapshot({
    phase: 'riding',
    heatIndex: 0,
    roundClockMs: 5_000,
    riders: { host: rider('host'), ana: rider('ana') },
    ...over,
  });

const approach70: ApproachState = { gear: 'collected', heightClass: 70, angleSharp: false, recentHardTurn: false, spooked: false, leadHorseBonus: false };

/** The server's verdict "a late tap, front rail" (the judge's chip outcome). */
const chip: TakeoffOutcome = { kind: 'chip', faults: 4, cleared: true, label: 'batida_corta', horseJumped: true };
/** The server's verdict "clean" (the fence is cleared, no faults). */
const clean: TakeoffOutcome = { kind: 'clean', faults: 0, cleared: true, label: 'cero_faltas', horseJumped: true };

const table: ClassTableWire = {
  '70': [
    { place: 1, riderId: 'ana', riderName: 'Ana', ponyName: 'Luna', faults: 0, timeMs: 55_200, status: 'finished', eliminationReason: null, autopilot: false },
    { place: 2, riderId: 'host', riderName: 'Maria', ponyName: 'Dakota', faults: 4, timeMs: 60_100, status: 'finished', eliminationReason: null, autopilot: false },
  ],
};

const roundEvent = (event: RoundEventWire): ServerMessage => ({ type: 'round-event', event });

/** Three fences over 120 m with a turn, for the fly-over (the one-fence course keeps the focus on fence 1 throughout). */
const course3: CourseSpec = {
  id: 'c3',
  version: 1,
  lengthM: 120,
  speedMPerMin: 300,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 60, type: 'oxer' },
    { number: 3, distanceM: 100, type: 'vertical' },
  ],
  turns: [{ distanceM: 45, direction: 'left' }],
};

/** The server announces a phase with its clock: `startedAt` in server ms, the timer's end for walk and results. */
const phaseMessage = (phase: 'walk' | 'riding' | 'results' | 'done', heatIndex: number, startedAt: number, endsAt: number | null): ServerMessage => ({
  type: 'class-phase',
  phase,
  heatIndex,
  startedAt,
  endsAt,
});

/** The phone layout of the harness's arena (an iPhone 16e in landscape, 844×390). */
const PHONE_LAYOUT = layoutFor(844, 390);
/** The middle of a control's zone in that layout (the points follow the layout, whichever geometry it has). */
const middleOf = (control: Control): [number, number] => {
  const zone = PHONE_LAYOUT.zones[control];
  return [zone.x + zone.w / 2, zone.y + zone.h / 2];
};
const TAP: [number, number] = middleOf('tap');
const GEAR: [number, number] = middleOf('gear');
const TURN_LEFT: [number, number] = middleOf('turn-left');
const TURN_RIGHT: [number, number] = middleOf('turn-right');

// ---- the harness -------------------------------------------------------------------------------------------

/** Lets every pending promise reaction run (API replies and connects resolve on microtasks, in chains). */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Harness {
  game: Game;
  root: HTMLElement;
  api: FakeApi;
  /** Every session the factory created, in order. */
  sessions: FakeSession[];
  scene: FakeScene;
  win: FakeWindow;
  clock: TestClock;
  timers: ManualTimers;
  /** The measured arena rectangle (viewport coordinates); the test moves and resizes it. */
  arena: ArenaRect;
  /** The state the next connect() installs and how the next session's connect() behaves. */
  settings: { stateOnConnect: LobbyStateSnapshot; connect: ConnectMode };
  /** The latest session. */
  session(): FakeSession;
}

interface BootOptions {
  script?: Script;
  stateOnConnect?: LobbyStateSnapshot;
  /** The clock the game reads instead of the harness's ready test clock (e.g. a real ClientClock fed with pings). */
  clock?: ClockLike;
  /** The debug overlay of K1.1 step 9 (the page address with ?debug). */
  debug?: boolean;
}

/** Every game built in this file is destroyed and its root removed after the test. */
const games: Game[] = [];
afterEach(() => {
  for (const game of games.splice(0)) {
    try {
      game.destroy();
    } catch {
      // A game already destroyed by the test (or a stub) must not hide the test's own result.
    }
  }
  document.body.innerHTML = '';
});

/** A game on a fresh root; api.me is answered from the script (signed in with `me` unless the script says otherwise). */
async function boot(options: BootOptions = {}): Promise<Harness> {
  const api = fakeApi({ me: [ok(me)], ...options.script });
  const sessions: FakeSession[] = [];
  const scene = new FakeScene();
  const win = new FakeWindow();
  const clock = testClock();
  const timers = new ManualTimers();
  const settings: Harness['settings'] = { stateOnConnect: options.stateOnConnect ?? snapshot(), connect: 'ok' };
  /** An iPhone 16e in landscape with nothing in the way: the arena fills the viewport. */
  const arena: ArenaRect = { left: 0, top: 0, width: 844, height: 390 };
  const root = document.createElement('div');
  document.body.appendChild(root);
  const game = createGame({
    document,
    window: win,
    root,
    api: api.api,
    session: () => {
      const session = new FakeSession(settings.stateOnConnect, settings.connect);
      sessions.push(session);
      return session;
    },
    clock: options.clock ?? clock,
    scene,
    locale: 'en',
    measure: () => ({ ...arena }),
    timers,
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  });
  games.push(game);
  await settle();
  return {
    game,
    root,
    api,
    sessions,
    scene,
    win,
    clock,
    timers,
    arena,
    settings,
    session: () => {
      const session = sessions[sessions.length - 1];
      if (session === undefined) throw new Error('no session was created');
      return session;
    },
  };
}

function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`missing ${selector}`);
  return element;
}

const text = (element: Element | null): string => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Every control is drawn exactly at its zone of `layout` (arena-local CSS px). */
function expectPlaced(h: Harness, layout: Layout): void {
  for (const control of ['turn-left', 'turn-right', 'gear', 'tap'] as const) {
    const element = q(h.root, `[data-control="${control}"]`);
    const zone = layout.zones[control];
    expect([element.style.left, element.style.top, element.style.width, element.style.height], control).toEqual([
      `${String(zone.x)}px`,
      `${String(zone.y)}px`,
      `${String(zone.w)}px`,
      `${String(zone.h)}px`,
    ]);
  }
}

function click(root: ParentNode, selector: string): void {
  q(root, selector).click();
}

/** Sets a form field by name: a select, a radio group, or a text input. */
function setField(form: HTMLFormElement, name: string, value: string): void {
  const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)];
  const first = controls[0];
  if (first === undefined) throw new Error(`the form has no field "${name}"`);
  if (first.tagName === 'SELECT') {
    first.value = value;
    first.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const radios = controls.filter((control): control is HTMLInputElement => control.tagName === 'INPUT' && (control as HTMLInputElement).type === 'radio');
  if (radios.length > 0) {
    for (const radio of radios) radio.checked = radio.value === value;
    radios.find((radio) => radio.checked)?.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  first.value = value;
  first.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

function setChecked(root: ParentNode, selector: string, checked: boolean): void {
  const input = q<HTMLInputElement>(root, selector);
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function select(root: ParentNode, selector: string, value: string): void {
  const element = q<HTMLSelectElement>(root, selector);
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/** A finger on the arena at viewport coordinates (x, y). */
/**
 * A finger on the arena at (x, y). The event's timeStamp — the moment of the touch, in the clock's units — is the
 * test clock's reading unless given: a real event is stamped by the browser, and happy-dom's own stamp is the
 * process's performance.now(), unrelated to the test clock.
 */
function press(h: Harness, [x, y]: [number, number], timeStamp: number = h.clock.now()): void {
  const event = new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  q(h.root, '[data-arena]').dispatchEvent(event);
}

/** A finger on the page at viewport coordinates (x, y) when the arena is not on screen: the root hears the pointerdown. */
function pressPage(h: Harness, [x, y]: [number, number]): void {
  h.root.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

/** Fills and submits the register form with Maria on Dakota. */
async function register(h: Harness): Promise<void> {
  const form = q<HTMLFormElement>(h.root, 'form[data-form="register"]');
  setField(form, 'riderName', 'Maria');
  setField(form, 'pin', '1234');
  setField(form, 'ponyName', 'Dakota');
  setField(form, 'riderGender', 'girl');
  setField(form, 'ponyGender', 'yegua');
  setField(form, 'ponyCategory', 'C');
  submit(form);
  await settle();
}

/** Types a code into the ring form and rings. */
async function ring(h: Harness, code: string): Promise<void> {
  const form = q<HTMLFormElement>(h.root, 'form[data-form="ring"]');
  setField(form, 'code', code);
  submit(form);
  await settle();
}

/** Signed in on home → the host creates room ABCDEF and is in its lobby with a connected session. */
async function hostInLobby(script: Script = {}, stateOnConnect: LobbyStateSnapshot = snapshot(), clock?: ClockLike, debug?: boolean): Promise<Harness> {
  const h = await boot({
    ...(clock ? { clock } : {}),
    ...(debug !== undefined ? { debug } : {}),
    script: {
      createRoom: [ok({ code: 'ABCDEF', roomId: 'r1' })],
      lobby: [ok(view()), ok(view()), ok(view()), ok(view()), ok(view())],
      door: [done, done],
      setEntry: [done],
      setAutoAdmit: [done],
      ...script,
    },
    stateOnConnect,
  });
  click(h.root, '[data-action="create-room"]');
  await settle();
  expect(h.root.dataset.screen).toBe('lobby');
  return h;
}

/** Signed in on home → rings at ABCDEF, admitted at once → in the lobby as a guest (Ana hosts). */
async function guestInLobby(script: Script = {}): Promise<Harness> {
  const h = await boot({
    script: {
      knock: [ok<JoinDecision>({ status: 'admitted' })],
      roomStatus: [ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' })],
      ...script,
    },
    stateOnConnect: guestSnapshot(),
  });
  await ring(h, 'ABCDEF');
  expect(h.root.dataset.screen).toBe('lobby');
  return h;
}

/** The server announces class `classNumber`, the room walks the course, then heat 1 rides (the own rider at fence 1, attempt 1). */
function startClass(h: Harness, classNumber = 1, asGuest = false): void {
  const session = h.session();
  const base = asGuest ? guestSnapshot : snapshot;
  session.emitMessage({ type: 'class-course', course, classNumber });
  session.emitState(base({ phase: 'walk', heatIndex: 0 }));
  session.emitState(base({ phase: 'riding', heatIndex: 0, roundClockMs: 5_000, riders: { host: rider('host'), ana: rider('ana') } }));
}

/** The host in heat 1 of class 1, riding towards fence 1. */
async function inRound(): Promise<Harness> {
  const h = await hostInLobby();
  startClass(h);
  await settle();
  expect(h.root.dataset.screen).toBe('round');
  return h;
}

/**
 * The server opens the own horse's approach of `fence`, `attempt` with the take-off moment `t0` (server time = device
 * time here). K1 tests send it without speed (speedMps null: the K1 behaviour — the marker an outline, the own horse
 * from the patch); the K1.1 tests of the marker and the forecast pass the speed.
 */
function approachOwn(h: Harness, fence = 1, attempt = 1, t0 = h.clock.now() + 1_000, speedMps: number | null = null): void {
  h.session().emitMessage(roundEvent({ type: 'approach', riderId: 'host', fence, attempt, t0, speedMps }));
}

/** The host in heat 1 of class 1 with the approach of fence 1, attempt 1 open (t0 one second ahead): the tap is armed. */
async function inApproach(): Promise<Harness> {
  const h = await inRound();
  approachOwn(h);
  return h;
}

/** The host in the lobby → the course walk of class 1. */
async function inWalk(): Promise<Harness> {
  const h = await hostInLobby();
  const session = h.session();
  session.emitMessage({ type: 'class-course', course, classNumber: 1 });
  session.emitState(snapshot({ phase: 'walk', heatIndex: 0 }));
  await settle();
  expect(h.root.dataset.screen).toBe('walk');
  return h;
}

/** The class table arrived and the class is done: the results screen. */
async function inResults(h: Harness, asGuest = false): Promise<void> {
  const session = h.session();
  session.emitMessage({ type: 'class-table', table });
  session.emitState((asGuest ? guestSnapshot : snapshot)({ phase: 'done', heatIndex: 0 }));
  await settle();
  expect(h.root.dataset.screen).toBe('results');
}

function becomeVisible(): void {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

// ---- start -------------------------------------------------------------------------------------------------

describe('createGame on start', () => {
  it('asks api.me and shows the sign-in screen when nobody is signed in (401)', async () => {
    const h = await boot({ script: { me: [failed(401, 'unauthorized')] } });
    expect(h.api.callsOf('me')).toEqual([[]]);
    expect(h.root.dataset.screen).toBe('signin');
    expect(h.game.screen).toBe('signin');
    expect(h.game.session).toBeNull();
  });

  it('shows home with "Maria on Dakota" when api.me knows the rider', async () => {
    const h = await boot();
    expect(h.root.dataset.screen).toBe('home');
    expect(h.game.screen).toBe('home');
    expect(text(h.root.querySelector('[data-hello]'))).toBe('Maria on Dakota');
    expect(h.game.locale).toBe('en');
  });
});

// ---- sign-in -----------------------------------------------------------------------------------------------

describe('the sign-in screen', () => {
  it('submitting the register form calls api.register with the typed rider and goes home', async () => {
    const h = await boot({ script: { me: [failed(401, 'unauthorized')], register: [ok(me)] } });
    await register(h);
    const expected: RegisterInput = { riderName: 'Maria', pin: '1234', ponyName: 'Dakota', riderGender: 'girl', ponyGender: 'yegua', ponyCategory: 'C' };
    expect(h.api.callsOf('register')).toEqual([[expected]]);
    expect(h.root.dataset.screen).toBe('home');
    expect(text(h.root.querySelector('[data-hello]'))).toBe('Maria on Dakota');
  });

  it('a refused registration (409 rider-name-taken) stays on sign-in and shows the error in the locale', async () => {
    const h = await boot({ script: { me: [failed(401, 'unauthorized')], register: [failed(409, 'rider-name-taken')] } });
    await register(h);
    expect(h.root.dataset.screen).toBe('signin');
    expect(text(h.root.querySelector('[data-error]'))).toBe('That rider name is taken — try another');
  });

  it('submitting the login form calls api.login(riderName, pin) and goes home', async () => {
    const h = await boot({ script: { me: [failed(401, 'unauthorized')], login: [ok(me)] } });
    const form = q<HTMLFormElement>(h.root, 'form[data-form="login"]');
    setField(form, 'riderName', 'Maria');
    setField(form, 'pin', '1234');
    submit(form);
    await settle();
    expect(h.api.callsOf('login')).toEqual([['Maria', '1234']]);
    expect(h.root.dataset.screen).toBe('home');
  });

  it('a wrong PIN (401 invalid-credentials) stays on sign-in with "Wrong name or PIN"', async () => {
    const h = await boot({ script: { me: [failed(401, 'unauthorized')], login: [failed(401, 'invalid-credentials')] } });
    const form = q<HTMLFormElement>(h.root, 'form[data-form="login"]');
    setField(form, 'riderName', 'Maria');
    setField(form, 'pin', '0000');
    submit(form);
    await settle();
    expect(h.root.dataset.screen).toBe('signin');
    expect(text(h.root.querySelector('[data-error]'))).toBe('Wrong name or PIN');
  });

  it('the Spanish locale button re-renders the sign-in screen in Spanish', async () => {
    const h = await boot({ script: { me: [failed(401, 'unauthorized')] } });
    expect(text(h.root)).toContain('Who is riding?');
    click(h.root, '[data-action="locale"][data-locale="es"]');
    expect(h.game.locale).toBe('es');
    expect(h.root.dataset.screen).toBe('signin');
    expect(text(h.root)).toContain('¿Quién monta?');
    expect(text(h.root)).not.toContain('Who is riding?');
  });
});

// ---- home --------------------------------------------------------------------------------------------------

describe('the home screen', () => {
  it('the locale buttons switch the greeting in place: "Maria con Dakota", then back to "Maria on Dakota"', async () => {
    const h = await boot();
    click(h.root, '[data-action="locale"][data-locale="es"]');
    expect(h.game.locale).toBe('es');
    expect(h.root.dataset.screen).toBe('home');
    expect(text(h.root.querySelector('[data-hello]'))).toBe('Maria con Dakota');
    click(h.root, '[data-action="locale"][data-locale="en"]');
    expect(h.game.locale).toBe('en');
    expect(text(h.root.querySelector('[data-hello]'))).toBe('Maria on Dakota');
  });

  it('setLocale() does the same from code', async () => {
    const h = await boot();
    h.game.setLocale('es');
    expect(h.game.locale).toBe('es');
    expect(text(h.root.querySelector('[data-hello]'))).toBe('Maria con Dakota');
  });

  it('create room: api.createRoom → one session connected with the roomId and the code → the lobby with the code', async () => {
    const h = await boot({ script: { createRoom: [ok({ code: 'ABCDEF', roomId: 'r1' })], lobby: [ok(view()), ok(view())] } });
    click(h.root, '[data-action="create-room"]');
    await settle();
    expect(h.api.callsOf('createRoom')).toHaveLength(1);
    expect(h.sessions).toHaveLength(1);
    expect(h.session().connects).toEqual([['r1', 'ABCDEF']]);
    expect(h.game.session).toBe(h.session());
    expect(h.root.dataset.screen).toBe('lobby');
    expect(h.game.screen).toBe('lobby');
    expect(text(h.root.querySelector('[data-code]'))).toBe('ABCDEF');
  });

  it('ring: the code is normalised, a pending knock shows the waiting text, the poll admits → connect → lobby', async () => {
    const h = await boot({
      script: {
        knock: [ok<JoinDecision>({ status: 'pending' })],
        roomStatus: [ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' })],
      },
      stateOnConnect: guestSnapshot(),
    });
    await ring(h, 'ab cdef');
    expect(h.api.callsOf('knock')).toEqual([['ABCDEF']]);
    expect(text(h.root.querySelector('[data-status]'))).toBe('Waiting for the host to let you in…');
    expect(h.sessions).toHaveLength(0);
    expect(h.timers.pending).toHaveLength(1);
    h.timers.fire();
    await settle();
    expect(h.api.callsOf('roomStatus')).toEqual([['ABCDEF']]);
    expect(h.sessions).toHaveLength(1);
    expect(h.session().connects).toEqual([['r1', 'ABCDEF']]);
    expect(h.root.dataset.screen).toBe('lobby');
    expect(text(h.root.querySelector('[data-code]'))).toBe('ABCDEF');
  });

  it('ring at an unknown code (404 unknown-code): the refusal text, still home, no session', async () => {
    const h = await boot({ script: { knock: [failed(404, 'unknown-code')] } });
    await ring(h, 'ABCDEF');
    expect(text(h.root.querySelector('[data-status]'))).toBe('No room with that code');
    expect(h.root.dataset.screen).toBe('home');
    expect(h.sessions).toHaveLength(0);
    expect(h.game.session).toBeNull();
  });

  it('logout: api.logout → the sign-in screen', async () => {
    const h = await boot({ script: { logout: [done] } });
    click(h.root, '[data-action="logout"]');
    await settle();
    expect(h.api.callsOf('logout')).toEqual([[]]);
    expect(h.root.dataset.screen).toBe('signin');
  });
});

// ---- lobby -------------------------------------------------------------------------------------------------

describe('the lobby as the host', () => {
  it('lists the participants by account id', async () => {
    const h = await hostInLobby();
    const list = q(h.root, '[data-list="participants"]');
    expect(text(list.querySelector('[data-id="host"]'))).toContain('Maria on Dakota');
    expect(text(list.querySelector('[data-id="ana"]'))).toContain('Ana on Luna');
  });

  it('fetches the door view on entry and lists who wants in; admit → api.door and the view fetched again', async () => {
    const h = await hostInLobby();
    h.session().emitState(snapshot({ pendingCount: 1 }));
    await settle();
    const before = h.api.callsOf('lobby').length;
    expect(before).toBeGreaterThanOrEqual(1);
    expect(h.api.callsOf('lobby')[0]).toEqual(['ABCDEF']);
    const pending = q(h.root, '[data-list="pending"]');
    expect(text(pending.querySelector('[data-id="bea"]'))).toContain('Bea on Nube');
    click(h.root, '[data-action="admit"][data-id="bea"]');
    await settle();
    expect(h.api.callsOf('door')).toEqual([['ABCDEF', 'admit', 'bea']]);
    expect(h.api.callsOf('lobby')).toHaveLength(before + 1);
  });

  it('deny → api.door(code, deny, id)', async () => {
    const h = await hostInLobby();
    click(h.root, '[data-action="deny"][data-id="bea"]');
    await settle();
    expect(h.api.callsOf('door')).toEqual([['ABCDEF', 'deny', 'bea']]);
  });

  it('unchecking the door checkbox → api.setEntry(code, false)', async () => {
    const h = await hostInLobby();
    const entry = q<HTMLInputElement>(h.root, 'input[data-action="entry-open"]');
    expect(entry.checked).toBe(true);
    setChecked(h.root, 'input[data-action="entry-open"]', false);
    await settle();
    expect(h.api.callsOf('setEntry')).toEqual([['ABCDEF', false]]);
  });

  it('checking the auto-admit checkbox → api.setAutoAdmit(code, true)', async () => {
    const h = await hostInLobby();
    setChecked(h.root, 'input[data-action="auto-admit"]', true);
    await settle();
    expect(h.api.callsOf('setAutoAdmit')).toEqual([['ABCDEF', true]]);
  });

  it('the height picker offers the classes of the pony category (C: 70, 80, 90) and sends {type: height}', async () => {
    const h = await hostInLobby();
    const picker = q<HTMLSelectElement>(h.root, 'select[data-height]');
    expect([...picker.options].map((option) => option.value)).toEqual(['70', '80', '90']);
    select(h.root, 'select[data-height]', '80');
    expect(h.session().sentOf('height')).toEqual([{ type: 'height', heightClass: 80 }]);
  });

  it('the schoolmaster assist sends both assists', async () => {
    const h = await hostInLobby();
    setChecked(h.root, 'input[data-assist="schoolmaster"]', true);
    expect(h.session().sentOf('assists')).toEqual([{ type: 'assists', schoolmaster: true, widerWindow: false }]);
  });

  it('the wider-window assist sends both assists', async () => {
    const h = await hostInLobby();
    setChecked(h.root, 'input[data-assist="widerWindow"]', true);
    expect(h.session().sentOf('assists')).toEqual([{ type: 'assists', schoolmaster: false, widerWindow: true }]);
  });

  it('start the class in random order', async () => {
    const h = await hostInLobby();
    select(h.root, 'select[data-order]', 'random');
    click(h.root, '[data-action="start-class"]');
    expect(h.session().sentOf('start-class')).toEqual([{ type: 'start-class', order: 'random' }]);
  });

  it('start the class lowest heights first', async () => {
    const h = await hostInLobby();
    select(h.root, 'select[data-order]', 'lowest-class-first');
    click(h.root, '[data-action="start-class"]');
    expect(h.session().sentOf('start-class')).toEqual([{ type: 'start-class', order: 'lowest-class-first' }]);
  });

  it('leave → session.leave() → home', async () => {
    const h = await hostInLobby();
    click(h.root, '[data-action="leave"]');
    await settle();
    expect(h.session().leaves).toBe(1);
    expect(h.root.dataset.screen).toBe('home');
    expect(h.game.session).toBeNull();
  });
});

describe('the room refuses the WebSocket after the HTTP admission (audit K1 r1 #3)', () => {
  it('joinById rejects: the waiting lobby gives way to home with the network error and a retry button; the session is gone', async () => {
    const h = await boot({
      script: { knock: [ok<JoinDecision>({ status: 'admitted' })], roomStatus: [ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' })] },
      stateOnConnect: guestSnapshot(),
    });
    h.settings.connect = 'fail';
    await ring(h, 'ABCDEF');
    expect(h.sessions).toHaveLength(1);
    expect(h.root.dataset.screen).toBe('home');
    expect(h.game.screen).toBe('home');
    expect(h.game.session).toBeNull();
    expect(text(h.root.querySelector('[data-status]'))).toBe('No connection to the server');
    expect(text(h.root.querySelector('[data-action="retry"]'))).toBe('Try again');
    expect(h.timers.pending).toEqual([]);
  });

  it('retry rings the same code again and the new session connects into the lobby; the failed session is left alone', async () => {
    const h = await boot({
      script: {
        knock: [ok<JoinDecision>({ status: 'admitted' }), ok<JoinDecision>({ status: 'rejected', reason: 'already-in' })],
        roomStatus: [ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' }), ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' })],
      },
      stateOnConnect: guestSnapshot(),
    });
    h.settings.connect = 'fail';
    await ring(h, 'ABCDEF');
    expect(h.root.dataset.screen).toBe('home');
    h.settings.connect = 'ok';
    click(h.root, '[data-action="retry"]');
    await settle();
    expect(h.api.callsOf('knock')).toEqual([['ABCDEF'], ['ABCDEF']]);
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]?.connects).toEqual([['r1', 'ABCDEF']]);
    expect(h.game.session).toBe(h.sessions[1]);
    expect(h.root.dataset.screen).toBe('lobby');
    expect(text(h.root.querySelector('[data-code]'))).toBe('ABCDEF');
    expect(h.sessions[0]?.leaves).toBe(0); // nothing to leave: it never connected
    expect(h.root.querySelector('[data-action="retry"]')).toBeNull();
  });

  it('a late word from the failed attempt changes nothing: its status, state and end are ignored once a new session is in', async () => {
    const h = await boot({
      script: {
        knock: [ok<JoinDecision>({ status: 'admitted' }), ok<JoinDecision>({ status: 'admitted' })],
        roomStatus: [ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' }), ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' })],
      },
      stateOnConnect: guestSnapshot(),
    });
    h.settings.connect = 'hold';
    await ring(h, 'ABCDEF');
    expect(h.root.dataset.screen).toBe('lobby'); // waiting for the WebSocket
    expect(text(h.root.querySelector('[data-status]'))).toBe('Waiting for the host to let you in…');
    const first = h.session();
    first.release(new Error('the room refused the WebSocket'));
    await settle();
    expect(h.root.dataset.screen).toBe('home');
    h.settings.connect = 'ok';
    click(h.root, '[data-action="retry"]');
    await settle();
    expect(h.root.dataset.screen).toBe('lobby');
    expect(h.game.session).toBe(h.sessions[1]);
    // The old attempt speaks up late: nothing on the screen moves.
    first.emitStatus('connected');
    first.emitState(guestSnapshot({ phase: 'riding', heatIndex: 0 }));
    first.endWith({ kind: 'lost', code: 1006 });
    await settle();
    expect(h.root.dataset.screen).toBe('lobby');
    expect(h.root.querySelector('[data-ended]')).toBeNull();
    expect(h.game.session).toBe(h.sessions[1]);
  });

  it('a connect() that resolves after a newer session took over is left again at once, so no zombie connection stays in the room', async () => {
    const h = await boot({
      script: {
        knock: [ok<JoinDecision>({ status: 'admitted' }), ok<JoinDecision>({ status: 'admitted' })],
        roomStatus: [ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' }), ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' })],
      },
      stateOnConnect: guestSnapshot(),
    });
    h.settings.connect = 'hold';
    await ring(h, 'ABCDEF');
    const first = h.session();
    // The rider gives up on the slow room and rings again from home (the leave button of the waiting lobby).
    click(h.root, '[data-action="leave"]');
    await settle();
    expect(h.root.dataset.screen).toBe('home');
    h.settings.connect = 'ok';
    await ring(h, 'ABCDEF');
    expect(h.root.dataset.screen).toBe('lobby');
    expect(h.game.session).toBe(h.sessions[1]);
    // Leaving while it was still connecting is a no-op on a real session (no room yet): the late connect must leave again.
    const leavesBefore = first.leaves;
    first.release();
    await settle();
    expect(first.leaves).toBe(leavesBefore + 1);
    expect(h.game.session).toBe(h.sessions[1]);
    expect(h.root.dataset.screen).toBe('lobby');
  });
});

describe('the lobby as a guest', () => {
  it('shows the code and the participants but no start button and no door lists, and never asks the host-only view', async () => {
    const h = await guestInLobby();
    expect(text(h.root.querySelector('[data-code]'))).toBe('ABCDEF');
    expect(h.root.querySelector('[data-list="participants"] [data-id="ana"]')).not.toBeNull();
    expect(h.root.querySelector('[data-action="start-class"]')).toBeNull();
    expect(h.root.querySelector('[data-list="pending"]')).toBeNull();
    expect(h.root.querySelector('[data-list="kicked"]')).toBeNull();
    expect(h.api.callsOf('lobby')).toEqual([]);
  });
});

// ---- the course walk -----------------------------------------------------------------------------------------

describe('the course walk', () => {
  it('class-course + phase walk → the walk screen, the scene told the course, the fences listed, fence 1 in focus', async () => {
    const h = await inWalk();
    expect(h.game.screen).toBe('walk');
    expect(h.scene.courses[h.scene.courses.length - 1]).toEqual(course);
    expect(h.scene.mounted).not.toBeNull();
    const fences = [...q(h.root, '[data-list="fences"]').querySelectorAll('li')];
    expect(fences).toHaveLength(1);
    expect(text(fences[0] ?? null)).toContain('Fence 1: vertical');
    expect(text(h.root.querySelector('[data-focus]:not([data-fence-marker])'))).toBe('1');
  });

  it('a frame during the walk renders the walk with the focused fence', async () => {
    const h = await inWalk();
    h.game.frame(h.clock.now());
    const frame = h.scene.frames[h.scene.frames.length - 1];
    expect(frame?.phase).toBe('walk');
    expect(frame?.focusFence).toBe(1);
  });

  it('the walk is in the locale: "Salto 1" in Spanish', async () => {
    const h = await inWalk();
    click(h.root, '[data-action="locale"][data-locale="es"]');
    expect(text(q(h.root, '[data-list="fences"]').querySelector('li'))).toContain('Salto 1: vertical');
  });
});

describe("the fly-over follows the server's walk window (audit K1 r1 #6)", () => {
  /** The host in the lobby → class 1 announced with the three-fence course → the walk of heat 0 from server time `startedAt`, `walkMs` long. */
  async function walkOf(h: Harness, heatIndex: number, startedAt: number, walkMs = 10_000): Promise<void> {
    const session = h.session();
    session.emitMessage(phaseMessage('walk', heatIndex, startedAt, startedAt + walkMs));
    session.emitState(snapshot({ phase: 'walk', heatIndex }));
    await settle();
    expect(h.root.dataset.screen).toBe('walk');
  }

  const focusShown = (h: Harness): string => text(h.root.querySelector('[data-focus]:not([data-fence-marker])'));
  const focusDrawn = (h: Harness): number | null => {
    h.game.frame(h.clock.now());
    return h.scene.frames.at(-1)?.focusFence ?? null;
  };

  it('the focus moves from fence 1 to the last over the window the server announced, not over a client constant', async () => {
    const h = await hostInLobby();
    h.session().emitMessage({ type: 'class-course', course: course3, classNumber: 1 });
    await walkOf(h, 0, h.clock.now(), 6_000); // a club walk of 6 s, whatever the client used to assume
    expect(focusShown(h)).toBe('1');
    h.clock.t += 2_500;
    expect(focusDrawn(h)).toBe(2);
    expect(focusShown(h)).toBe('2');
    h.clock.t += 2_000;
    expect(focusDrawn(h)).toBe(3);
    h.clock.t += 10_000;
    expect(focusDrawn(h)).toBe(3);
  });

  it('the window is read through the clock offset: server times become device times', async () => {
    const h = await hostInLobby();
    // The server's clock runs 5 s ahead of this device (both directions of the translation, as a real clock has them).
    h.clock.toClient = (serverTime) => serverTime - 5_000;
    h.clock.toServer = (clientTime) => clientTime + 5_000;
    h.session().emitMessage({ type: 'class-course', course: course3, classNumber: 1 });
    await walkOf(h, 0, h.clock.now() + 5_000, 9_000); // began right now in server terms
    expect(focusShown(h)).toBe('1');
    h.clock.t += 3_500;
    expect(focusDrawn(h)).toBe(2);
    h.clock.t += 3_000;
    expect(focusDrawn(h)).toBe(3);
  });

  it('the second heat of the class gets its own walk: the fly-over starts at fence 1 again instead of staying on the last fence', async () => {
    const h = await hostInLobby();
    h.session().emitMessage({ type: 'class-course', course: course3, classNumber: 1 });
    await walkOf(h, 0, h.clock.now());
    h.clock.t += 9_500;
    expect(focusDrawn(h)).toBe(3);
    // Heat 0 rides and ends; 15 s of results; then the walk of heat 1.
    h.clock.t += 500;
    h.session().emitMessage(phaseMessage('riding', 0, h.clock.now(), null));
    h.session().emitState(snapshot({ phase: 'riding', heatIndex: 0, roundClockMs: 0, riders: { host: rider('host'), ana: rider('ana') } }));
    h.clock.t += 40_000;
    h.session().emitMessage(phaseMessage('results', 0, h.clock.now(), h.clock.now() + 15_000));
    h.session().emitState(snapshot({ phase: 'results', heatIndex: 0 }));
    h.clock.t += 15_000;
    await walkOf(h, 1, h.clock.now());
    expect(focusShown(h)).toBe('1');
    expect(focusDrawn(h)).toBe(1);
    h.clock.t += 3_400;
    expect(focusDrawn(h)).toBe(2);
    h.clock.t += 3_400;
    expect(focusDrawn(h)).toBe(3);
  });

  it('a walk of a new heat seen in the state before its phase message never reuses the old window: fence 1 until the message comes', async () => {
    const h = await hostInLobby();
    h.session().emitMessage({ type: 'class-course', course: course3, classNumber: 1 });
    await walkOf(h, 0, h.clock.now());
    h.clock.t += 9_500;
    expect(focusDrawn(h)).toBe(3);
    h.clock.t += 60_000;
    h.session().emitState(snapshot({ phase: 'walk', heatIndex: 1 }));
    await settle();
    expect(h.root.dataset.screen).toBe('walk');
    expect(focusShown(h)).toBe('1');
    expect(focusDrawn(h)).toBe(1);
    h.session().emitMessage(phaseMessage('walk', 1, h.clock.now() - 3_400, h.clock.now() + 6_600));
    expect(focusDrawn(h)).toBe(2);
  });

  it('a walk with no window known yet (the phase message not arrived) keeps the focus on fence 1', async () => {
    const h = await hostInLobby();
    h.session().emitMessage({ type: 'class-course', course: course3, classNumber: 1 });
    h.session().emitState(snapshot({ phase: 'walk', heatIndex: 0 }));
    await settle();
    h.clock.t += 9_000;
    expect(focusShown(h)).toBe('1');
    expect(focusDrawn(h)).toBe(1);
  });
});

describe('a late joiner whose clock is not measured yet (audit K1 r2 #3)', () => {
  /** The device's own ClientClock, not measured yet, and the server's clock running 7 s ahead of the device. */
  function lateDevice(serverAheadMs = 7_000) {
    const device = { t: 50_000 };
    const clock = new ClientClock(() => device.t);
    return { device, clock, serverNow: () => device.t + serverAheadMs };
  }

  /** A clock ping as the session handles it: the ClientClock takes it first, then the game hears the message. */
  function ping(h: Harness, clock: ClientClock, serverSent: number): void {
    clock.onPing(serverSent);
    h.session().emitMessage({ type: 'clock-ping', serverSent });
  }

  /** A series of three pings 200 ms apart, as the room sends at a join (the server's clock `serverAheadMs` ahead). */
  function series(h: Harness, late: ReturnType<typeof lateDevice>, serverAheadMs = 7_000): void {
    for (let i = 0; i < 3; i += 1) {
      ping(h, late.clock, late.device.t + serverAheadMs);
      late.device.t += 200;
    }
  }

  const focusShown = (h: Harness): string => text(h.root.querySelector('[data-focus]:not([data-fence-marker])'));
  const focusDrawn = (h: Harness, now: number): number | null => {
    h.game.frame(now);
    return h.scene.frames.at(-1)?.focusFence ?? null;
  };

  it('class-phase of a walk 4 s under way while toClient is still null → fence 1 for the moment → three pings → the current fence of the server\'s window, and the last fence by the server\'s deadline', async () => {
    const late = lateDevice();
    const h = await hostInLobby({}, snapshot(), late.clock);
    const startedAt = late.serverNow() - 4_000; // the 10 s walk began 4 s before she came in
    const endsAt = startedAt + 10_000;
    h.session().emitMessage({ type: 'class-course', course: course3, classNumber: 1 });
    h.session().emitMessage(phaseMessage('walk', 0, startedAt, endsAt));
    h.session().emitState(snapshot({ phase: 'walk', heatIndex: 0 }));
    await settle();
    expect(h.root.dataset.screen).toBe('walk');
    expect(late.clock.toClient(startedAt)).toBeNull();
    expect(focusShown(h)).toBe('1'); // no clock yet: the first fence for the moment
    expect(focusDrawn(h, late.device.t)).toBe(1);
    series(h, late);
    expect(late.clock.ready()).toBe(true);
    // 4.6 s of the server's 10 s window: fence 2 of 3 — not a walk restarted at her join (that would still be fence 1).
    expect(focusShown(h)).toBe('2'); // the ping itself brought the screen up to date
    expect(focusDrawn(h, late.device.t)).toBe(2);
    late.device.t += 2_200; // 6.8 s
    expect(focusDrawn(h, late.device.t)).toBe(3);
    late.device.t = endsAt - 7_000 - 1; // the last millisecond before the server's deadline, in device time
    expect(focusDrawn(h, late.device.t)).toBe(3);
  });

  it('the window is read through the clock at every frame, never frozen at arrival: a refined offset from the next series moves the focus with it', async () => {
    const late = lateDevice(9_000); // the server is in truth 9 s ahead…
    const h = await hostInLobby({}, snapshot(), late.clock);
    series(h, late, 7_000); // …but the join series measured 7 s (a slow start of the network)
    const startedAt = late.serverNow() - 1_000;
    h.session().emitMessage({ type: 'class-course', course: course3, classNumber: 1 });
    h.session().emitMessage(phaseMessage('walk', 0, startedAt, startedAt + 6_000));
    h.session().emitState(snapshot({ phase: 'walk', heatIndex: 0 }));
    await settle();
    expect(focusDrawn(h, late.device.t)).toBe(1);
    late.device.t += 1_500; // a new series (the room measures again at every walk) finds the true 9 s
    series(h, late, 9_000);
    // 1 + 1.5 + 0.6 = 3.1 s of the server's 6 s window: fence 2 (with the offset frozen at 7 s it would read 1.1 s: fence 1).
    expect(focusDrawn(h, late.device.t)).toBe(2);
    expect(focusShown(h)).toBe('2');
  });

  it('an approach-sync that arrives before the clock is measured lights the tap zone with its take-off moment as soon as the clock can translate it', async () => {
    const late = lateDevice();
    const h = await hostInLobby({}, snapshot(), late.clock);
    startClass(h);
    await settle();
    expect(h.root.dataset.screen).toBe('round');
    const t0 = late.serverNow() + 3_000;
    h.session().emitMessage({ type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: false, approach: { fence: 1, attempt: 1, t0, speedMps: null } });
    h.game.frame(late.device.t);
    const tap = q(h.root, '[data-control="tap"]');
    expect(tap.hasAttribute('data-armed')).toBe(false); // the take-off moment is not known in device time yet
    expect(tap.hasAttribute('data-takeoff-at')).toBe(false);
    series(h, late);
    h.game.frame(late.device.t);
    expect(tap.getAttribute('data-armed')).toBe('true');
    expect(tap.getAttribute('data-takeoff-at')).toBe(String(t0 - 7_000));
  });
});

// ---- the round -----------------------------------------------------------------------------------------------

describe('the round screen', () => {
  it('phase riding → the round screen with the placeholder badge, the fence, the faults and the gear from the HUD model', async () => {
    const h = await inRound();
    expect(h.game.screen).toBe('round');
    expect(text(h.root.querySelector('[data-badge]'))).toBe('Placeholder art — not the real horses yet');
    expect(text(h.root.querySelector('[data-hud-fence]'))).toBe('Fence 1');
    expect(text(h.root.querySelector('[data-hud-faults]'))).toBe('0 faults');
    expect(text(h.root.querySelector('[data-hud-gear]'))).toBe('galope reunido');
  });

  it('the HUD time follows the round clock of the latest patch at the next frame', async () => {
    const h = await inRound();
    h.session().emitState(ridingState({ roundClockMs: 42_340 }));
    h.game.frame(h.clock.now());
    expect(text(h.root.querySelector('[data-hud-time]'))).toMatch(/^42\./);
  });

  it('a frame while riding renders the heat: the own horse marked, a chase camera', async () => {
    const h = await inRound();
    h.game.frame(h.clock.now());
    const frame = h.scene.frames[h.scene.frames.length - 1];
    expect(frame?.phase).toBe('riding');
    expect(frame?.focusFence).toBeNull();
    expect(frame?.riders.map((entry) => [entry.id, entry.isOwn]).sort()).toEqual([
      ['ana', false],
      ['host', true],
    ]);
    expect(frame?.camera).not.toBeNull();
  });

  it('the four controls are placed by the phone layout of 844×390: each one exactly at its zone of layoutFor', async () => {
    const h = await inRound();
    expectPlaced(h, layoutFor(844, 390));
    const gear = q(h.root, '[data-control="gear"]');
    expect(gear.style.left).toBe(`${String(844 - 78 - 8)}px`);
    expect(gear.style.top).toBe(`${String(390 - 78 - 8)}px`);
    expect(gear.style.width).toBe('78px');
    expect(gear.style.height).toBe('78px');
  });

  it('the rotate overlay is hidden in landscape, shown after a resize to portrait, hidden again after turning back', async () => {
    const h = await inRound();
    const rotate = q(h.root, '[data-rotate]');
    expect(rotate.hasAttribute('hidden')).toBe(true);
    h.arena.width = 390;
    h.arena.height = 844;
    h.game.resize();
    expect(rotate.hasAttribute('hidden')).toBe(false);
    expect(text(rotate)).toBe('Turn your phone sideways');
    h.arena.width = 844;
    h.arena.height = 390;
    h.game.resize();
    expect(rotate.hasAttribute('hidden')).toBe(true);
  });

  it('a window resize event re-measures the arena and re-places the controls', async () => {
    const h = await inRound();
    h.arena.width = 667;
    h.arena.height = 375;
    h.win.fire('resize');
    const gear = q(h.root, '[data-control="gear"]');
    expect(gear.style.left).toBe(`${String(667 - 76 - 8)}px`);
    expect(gear.style.width).toBe('76px');
  });

  it('the controls live in the arena, not the viewport: with the arena inset by the safe area (left 44, 756×369) they are placed in arena coordinates', async () => {
    const h = await inRound();
    Object.assign(h.arena, { left: 44, top: 0, width: 756, height: 369 });
    h.game.resize();
    expectPlaced(h, layoutFor(756, 369));
    const gear = q(h.root, '[data-control="gear"]');
    expect(gear.style.left).toBe(`${String(756 - 76 - 8)}px`); // 672: inside the 756 px wide arena, not 844 − …
    expect(gear.style.top).toBe(`${String(369 - 76 - 8)}px`); // 285
    expect(gear.style.width).toBe('76px');
    expect(q(h.root, '[data-control="turn-left"]').style.left).toBe('0px');
  });

  it('when the browser bars appear (the arena shrinks to 756×320) resize() keeps the 2 cm pace square and moves it up; no control overlaps it', async () => {
    const h = await inRound();
    Object.assign(h.arena, { left: 44, top: 0, width: 756, height: 320 });
    h.game.resize();
    expectPlaced(h, layoutFor(756, 320));
    const gear = q(h.root, '[data-control="gear"]');
    expect(gear.style.top).toBe(`${String(320 - 76 - 8)}px`); // 236
    expect(gear.style.height).toBe('76px');
  });
});

describe('pointer presses on the arena', () => {
  it('a press in the tap zone during the open approach sends the take-off tap stamped with the device clock for fence 1, attempt 1', async () => {
    const h = await inApproach();
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: h.clock.now(), fence: 1, attempt: 1 }]);
  });

  it('a second press in the tap zone during the same approach sends nothing', async () => {
    const h = await inApproach();
    press(h, TAP);
    h.clock.t += 50;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toHaveLength(1);
  });

  it('a press in the tap zone before the first approach sends nothing and spends nothing: the tap of the approach that follows goes out (audit K1 r1 #1)', async () => {
    const h = await inRound();
    press(h, TAP);
    h.clock.t += 500;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([]);
    approachOwn(h);
    h.clock.t += 1_000;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: h.clock.now(), fence: 1, attempt: 1 }]);
  });

  it('fence 1 cleared → an early press during the flight, when the state already names fence 2, sends nothing → the approach of fence 2 arms the tap and it goes out for fence 2, attempt 1 (audit K1 r1 #1)', async () => {
    const h = await inApproach();
    h.clock.t += 1_000;
    press(h, TAP);
    const first = { type: 'tap' as const, clientTime: h.clock.now(), fence: 1, attempt: 1 };
    expect(h.session().sentOf('tap')).toEqual([first]);
    // The verdict: cleared. The server names fence 2 from the decision on; the horse lands 600 ms later.
    h.clock.t += 60;
    h.session().emitMessage(roundEvent({ type: 'takeoff', riderId: 'host', fence: 1, attempt: 1, decidedAt: h.clock.now(), offsetMs: 0, outcome: clean, approach: approach70 }));
    h.session().emitState(ridingState({ riders: { host: rider('host', { nextFence: 2, positionM: 30 }), ana: rider('ana') } }));
    h.clock.t += 200;
    press(h, TAP); // an eager finger during the flight: with the old controller this spent the tap of fence 2
    h.clock.t += 200;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([first]);
    expect(q(h.root, '[data-control="tap"]').hasAttribute('data-armed')).toBe(false);
    // The approach of fence 2 opens: the finger at its t0 is the tap the server accepts.
    h.clock.t += 4_000;
    approachOwn(h, 2, 1, h.clock.now() + 1_000);
    h.game.frame(h.clock.now());
    expect(q(h.root, '[data-control="tap"]').getAttribute('data-armed')).toBe('true');
    h.clock.t += 1_000;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([first, { type: 'tap', clientTime: h.clock.now(), fence: 2, attempt: 1 }]);
  });

  it('a press on the pace square cycles the gear to extended and the HUD shows it', async () => {
    const h = await inRound();
    press(h, GEAR);
    expect(h.session().sentOf('gear')).toEqual([{ type: 'gear', gear: 'extended' }]);
    h.game.frame(h.clock.now());
    expect(text(h.root.querySelector('[data-hud-gear]'))).toBe('galope largo');
  });

  it('a press on the left edge outside a turn window shifts the line to the angle', async () => {
    const h = await inRound();
    press(h, TURN_LEFT);
    expect(h.session().sentOf('line')).toEqual([{ type: 'line', line: 'angle' }]);
    expect(h.session().sentOf('turn')).toEqual([]);
  });

  it('after a turn-ahead for the own rider a press on the left edge is a left turn with the device time', async () => {
    const h = await inRound();
    h.session().emitMessage(roundEvent({ type: 'turn-ahead', riderId: 'host', distanceM: 45, at: h.clock.now() }));
    h.clock.t += 500;
    press(h, TURN_LEFT);
    expect(h.session().sentOf('turn')).toEqual([{ type: 'turn', choice: 'left', clientTime: h.clock.now() }]);
    expect(h.session().sentOf('line')).toEqual([]);
  });

  it("another rider's turn-ahead opens no window: the press is still a line shift", async () => {
    const h = await inRound();
    h.session().emitMessage(roundEvent({ type: 'turn-ahead', riderId: 'ana', distanceM: 45, at: h.clock.now() }));
    press(h, TURN_LEFT);
    expect(h.session().sentOf('turn')).toEqual([]);
    expect(h.session().sentOf('line')).toEqual([{ type: 'line', line: 'angle' }]);
  });

  it('a press outside every zone sends nothing', async () => {
    const h = await inRound();
    press(h, [300, 195]);
    expect(h.session().sent).toEqual([]);
  });

  it('a finger is translated by the arena origin on both axes: points that hit the displayed gear only after the translation send the gear, points that would hit it only untranslated send nothing', async () => {
    const h = await inRound();
    const origin = { left: 44, top: 30 };
    Object.assign(h.arena, { ...origin, width: 756, height: 369 });
    h.game.resize();
    const layout = layoutFor(756, 369);
    const gear = layout.zones.gear; // arena-local; the pace square keeps its corner whatever else the layout does
    const client = ([x, y]: [number, number]): [number, number] => [x + origin.left, y + origin.top];
    // Client points inside the displayed square only untranslated: their arena-local point (30 px up, 44 px left)
    // is in no zone — found in the layout itself, so the check holds for any geometry of the other controls.
    const strays: [number, number][] = [];
    for (let y = gear.y + 1; y < gear.y + gear.h && strays.length < 2; y += 3) {
      for (let x = gear.x + 1; x < gear.x + gear.w && strays.length < 2; x += 3) {
        if (hitTest(layout, x - origin.left, y - origin.top) === null) strays.push([x, y]);
      }
    }
    expect(strays.length, 'client points inside the untranslated square whose local point is in no zone').toBe(2);
    for (const point of strays) press(h, point);
    expect(h.session().sent).toEqual([]);
    // Local points inside the square near its right and bottom edges: untranslated they would be right of / below it.
    press(h, client([gear.x + gear.w - 4, gear.y + gear.h / 2]));
    press(h, client([gear.x + gear.w / 2, gear.y + gear.h - 4]));
    expect(h.session().sentOf('gear')).toEqual([
      { type: 'gear', gear: 'extended' },
      { type: 'gear', gear: 'gallop' },
    ]);
    // A finger on the safe-area inset, outside the arena, is nothing.
    press(h, [10, 195]);
    press(h, [500, 20]);
    expect(h.session().sent).toHaveLength(2);
    // The tap zone near its top-right corner, translated: untranslated it would be right of the zone.
    const tap = layout.zones.tap;
    approachOwn(h);
    press(h, client([tap.x + tap.w - 14, tap.y + 5]));
    expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: h.clock.now(), fence: 1, attempt: 1 }]);
  });

  it('in portrait (the rotate overlay up) a finger on any hidden zone sends nothing and spends nothing; back in landscape the controls work again (audit K1 r1 #7)', async () => {
    const h = await inApproach();
    h.arena.width = 390;
    h.arena.height = 844;
    h.game.resize();
    expect(q(h.root, '[data-rotate]').hasAttribute('hidden')).toBe(false);
    // The zones the portrait layout (390×844, phone) would compute: tap x 195..320 y 127..633, gear x 213..382
    // y 667..836, left x 0..70 and right x 320..390 at y 211..633 — every one of them is covered by the overlay.
    h.clock.t += 1_000;
    for (const point of [[257, 380], [297, 751], [35, 400], [355, 400]] as [number, number][]) press(h, point);
    expect(h.session().sent).toEqual([]);
    h.arena.width = 844;
    h.arena.height = 390;
    h.game.resize();
    expect(q(h.root, '[data-rotate]').hasAttribute('hidden')).toBe(true);
    press(h, TAP);
    press(h, GEAR);
    expect(h.session().sent).toEqual([
      { type: 'tap', clientTime: h.clock.now(), fence: 1, attempt: 1 },
      { type: 'gear', gear: 'extended' },
    ]);
  });

  it('presses during the course walk send nothing', async () => {
    const h = await inWalk();
    press(h, TAP);
    press(h, GEAR);
    press(h, TURN_LEFT);
    expect(h.session().sent).toEqual([]);
  });

  it("a new class starts the other horses from the line: the scene never gets last class's positions", async () => {
    const h = await inRound();
    // Class 1: Ana gallops away — three patches, then a frame draws her near 30 m (100 ms behind the newest patch).
    for (const [roundClockMs, positionM] of [[4_000, 20], [5_000, 25], [6_000, 30]] as const) {
      h.clock.t += 1_000;
      h.session().emitState(ridingState({ roundClockMs, riders: { host: rider('host'), ana: rider('ana', { positionM }) } }));
    }
    h.game.frame(h.clock.now());
    const before = h.scene.frames.at(-1)?.riders.find((entry) => entry.id === 'ana');
    expect(before?.point.x).toBeGreaterThan(24);
    expect(before?.point.x).toBeLessThan(31);

    await inResults(h);
    h.clock.t += 60_000;
    startClass(h, 2); // the new class: roundClockMs 5_000, every horse at 0 m
    h.game.frame(h.clock.now());
    const after = h.scene.frames.at(-1)?.riders.find((entry) => entry.id === 'ana');
    expect(after?.point.x).toBeLessThan(5); // from the new class's samples only, not interpolated from 30 m
  });

  it('a new class re-creates the round modules: the tap for fence 1, attempt 1 goes out again', async () => {
    const h = await inApproach();
    press(h, TAP);
    expect(h.session().sentOf('tap')).toHaveLength(1);
    await inResults(h);
    h.clock.t += 60_000;
    startClass(h, 2);
    await settle();
    expect(h.root.dataset.screen).toBe('round');
    approachOwn(h);
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([
      { type: 'tap', clientTime: 10_000, fence: 1, attempt: 1 },
      { type: 'tap', clientTime: 70_000, fence: 1, attempt: 1 },
    ]);
  });
});

describe('the moment of a press is the moment of the touch, not of its handling (audit K1 r3 #4)', () => {
  it('a tap handled 130 ms after the touch: clientTime is the event time, and the instant hint judges that moment', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0);
    h.clock.t = t0 + 150; // the main thread was busy: the handler runs 130 ms after the finger landed
    press(h, TAP, t0 + 20);
    expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: t0 + 20, fence: 1, attempt: 1 }]);
    h.game.frame(h.clock.now());
    expect(text(h.root.querySelector('[data-hud-caption]'))).toBe('Dakota: perfecta at fence 1!'); // +20, never +150
  });

  it('a turn handled late: clientTime is the event time (also for the turn window)', async () => {
    const h = await inRound();
    h.session().emitMessage(roundEvent({ type: 'turn-ahead', riderId: 'host', distanceM: 45, at: h.clock.now() }));
    const touch = h.clock.now() + 3_400; // inside the 3.5 s window
    h.clock.t = touch + 200; // handled after the window closed: the touch decides, it is still a turn
    press(h, TURN_LEFT, touch);
    expect(h.session().sentOf('turn')).toEqual([{ type: 'turn', choice: 'left', clientTime: touch }]);
    expect(h.session().sentOf('line')).toEqual([]);
  });

  it('a timeStamp that cannot be a moment of this clock falls back to the clock at handling: not finite, later than now, at or before its origin', async () => {
    for (const stamp of [Number.NaN, Number.POSITIVE_INFINITY, 1_700_000_000_000, 0, -5]) {
      const h = await inRound();
      const t0 = h.clock.now() + 1_000;
      approachOwn(h, 1, 1, t0);
      h.clock.t = t0 + 10;
      press(h, TAP, stamp);
      expect(h.session().sentOf('tap'), String(stamp)).toEqual([{ type: 'tap', clientTime: t0 + 10, fence: 1, attempt: 1 }]);
      h.game.frame(h.clock.now());
      expect(text(h.root.querySelector('[data-hud-caption]'))).toBe('Dakota: perfecta at fence 1!');
      h.game.destroy();
    }
  });

  it('a turn with an implausible timeStamp falls back to the clock: outside the window it is a line shift', async () => {
    const h = await inRound();
    h.session().emitMessage(roundEvent({ type: 'turn-ahead', riderId: 'host', distanceM: 45, at: h.clock.now() }));
    h.clock.t += 3_600; // the window is over at handling
    press(h, TURN_LEFT, h.clock.now() + 50); // a stamp from the future is not the touch
    expect(h.session().sentOf('turn')).toEqual([]);
    expect(h.session().sentOf('line')).toEqual([{ type: 'line', line: 'angle' }]);
  });

  it('pressTime: the event time when it is a moment of the clock (finite, after its origin, not later than now), however old; otherwise now', () => {
    expect(pressTime(9_880, 10_000).time).toBe(9_880);
    expect(pressTime(10_000, 10_000).time).toBe(10_000);
    expect(pressTime(9_000, 10_000).time).toBe(9_000);
    expect(pressTime(8_500, 10_000).time).toBe(8_500); // old, but the touch: never replaced by the handling (audit K1 r4 #1)
    expect(pressTime(1, 10_000).time).toBe(1);
    expect(pressTime(10_001, 10_000).time).toBe(10_000);
    expect(pressTime(0, 10_000).time).toBe(10_000);
    expect(pressTime(-5, 10_000).time).toBe(10_000);
    expect(pressTime(Number.NaN, 10_000).time).toBe(10_000);
    expect(pressTime(Number.NEGATIVE_INFINITY, 10_000).time).toBe(10_000);
  });
});

describe('pressTime says where the moment came from (K1.1 step 2)', () => {
  it("source 'event' with no reason for a correct stamp of any age: just now, 120 ms, 1.5 s old, the first millisecond of the clock", () => {
    for (const stamp of [10_000, 9_880, 8_500, 1]) {
      expect(pressTime(stamp, 10_000), String(stamp)).toEqual({ time: stamp, source: 'event', reason: null });
    }
  });

  it("source 'fallback' with 'not-finite' for NaN and both infinities: the moment is now", () => {
    for (const stamp of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(pressTime(stamp, 10_000), String(stamp)).toEqual({ time: 10_000, source: 'fallback', reason: 'not-finite' });
    }
  });

  it("source 'fallback' with 'non-positive' for 0 and a negative stamp", () => {
    expect(pressTime(0, 10_000)).toEqual({ time: 10_000, source: 'fallback', reason: 'non-positive' });
    expect(pressTime(-5, 10_000)).toEqual({ time: 10_000, source: 'fallback', reason: 'non-positive' });
  });

  it("source 'fallback' with 'later-than-now' for a stamp 1 ms after now and for an epoch stamp of another base", () => {
    expect(pressTime(10_001, 10_000)).toEqual({ time: 10_000, source: 'fallback', reason: 'later-than-now' });
    expect(pressTime(1_700_000_000_000, 10_000)).toEqual({ time: 10_000, source: 'fallback', reason: 'later-than-now' });
  });

  it('negative: an old stamp is never a fallback, and the rule that picks the moment is the K1 one', () => {
    const old = pressTime(2_000, 10_000);
    expect(old.source).toBe('event');
    expect(old.reason).toBeNull();
    expect(old.time).toBe(2_000);
  });
});

describe('the turn window opens when the turn-ahead is handled: a finger before it is no turn (audit K1 r5 #2)', () => {
  it('a finger 10 ms before the turn-ahead, handled 20 ms after it (30 ms old): a line shift that spends no turn — the deliberate right turn that follows is the turn', async () => {
    const h = await inRound();
    const opened = h.clock.now();
    h.session().emitMessage(roundEvent({ type: 'turn-ahead', riderId: 'host', distanceM: 45, at: opened }));
    h.clock.t = opened + 20;
    press(h, TURN_LEFT, opened - 10); // meant as a line shift before the turn: never the 'wrong' turn of the judge
    expect(h.session().sentOf('line')).toEqual([{ type: 'line', line: 'angle' }]);
    expect(h.session().sentOf('turn')).toEqual([]);
    h.clock.t = opened + 410;
    press(h, TURN_RIGHT, opened + 400);
    expect(h.session().sentOf('turn')).toEqual([{ type: 'turn', choice: 'right', clientTime: opened + 400 }]);
    expect(h.session().sentOf('line')).toEqual([{ type: 'line', line: 'angle' }]);
  });

  it('a finger at the very moment the turn-ahead was handled is inside the window: the turn', async () => {
    const h = await inRound();
    const opened = h.clock.now();
    h.session().emitMessage(roundEvent({ type: 'turn-ahead', riderId: 'host', distanceM: 45, at: opened }));
    h.clock.t = opened + 30;
    press(h, TURN_RIGHT, opened);
    expect(h.session().sentOf('turn')).toEqual([{ type: 'turn', choice: 'right', clientTime: opened }]);
    expect(h.session().sentOf('line')).toEqual([]);
  });
});

describe('a touch too old for the judge when it is handled is not sent (audit K1 r4 #1)', () => {
  const caption = (h: Harness): string => text(h.root.querySelector('[data-hud-caption]'));
  const armed = (h: Harness): string | null => q(h.root, '[data-control="tap"]').getAttribute('data-armed');

  it('t0 = 10 s on the clock: a touch at 8.5 s handled at 10.02 s sends no tap and shows no hint; the timely tap that follows goes out with its own time and is the perfecta', async () => {
    for (const touchAge of [1_520, PACKET.maxAgeMs + 1]) {
      const h = await inRound();
      const t0 = h.clock.now() + 1_000;
      approachOwn(h, 1, 1, t0);
      h.game.frame(h.clock.now());
      const before = caption(h);
      h.clock.t = t0 + 20; // the main thread was busy: the handler runs long after the finger landed
      press(h, TAP, h.clock.now() - touchAge);
      expect(h.session().sentOf('tap'), String(touchAge)).toEqual([]);
      h.game.frame(h.clock.now());
      expect(caption(h)).toBe(before);
      expect(armed(h)).toBe('true'); // nothing was spent: the zone is still lit for this attempt
      h.clock.t = t0 + 40;
      press(h, TAP, t0 + 30);
      expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: t0 + 30, fence: 1, attempt: 1 }]);
      h.game.frame(h.clock.now());
      expect(caption(h)).toBe('Dakota: perfecta at fence 1!');
      h.game.destroy();
    }
  });

  it('a touch exactly PACKET.maxAgeMs old when handled still goes out, with the moment of the touch', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0);
    h.clock.t = t0 + 20 + PACKET.maxAgeMs;
    press(h, TAP, t0 + 20);
    expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: t0 + 20, fence: 1, attempt: 1 }]);
  });

  it('a turn press too old for the judge sends neither a turn nor a line shift, and the timely press is still the turn', async () => {
    const h = await inRound();
    h.session().emitMessage(roundEvent({ type: 'turn-ahead', riderId: 'host', distanceM: 45, at: h.clock.now() }));
    const touch = h.clock.now() + 1_000;
    h.clock.t = touch + PACKET.maxAgeMs + 1;
    press(h, TURN_LEFT, touch);
    expect(h.session().sentOf('turn')).toEqual([]);
    expect(h.session().sentOf('line')).toEqual([]);
    h.clock.t += 20;
    press(h, TURN_RIGHT, h.clock.now() - 10);
    expect(h.session().sentOf('turn')).toEqual([{ type: 'turn', choice: 'right', clientTime: h.clock.now() - 10 }]);
    expect(h.session().sentOf('line')).toEqual([]);
  });

  it('the gear and a line shift carry no time: an old touch on them still goes out', async () => {
    const h = await inRound();
    h.clock.t += 5_000;
    press(h, GEAR, h.clock.now() - 2_000);
    press(h, TURN_LEFT, h.clock.now() - 2_000);
    expect(h.session().sentOf('gear')).toEqual([{ type: 'gear', gear: 'extended' }]);
    expect(h.session().sentOf('line')).toEqual([{ type: 'line', line: 'angle' }]);
  });
});

describe('the caption', () => {
  it('a tap at t0 shows the instant hint at once; the server verdict then replaces it', async () => {
    const h = await inRound();
    h.session().emitMessage(roundEvent({ type: 'approach', riderId: 'host', fence: 1, attempt: 1, t0: h.clock.now() + 100, speedMps: null }));
    h.clock.t += 100;
    press(h, TAP);
    h.game.frame(h.clock.now());
    expect(text(h.root.querySelector('[data-hud-caption]'))).toBe('Dakota: perfecta at fence 1!');

    h.clock.t += 50;
    h.session().emitMessage(
      roundEvent({ type: 'takeoff', riderId: 'host', fence: 1, attempt: 1, decidedAt: h.clock.now(), offsetMs: 0, outcome: chip, approach: approach70 }),
    );
    h.game.frame(h.clock.now());
    expect(text(h.root.querySelector('[data-hud-caption]'))).toBe('Dakota: batida corta at fence 1 — derribo');
  });

  it('the tap control is armed with the device time of the take-off from the approach until the verdict', async () => {
    const h = await inRound();
    const tap = q(h.root, '[data-control="tap"]');
    expect(tap.hasAttribute('data-armed')).toBe(false);
    h.session().emitMessage(roundEvent({ type: 'approach', riderId: 'host', fence: 1, attempt: 1, t0: h.clock.now() + 1_200, speedMps: null }));
    h.game.frame(h.clock.now());
    expect(tap.getAttribute('data-armed')).toBe('true');
    expect(tap.getAttribute('data-takeoff-at')).toBe(String(h.clock.now() + 1_200)); // offset 0: server time is device time
    h.session().emitMessage(roundEvent({ type: 'approach', riderId: 'ana', fence: 1, attempt: 1, t0: h.clock.now() + 900, speedMps: null }));
    h.game.frame(h.clock.now());
    expect(tap.getAttribute('data-takeoff-at')).toBe(String(h.clock.now() + 1_200)); // another rider's approach changes nothing
    h.clock.t += 1_250;
    h.session().emitMessage(
      roundEvent({ type: 'takeoff', riderId: 'host', fence: 1, attempt: 1, decidedAt: h.clock.now(), offsetMs: null, outcome: chip, approach: approach70 }),
    );
    h.game.frame(h.clock.now());
    expect(tap.hasAttribute('data-armed')).toBe(false);
    expect(tap.hasAttribute('data-takeoff-at')).toBe(false);
  });

  it("another rider's take-off is captioned with her name and the 'yegua' default", async () => {
    const h = await inRound();
    h.session().emitMessage(
      roundEvent({ type: 'takeoff', riderId: 'ana', fence: 1, attempt: 1, decidedAt: h.clock.now(), offsetMs: null, outcome: { kind: 'refusal', faults: 0, cleared: false, label: 'rehuse', horseJumped: false }, approach: approach70 }),
    );
    h.game.frame(h.clock.now());
    expect(text(h.root.querySelector('[data-hud-caption]'))).toBe("Luna: rehúse at fence 1 — she's fine");
  });
});

// ---- results -------------------------------------------------------------------------------------------------

describe('the results screen', () => {
  it('class-table + phase done → one table per class with a row per rider: names and times', async () => {
    const h = await inRound();
    await inResults(h);
    expect(h.game.screen).toBe('results');
    const seventy = q(h.root, '[data-list="results"] [data-class="70"]');
    const ana = text(seventy.querySelector('tr[data-id="ana"]'));
    expect(ana).toContain('Ana on Luna');
    expect(ana).toContain('55.2');
    const host = text(seventy.querySelector('tr[data-id="host"]'));
    expect(host).toContain('Maria on Dakota');
    expect(host).toContain('1:00.1');
  });

  it('"again" is the host\'s and sends start-class', async () => {
    const h = await inRound();
    await inResults(h);
    click(h.root, '[data-action="again"]');
    expect(h.session().sentOf('start-class')).toEqual([{ type: 'start-class', order: 'random' }]);
  });

  it('a guest has no "again" button', async () => {
    const h = await guestInLobby();
    startClass(h, 1, true);
    await settle();
    await inResults(h, true);
    expect(h.root.querySelector('[data-action="again"]')).toBeNull();
    expect(h.root.querySelector('[data-list="results"] tr[data-id="host"]')).not.toBeNull();
  });

  it('leave → session.leave() → home', async () => {
    const h = await inRound();
    await inResults(h);
    click(h.root, '[data-action="leave"]');
    await settle();
    expect(h.session().leaves).toBe(1);
    expect(h.root.dataset.screen).toBe('home');
  });
});

describe('between the heats and at the end (audit K1 r1 #2)', () => {
  /** Heat 1 is over: Maria finished with a rail, Ana was eliminated; the state still carries the heat's riders. */
  /** Heat 1 just ended and another heat follows (the server's nextHeat), unless `over` says otherwise. */
  const heatOver = (over: Partial<LobbyStateSnapshot> = {}): LobbyStateSnapshot =>
    snapshot({
      phase: 'results',
      heatIndex: 0,
      nextHeat: true,
      roundClockMs: 61_000,
      riders: {
        host: rider('host', { nextFence: 2, positionM: 50, faults: 4, status: 'finished', lastLabel: 'batida_corta' }),
        ana: rider('ana', { faults: 8, status: 'eliminated', lastLabel: 'rehuse' }),
      },
      ...over,
    });

  it('riding → results with no class-table yet: the results screen shows the heat that just ended (every rider, faults, how it went) and a leave button, never an empty page', async () => {
    const h = await inRound();
    h.session().emitState(heatOver());
    await settle();
    expect(h.root.dataset.screen).toBe('results');
    expect(h.root.innerHTML.trim()).not.toBe('');
    const heat = q(h.root, '[data-list="heat"]');
    expect(text(heat.querySelector('[data-id="host"]'))).toContain('Maria on Dakota');
    expect(text(heat.querySelector('[data-id="host"]'))).toContain('4');
    expect(text(heat.querySelector('[data-id="host"]'))).toContain('Finished');
    expect(text(heat.querySelector('[data-id="ana"]'))).toContain('Ana on Luna');
    expect(text(heat.querySelector('[data-id="ana"]'))).toContain('eliminada');
    expect(text(h.root.querySelector('[data-heat-done]'))).toBe('manga 1 finished');
    expect(text(h.root.querySelector('[data-waiting]'))).toBe('The next manga starts in a moment…');
    expect(h.root.querySelector('[data-list="results"]')).toBeNull(); // no class table yet
    expect(h.root.querySelector('[data-action="leave"]')).not.toBeNull();
    expect(h.root.querySelector('[data-action="again"]')).toBeNull(); // the class is still running
  });

  it('results → the next heat\'s walk: the walk screen comes back for heat 2', async () => {
    const h = await inRound();
    h.session().emitState(heatOver());
    await settle();
    h.session().emitState(snapshot({ phase: 'walk', heatIndex: 1 }));
    await settle();
    expect(h.root.dataset.screen).toBe('walk');
    expect(h.root.querySelector('[data-list="fences"]')).not.toBeNull();
  });

  it('results → done before the class-table arrives: the waiting text says the class is finished; the table then replaces it', async () => {
    const h = await inRound();
    h.session().emitState(heatOver());
    await settle();
    h.session().emitState(heatOver({ phase: 'done' }));
    await settle();
    expect(h.root.dataset.screen).toBe('results');
    expect(text(h.root.querySelector('[data-waiting]'))).toBe('Class finished — the results are coming…');
    expect(h.root.querySelector('[data-list="heat"]')).not.toBeNull();
    h.session().emitMessage({ type: 'class-table', table });
    await settle();
    expect(h.root.querySelector('[data-waiting]')).toBeNull();
    expect(h.root.querySelector('[data-list="heat"]')).toBeNull();
    expect(h.root.querySelector('[data-list="results"] [data-class="70"] tr[data-id="ana"]')).not.toBeNull();
    expect(h.root.querySelector('[data-action="again"]')).not.toBeNull();
  });

  it('the leave button of the intermediate results works: session.leave() → home', async () => {
    const h = await inRound();
    h.session().emitState(heatOver());
    await settle();
    click(h.root, '[data-action="leave"]');
    await settle();
    expect(h.session().leaves).toBe(1);
    expect(h.root.dataset.screen).toBe('home');
  });

  it('a late joiner into a finished class: the state says done, then class-course arrives, then class-table — the screen is never empty and ends on the table', async () => {
    const h = await boot({
      script: { knock: [ok<JoinDecision>({ status: 'admitted' })], roomStatus: [ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' })] },
      stateOnConnect: guestSnapshot({ phase: 'done', heatIndex: 0, riders: {} }),
    });
    await ring(h, 'ABCDEF');
    expect(h.root.dataset.screen).toBe('results');
    expect(h.root.innerHTML.trim()).not.toBe('');
    expect(text(h.root.querySelector('[data-waiting]'))).toBe('Class finished — the results are coming…');
    h.session().emitMessage({ type: 'class-course', course, classNumber: 1 });
    await settle();
    expect(h.root.dataset.screen).toBe('results');
    expect(h.root.querySelector('[data-waiting]')).not.toBeNull();
    expect(h.scene.courses.at(-1)).toEqual(course);
    h.session().emitMessage({ type: 'class-table', table });
    await settle();
    expect(h.root.dataset.screen).toBe('results');
    expect(h.root.querySelector('[data-waiting]')).toBeNull();
    expect(h.root.querySelector('[data-list="results"] tr[data-id="host"]')).not.toBeNull();
    expect(h.root.querySelector('[data-action="again"]')).toBeNull(); // a guest
  });

  it('the results of the LAST heat (the server says no heat follows): the waiting text says the class is finished, never "the next manga", in both locales (audit K1 r3 #6)', async () => {
    const h = await inRound();
    h.session().emitState(heatOver({ nextHeat: false }));
    await settle();
    expect(h.root.dataset.screen).toBe('results');
    expect(h.root.querySelector('[data-list="heat"] [data-id="host"]')).not.toBeNull();
    expect(text(h.root.querySelector('[data-waiting]'))).toBe('Class finished — the results are coming…');
    click(h.root, '[data-action="locale"][data-locale="es"]');
    expect(text(h.root.querySelector('[data-waiting]'))).toBe('Prueba terminada — ya llegan los resultados…');
  });

  it('a rider of the next heat leaves during the results: the server turns nextHeat off and the waiting text follows (audit K1 r3 #6)', async () => {
    const h = await inRound();
    h.session().emitState(heatOver());
    await settle();
    expect(text(h.root.querySelector('[data-waiting]'))).toBe('The next manga starts in a moment…');
    h.session().emitState(heatOver({ nextHeat: false }));
    await settle();
    expect(text(h.root.querySelector('[data-waiting]'))).toBe('Class finished — the results are coming…');
  });

  it('the intermediate results are in the locale: Spanish', async () => {
    const h = await inRound();
    h.session().emitState(heatOver());
    await settle();
    click(h.root, '[data-action="locale"][data-locale="es"]');
    expect(text(h.root.querySelector('[data-heat-done]'))).toBe('manga 1 terminada');
    expect(text(h.root.querySelector('[data-waiting]'))).toBe('La siguiente manga empieza enseguida…');
    expect(text(h.root.querySelector('[data-list="heat"] [data-id="host"]'))).toContain('Maria con Dakota');
  });
});

// ---- lifecycle ------------------------------------------------------------------------------------------------

describe('taking control back (audit K1 r2 #1)', () => {
  /** The server's 'approach-sync' for the own horse: the approach open now (server time = device time here), or none. */
  const approachSync = (approach: { fence: number; attempt: number; t0: number; speedMps?: number | null } | null, classNumber = 1, heatIndex = 0, hardTurn = false): ServerMessage => ({
    type: 'approach-sync',
    classNumber,
    heatIndex,
    hardTurn,
    approach: approach === null ? null : { speedMps: null, ...approach },
  });
  const tapControl = (h: Harness) => q(h.root, '[data-control="tap"]');

  it('the SDK recovered after the approach opened while she was away: approach-sync lights the tap zone with its take-off moment and her press sends the tap of that approach', async () => {
    const h = await inRound();
    h.session().emitStatus('dropped');
    await settle();
    h.clock.t += 1_500; // the approach opened in this second; its broadcast went to the connections alive then
    h.session().emitStatus('connected');
    h.session().emitState(ridingState({ riders: { host: rider('host', { positionM: 19 }), ana: rider('ana') } }));
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([]); // nothing to arm from the state alone
    const t0 = h.clock.now() + 1_500;
    h.session().emitMessage(approachSync({ fence: 1, attempt: 1, t0 }));
    h.game.frame(h.clock.now());
    expect(tapControl(h).getAttribute('data-armed')).toBe('true');
    expect(tapControl(h).getAttribute('data-takeoff-at')).toBe(String(t0));
    h.clock.t = t0 + 100;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: t0 + 100, fence: 1, attempt: 1 }]);
    expect(text(h.root.querySelector('[data-hud-caption]'))).not.toBe(''); // the instant hint judged it against that t0
  });

  it('a fresh join through Reconnect: the new round modules get class-course and the running heat, then approach-sync arms them, and her press goes out on the new session', async () => {
    const h = await hostInLobby({ roomStatus: [ok<RoomStatusReply>({ status: 'host', roomId: 'r1' })] });
    startClass(h);
    await settle();
    h.session().endWith({ kind: 'lost', code: 1006 });
    await settle();
    h.settings.stateOnConnect = ridingState({ riders: { host: rider('host', { positionM: 20 }), ana: rider('ana') } });
    click(h.root, '[data-action="reconnect"]');
    await settle();
    const fresh = h.session();
    expect(h.sessions).toHaveLength(2);
    fresh.emitMessage({ type: 'class-course', course, classNumber: 1 });
    fresh.emitMessage(phaseMessage('riding', 0, 0, null));
    const t0 = h.clock.now() + 2_000;
    fresh.emitMessage(approachSync({ fence: 1, attempt: 1, t0 }));
    await settle();
    expect(h.root.dataset.screen).toBe('round');
    h.game.frame(h.clock.now());
    expect(tapControl(h).getAttribute('data-armed')).toBe('true');
    h.clock.t = t0 + 100;
    press(h, TAP);
    expect(fresh.sentOf('tap')).toEqual([{ type: 'tap', clientTime: t0 + 100, fence: 1, attempt: 1 }]);
    expect(h.sessions[0]?.sentOf('tap')).toEqual([]);
  });

  it('approach-sync with no approach open removes an arming whose verdict was missed: the zone goes dark and a press sends nothing', async () => {
    const h = await inApproach();
    h.session().emitStatus('dropped');
    h.clock.t += 2_000; // the autopilot decided while she was away
    h.session().emitStatus('connected');
    h.session().emitState(ridingState({ riders: { host: rider('host', { nextFence: 2, positionM: 33 }), ana: rider('ana') } }));
    h.session().emitMessage(approachSync(null));
    h.game.frame(h.clock.now());
    expect(tapControl(h).hasAttribute('data-armed')).toBe(false);
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([]);
  });

  it('the attempt whose tap already went out is not armed again by a sync of the same attempt', async () => {
    const h = await inApproach();
    h.clock.t += 1_000;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toHaveLength(1);
    h.session().emitStatus('dropped');
    h.session().emitStatus('connected');
    h.session().emitMessage(approachSync({ fence: 1, attempt: 1, t0: h.clock.now() }));
    h.clock.t += 50;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toHaveLength(1);
  });

  it('a press while the session is dropped spends nothing and shows no hint: back before t0, the approach-sync of the same approach arms the tap and her press goes out (audit K1 r3 #1)', async () => {
    const h = await inApproach();
    const caption = text(h.root.querySelector('[data-hud-caption]'));
    h.session().emitStatus('dropped');
    h.clock.t += 300;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([]);
    expect(text(h.root.querySelector('[data-hud-caption]'))).toBe(caption); // no instant hint for a tap that never left
    h.clock.t += 400;
    h.session().emitStatus('connected');
    const t0 = h.clock.now() + 1_000;
    h.session().emitMessage(approachSync({ fence: 1, attempt: 1, t0 }));
    h.game.frame(h.clock.now());
    expect(tapControl(h).getAttribute('data-armed')).toBe('true');
    h.clock.t = t0 + 20;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: t0 + 20, fence: 1, attempt: 1 }]);
    expect(text(h.root.querySelector('[data-hud-caption]'))).not.toBe(caption);
  });

  it('an approach-sync of another class or another heat than the one on screen changes nothing', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    h.session().emitMessage(approachSync({ fence: 1, attempt: 1, t0 }, 2, 0));
    h.session().emitMessage(approachSync({ fence: 1, attempt: 1, t0 }, 1, 1));
    h.game.frame(h.clock.now());
    expect(tapControl(h).hasAttribute('data-armed')).toBe(false);
    h.clock.t = t0;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([]);
  });
});

describe('a rider who left the room keeps her name on every screen', () => {
  /** Bea rode in the heat and left the room for good: no participant any more; her rider entry carries her name. */
  const bea = (over: Partial<RiderView> = {}): RiderView => rider('bea', { riderName: 'Bea', ponyName: 'Nube', ...over });
  const beaRow = { place: null, riderId: 'bea', riderName: 'Bea', ponyName: 'Nube', faults: 4, timeMs: null, status: 'eliminated' as const, eliminationReason: 'disconnected' as const, autopilot: false };

  it('the heat screen between the heats names her from her rider entry', async () => {
    const h = await inRound();
    h.session().emitState(snapshot({ phase: 'results', heatIndex: 0, riders: { host: rider('host', { status: 'finished' }), ana: rider('ana', { status: 'finished' }), bea: bea({ status: 'eliminated', faults: 4 }) } }));
    await settle();
    expect(text(h.root.querySelector('[data-list="heat"] > li[data-id="bea"]'))).toBe('Bea on Nube · 4 faults · eliminada');
    expect(text(h.root.querySelector('[data-list="heat"] > li[data-id="ana"]'))).toBe('Ana on Luna · 0 faults · Finished');
  });

  it('her caption and her label over the horse name her too', async () => {
    const h = await inRound();
    h.session().emitState(ridingState({ riders: { host: rider('host'), ana: rider('ana'), bea: bea() } }));
    h.session().emitMessage(roundEvent({ type: 'eliminated', riderId: 'bea', at: h.clock.now(), reason: 'disconnected' }));
    expect(text(h.root.querySelector('[data-hud-caption]'))).toBe(captionOf('en', { type: 'eliminated', reason: 'disconnected' }, { rider: 'Bea', pony: 'Nube', ponyGender: 'yegua' }));
    h.game.frame(h.clock.now());
    expect(h.scene.frames.at(-1)?.riders.find((r) => r.id === 'bea')?.label).toBe('Bea on Nube');
  });

  it('the class table names her from its row, and a late joiner who never saw her as a participant reads the same', async () => {
    const h = await inRound();
    h.session().emitMessage({ type: 'class-table', table: { '70': [...(table['70'] ?? []), beaRow] } });
    h.session().emitState(snapshot({ phase: 'done', heatIndex: 0 }));
    await settle();
    expect(text(h.root.querySelector('tr[data-id="bea"] td:nth-child(2)'))).toBe('Bea on Nube');
    expect(text(h.root.querySelector('tr[data-id="ana"] td:nth-child(2)'))).toBe('Ana on Luna');
  });

  it('a rider nobody can name still reads as her id, never blank', async () => {
    const h = await inRound();
    h.session().emitState(snapshot({ phase: 'results', heatIndex: 0, riders: { host: rider('host', { status: 'finished' }), cris: rider('cris', { status: 'finished' }) } }));
    await settle();
    expect(text(h.root.querySelector('[data-list="heat"] > li[data-id="cris"]'))).toBe('cris · 0 faults · Finished');
  });
});

describe('the tab lifecycle', () => {
  it('the tab becoming visible and pageshow each resume the session', async () => {
    const h = await hostInLobby();
    becomeVisible();
    await settle();
    expect(h.session().resumes).toBe(1);
    h.win.fire('pageshow');
    await settle();
    expect(h.session().resumes).toBe(2);
  });

  it('without a session the lifecycle events do nothing', async () => {
    const h = await boot();
    becomeVisible();
    h.win.fire('pageshow');
    await settle();
    expect(h.sessions).toHaveLength(0);
    expect(h.root.dataset.screen).toBe('home');
  });

  it('a session ended as kicked shows the kicked text and no reconnect button', async () => {
    const h = await hostInLobby();
    h.session().endWith({ kind: 'kicked', code: 4100 });
    await settle();
    expect(text(h.root.querySelector('[data-ended]'))).toBe('You were asked to leave this room');
    expect(h.root.querySelector('[data-action="reconnect"]')).toBeNull();
  });

  it('a session lost shows the lost text with a reconnect button that asks the room status and connects a new session', async () => {
    const h = await hostInLobby({ roomStatus: [ok<RoomStatusReply>({ status: 'admitted', roomId: 'r1' })] });
    h.session().endWith({ kind: 'lost', code: 1006 });
    await settle();
    expect(text(h.root.querySelector('[data-ended]'))).toBe('Connection lost — tap to reconnect');
    click(h.root, '[data-action="reconnect"]');
    await settle();
    expect(h.api.callsOf('roomStatus')).toEqual([['ABCDEF']]);
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]?.connects).toEqual([['r1', 'ABCDEF']]);
    expect(h.game.session).toBe(h.sessions[1]);
    expect(h.root.dataset.screen).toBe('lobby');
  });

  it('a session lost during the course walk: the ended screen with the lost text, reconnect and back buttons; the walk is no longer drawn (audit K1 r1 #5)', async () => {
    const h = await inWalk();
    h.session().endWith({ kind: 'lost', code: 1006 });
    await settle();
    expect(h.root.dataset.screen).toBe('ended');
    expect(h.game.screen).toBe('ended');
    expect(text(h.root.querySelector('[data-ended]'))).toBe('Connection lost — tap to reconnect');
    expect(h.root.querySelector('[data-action="reconnect"]')).not.toBeNull();
    expect(h.root.querySelector('[data-action="leave"]')).not.toBeNull();
    h.game.frame(h.clock.now());
    expect(h.scene.frames.at(-1)?.phase).toBe('idle');
  });

  it('a session lost while riding: the controls take no input; reconnect asks the room status and a new session rides on (audit K1 r1 #5)', async () => {
    const h = await hostInLobby({ roomStatus: [ok<RoomStatusReply>({ status: 'host', roomId: 'r1' })] });
    startClass(h);
    await settle();
    approachOwn(h);
    h.session().endWith({ kind: 'lost', code: 1006 });
    await settle();
    expect(h.root.dataset.screen).toBe('ended');
    expect(h.root.querySelector('[data-arena]')).toBeNull(); // the arena and its controls are off the screen
    h.clock.t += 1_000;
    pressPage(h, TAP);
    pressPage(h, GEAR);
    expect(h.session().sent).toEqual([]);
    h.settings.stateOnConnect = ridingState();
    click(h.root, '[data-action="reconnect"]');
    await settle();
    expect(h.api.callsOf('roomStatus')).toEqual([['ABCDEF']]);
    expect(h.sessions).toHaveLength(2);
    expect(h.game.session).toBe(h.sessions[1]);
    expect(h.root.dataset.screen).toBe('round');
  });

  it.each([
    ['kicked', 4100, 'You were asked to leave this room'],
    ['revoked', 4101, 'You were signed out on this device'],
  ] as const)('a session ended as %s while riding: the ended screen with its text, no reconnect, the controls dead; back leads home (audit K1 r1 #5)', async (kind, code, message) => {
    const h = await inApproach();
    h.session().endWith({ kind, code });
    await settle();
    expect(h.root.dataset.screen).toBe('ended');
    expect(text(h.root.querySelector('[data-ended]'))).toBe(message);
    expect(h.root.querySelector('[data-action="reconnect"]')).toBeNull();
    expect(h.root.querySelector('[data-arena]')).toBeNull();
    h.clock.t += 1_000;
    pressPage(h, TAP);
    expect(h.session().sent).toEqual([]);
    click(h.root, '[data-action="leave"]');
    await settle();
    expect(h.root.dataset.screen).toBe('home');
    expect(h.game.session).toBeNull();
  });

  it('destroy() removes the window listeners, leaves the session and disposes the scene', async () => {
    const h = await hostInLobby();
    const game = h.game;
    games.splice(games.indexOf(game), 1);
    game.destroy();
    expect(h.win.removed).toContain('pageshow');
    expect(h.win.removed).toContain('resize');
    expect(h.scene.disposed).toBe(1);
    expect(h.session().leaves).toBe(1);
  });
});

// ==== K1.1 playability ==========================================================================================

/** The text of a key that must exist in both locales (a missing key fails here by name, not by an empty element). */
function localized(locale: Locale, key: string): string {
  expect(isMessageKey(key), `the message key ${key}`).toBe(true);
  return translateKey(locale, key);
}

/** An element is shown: in the document, not hidden by the attribute, not display none. */
const shown = (element: Element | null): boolean =>
  element !== null && element.isConnected && !element.hasAttribute('hidden') && (element as HTMLElement).style.display !== 'none';

/** The text of a feedback element while it is shown ('' when it is absent, hidden or empty). */
const feedback = (h: Harness, selector: string): string => {
  const element = h.root.querySelector(selector);
  return shown(element) ? text(element) : '';
};

const control = (h: Harness, name: Control): HTMLElement => q(h.root, `[data-control="${name}"]`);

/** The own horse's turn-ahead, handled now (the window opens at the clock's reading). */
const turnAheadOwn = (h: Harness, riderId = 'host'): void =>
  h.session().emitMessage(roundEvent({ type: 'turn-ahead', riderId, distanceM: 45, at: h.clock.now() + 2_000 }));

/** The server's turn verdict for a horse. */
const turnVerdict = (h: Harness, riderId = 'host', quality: 'tight' | 'wide' | 'missed' | 'wrong' = 'tight'): void => {
  const outcome = {
    tight: { quality: 'tight', stopSec: 0, hardTurn: false, label: 'giro_cerrado' },
    wide: { quality: 'wide', stopSec: 0, hardTurn: true, label: 'giro_abierto' },
    missed: { quality: 'missed', stopSec: 4, hardTurn: true, label: 'recto' },
    wrong: { quality: 'wrong', stopSec: 6, hardTurn: true, label: 'recorrido_equivocado' },
  }[quality] as Extract<RoundEventWire, { type: 'turn' }>['outcome'];
  h.session().emitMessage(roundEvent({ type: 'turn', riderId, distanceM: 45, decidedAt: h.clock.now(), outcome }));
};

describe('the direction buttons light up while the own turn window is open (K1.1 step 3)', () => {
  const windowOf = (h: Harness, name: Control): string | null => control(h, name).getAttribute('data-window');

  it('after the own turn-ahead both buttons carry data-window="open"; before it neither does', async () => {
    const h = await inRound();
    expect(windowOf(h, 'turn-left')).toBeNull();
    expect(windowOf(h, 'turn-right')).toBeNull();
    turnAheadOwn(h);
    expect(windowOf(h, 'turn-left')).toBe('open');
    expect(windowOf(h, 'turn-right')).toBe('open');
  });

  it('the light goes with the window: at the frame where the 3.5 s window ends, both buttons are dark again', async () => {
    const h = await inRound();
    turnAheadOwn(h);
    h.clock.t += 3_499;
    h.game.frame(h.clock.now());
    expect(windowOf(h, 'turn-left')).toBe('open');
    h.clock.t += 1;
    h.game.frame(h.clock.now());
    expect(windowOf(h, 'turn-left')).toBeNull();
    expect(windowOf(h, 'turn-right')).toBeNull();
  });

  it("the own horse's 'turn' verdict puts both lights out", async () => {
    const h = await inRound();
    turnAheadOwn(h);
    turnVerdict(h);
    h.game.frame(h.clock.now());
    expect(windowOf(h, 'turn-left')).toBeNull();
    expect(windowOf(h, 'turn-right')).toBeNull();
  });

  it("negative: another rider's turn-ahead lights nothing", async () => {
    const h = await inRound();
    turnAheadOwn(h, 'ana');
    h.game.frame(h.clock.now());
    expect(windowOf(h, 'turn-left')).toBeNull();
    expect(windowOf(h, 'turn-right')).toBeNull();
  });

  it('the pressed button carries data-chosen from the turn that went out until the verdict; the window is closed at once', async () => {
    const h = await inRound();
    turnAheadOwn(h);
    h.clock.t += 500;
    press(h, TURN_RIGHT);
    expect(h.session().sentOf('turn')).toEqual([{ type: 'turn', choice: 'right', clientTime: h.clock.now() }]);
    h.game.frame(h.clock.now());
    expect(control(h, 'turn-right').hasAttribute('data-chosen')).toBe(true);
    expect(control(h, 'turn-left').hasAttribute('data-chosen')).toBe(false);
    expect(windowOf(h, 'turn-left')).toBeNull();
    expect(windowOf(h, 'turn-right')).toBeNull();
    turnVerdict(h);
    h.game.frame(h.clock.now());
    expect(control(h, 'turn-right').hasAttribute('data-chosen')).toBe(false);
  });

  it('negative: a line shift outside the window and a turn the session could not send choose nothing', async () => {
    const h = await inRound();
    press(h, TURN_LEFT); // no window: a line shift
    expect(control(h, 'turn-left').hasAttribute('data-chosen')).toBe(false);
    turnAheadOwn(h);
    h.session().emitStatus('dropped');
    press(h, TURN_LEFT);
    h.game.frame(h.clock.now());
    expect(control(h, 'turn-left').hasAttribute('data-chosen')).toBe(false);
    expect(windowOf(h, 'turn-left')).toBe('open'); // nothing was spent: the window is still open
  });

  it('no turn-direction hint (owner decision 2026-11-03): whichever way the course turns, both buttons look the same', async () => {
    for (const direction of ['left', 'right'] as const) {
      const h = await hostInLobby();
      const turning: CourseSpec = { ...course3, turns: [{ distanceM: 45, direction }] };
      h.session().emitMessage({ type: 'class-course', course: turning, classNumber: 1 });
      h.session().emitState(ridingState({ riders: { host: rider('host', { positionM: 36 }), ana: rider('ana') } }));
      await settle();
      turnAheadOwn(h);
      h.game.frame(h.clock.now());
      const attributes = (name: Control): string[] =>
        [...control(h, name).attributes].map((a) => `${a.name}=${a.name === 'data-control' || a.name === 'class' || a.name === 'style' ? '' : a.value}`).sort();
      expect(attributes('turn-left'), direction).toEqual(attributes('turn-right'));
      expect(control(h, 'turn-left').className.replace('control-turn-left', ''), direction).toBe(control(h, 'turn-right').className.replace('control-turn-right', ''));
      h.game.destroy();
    }
  });
});

describe('every touch of a zone answers (K1.1 step 3)', () => {
  const pressedOf = (h: Harness, name: Control): string | null => control(h, name).getAttribute('data-pressed');

  it('a tap that went out flashes data-pressed="sent" for 150 ms', async () => {
    const h = await inApproach();
    h.clock.t += 1_000;
    press(h, TAP);
    expect(pressedOf(h, 'tap')).toBe('sent');
    h.timers.advance(149);
    expect(pressedOf(h, 'tap')).toBe('sent');
    h.timers.advance(1);
    expect(pressedOf(h, 'tap')).toBeNull();
  });

  it('a tap that went nowhere (no approach open) dims as data-pressed="ignored" for 150 ms', async () => {
    const h = await inRound();
    press(h, TAP);
    expect(pressedOf(h, 'tap')).toBe('ignored');
    h.timers.advance(150);
    expect(pressedOf(h, 'tap')).toBeNull();
  });

  it('a new touch of the same control restarts its 150 ms: the first touch\'s timer never cuts the second flash short', async () => {
    const h = await inRound();
    press(h, TAP);
    h.timers.advance(100);
    press(h, TAP);
    h.timers.advance(100);
    expect(pressedOf(h, 'tap')).toBe('ignored');
    h.timers.advance(50);
    expect(pressedOf(h, 'tap')).toBeNull();
  });

  it('the pace button and the direction buttons flash too: sent for a gear and a line shift that went out, ignored while the session is dropped', async () => {
    const h = await inRound();
    press(h, GEAR);
    press(h, TURN_LEFT);
    expect(pressedOf(h, 'gear')).toBe('sent');
    expect(pressedOf(h, 'turn-left')).toBe('sent');
    h.timers.advance(150);
    h.session().emitStatus('dropped');
    press(h, GEAR);
    press(h, TURN_RIGHT);
    expect(pressedOf(h, 'gear')).toBe('ignored');
    expect(pressedOf(h, 'turn-right')).toBe('ignored');
  });

  it('negative: a finger outside every zone flashes nothing', async () => {
    const h = await inRound();
    press(h, [300, 195]);
    for (const name of ['turn-left', 'turn-right', 'gear', 'tap'] as const) expect(pressedOf(h, name), name).toBeNull();
  });

  it("the press note for an early tap: 'not-armed' in the locale, for 1.2 s", async () => {
    const h = await inRound();
    press(h, TAP);
    expect(feedback(h, '[data-press-note]')).toBe(localized('en', 'hud.pressNote.not-armed'));
    h.timers.advance(1_199);
    expect(feedback(h, '[data-press-note]')).toBe(localized('en', 'hud.pressNote.not-armed'));
    h.timers.advance(1);
    expect(feedback(h, '[data-press-note]')).toBe('');
  });

  it("the press note for a second tap of the same approach: 'already-tapped'", async () => {
    const h = await inApproach();
    h.clock.t += 1_000;
    press(h, TAP);
    expect(feedback(h, '[data-press-note]')).toBe(''); // the tap that went out has no note
    h.clock.t += 50;
    press(h, TAP);
    expect(feedback(h, '[data-press-note]')).toBe(localized('en', 'hud.pressNote.already-tapped'));
  });

  it("the press note for a tap while the session cannot send: 'cannot-send'", async () => {
    const h = await inApproach();
    h.session().emitStatus('dropped');
    press(h, TAP);
    expect(feedback(h, '[data-press-note]')).toBe(localized('en', 'hud.pressNote.cannot-send'));
  });

  it("the press note for a touch too old for the judge: 'too-old' — for the tap and for a turn", async () => {
    const h = await inApproach();
    h.clock.t += 1_000;
    press(h, TAP, h.clock.now() - PACKET.maxAgeMs - 1);
    expect(feedback(h, '[data-press-note]')).toBe(localized('en', 'hud.pressNote.too-old'));
    h.timers.advance(1_200);
    turnAheadOwn(h);
    h.clock.t += 500;
    press(h, TURN_LEFT, h.clock.now() - PACKET.maxAgeMs - 1);
    expect(feedback(h, '[data-press-note]')).toBe(localized('en', 'hud.pressNote.too-old'));
  });

  it('the press note is in the locale of the moment: Spanish', async () => {
    const h = await inRound();
    h.game.setLocale('es');
    press(h, TAP);
    expect(feedback(h, '[data-press-note]')).toBe(localized('es', 'hud.pressNote.not-armed'));
    expect(localized('es', 'hud.pressNote.not-armed')).not.toBe(localized('en', 'hud.pressNote.not-armed'));
  });

  it("negative: no note for 'not-riding' (her horse finished) — the touch still dims", async () => {
    const h = await inRound();
    h.session().emitState(ridingState({ riders: { host: rider('host', { status: 'finished' }), ana: rider('ana') } }));
    press(h, TAP);
    press(h, TURN_LEFT);
    expect(pressedOf(h, 'tap')).toBe('ignored');
    expect(feedback(h, '[data-press-note]')).toBe('');
    expect(h.session().sent).toEqual([]);
  });

  it('Pace that went out: a toast with the new gear in the locale, gone after 1 s', async () => {
    const h = await inRound();
    press(h, GEAR);
    expect(feedback(h, '[data-toast]')).toBe(localized('en', 'hud.toast.gear.extended'));
    h.timers.advance(999);
    expect(feedback(h, '[data-toast]')).toBe(localized('en', 'hud.toast.gear.extended'));
    h.timers.advance(1);
    expect(feedback(h, '[data-toast]')).toBe('');
    press(h, GEAR);
    expect(feedback(h, '[data-toast]')).toBe(localized('en', 'hud.toast.gear.gallop'));
  });

  it('a line shift that went out: a toast with the new line; the shift back toasts the centre', async () => {
    const h = await inRound();
    press(h, TURN_LEFT);
    expect(feedback(h, '[data-toast]')).toBe(localized('en', 'hud.toast.line.angle'));
    h.timers.advance(1_000);
    press(h, TURN_RIGHT);
    expect(feedback(h, '[data-toast]')).toBe(localized('en', 'hud.toast.line.center'));
  });

  it('negative: no toast for a gear the session could not send, and none for a turn', async () => {
    const h = await inRound();
    h.session().emitStatus('dropped');
    press(h, GEAR);
    expect(feedback(h, '[data-toast]')).toBe('');
    h.session().emitStatus('connected');
    turnAheadOwn(h);
    press(h, TURN_LEFT);
    expect(h.session().sentOf('turn')).toHaveLength(1);
    expect(feedback(h, '[data-toast]')).toBe('');
  });
});

describe('the course walk has no controls (K1.1 step 3)', () => {
  it('on the walk screen none of the four controls is shown', async () => {
    const h = await inWalk();
    for (const name of ['turn-left', 'turn-right', 'gear', 'tap'] as const) {
      expect(shown(h.root.querySelector(`[data-control="${name}"]`)), name).toBe(false);
    }
  });

  it('a touch where Jump! would be sends nothing and flashes nothing', async () => {
    const h = await inWalk();
    press(h, TAP);
    press(h, GEAR);
    expect(h.session().sent).toEqual([]);
    expect(h.root.querySelector('[data-pressed]')).toBeNull();
  });

  it('negative: once the round begins the four controls are shown again', async () => {
    const h = await inWalk();
    h.session().emitState(ridingState());
    await settle();
    expect(h.root.dataset.screen).toBe('round');
    for (const name of ['turn-left', 'turn-right', 'gear', 'tap'] as const) expect(shown(control(h, name)), name).toBe(true);
  });
});

describe('the course map on the walk screen (K1.1 step 4)', () => {
  /** Three fences, a left turn between 1 and 2 and a right turn between 2 and 3. */
  const bothWays: CourseSpec = {
    id: 'both-ways',
    version: 1,
    lengthM: 130,
    speedMPerMin: 300,
    fences: [
      { number: 1, distanceM: 30, type: 'vertical' },
      { number: 2, distanceM: 64, type: 'oxer' },
      { number: 3, distanceM: 110, type: 'vertical' },
    ],
    turns: [
      { distanceM: 45, direction: 'left' },
      { distanceM: 80, direction: 'right' },
    ],
  };

  /** The host on the walk of `course` (class 1, heat 0), its window starting now and `walkMs` long. */
  async function walkingOver(walkMs = 6_000, over: CourseSpec = bothWays): Promise<Harness> {
    const h = await hostInLobby();
    h.session().emitMessage({ type: 'class-course', course: over, classNumber: 1 });
    h.session().emitMessage(phaseMessage('walk', 0, h.clock.now(), h.clock.now() + walkMs));
    h.session().emitState(snapshot({ phase: 'walk', heatIndex: 0 }));
    await settle();
    expect(h.root.dataset.screen).toBe('walk');
    return h;
  }

  const map = (h: Harness): Element => {
    const element = h.root.querySelector('[data-walk-map]');
    expect(element, 'the walk map [data-walk-map]').not.toBeNull();
    return element as Element;
  };
  const fenceMarkers = (h: Harness): string[] => [...map(h).querySelectorAll('[data-fence-marker]')].map((m) => m.getAttribute('data-fence-marker') ?? '');
  const turnMarkers = (h: Harness): string[] => [...map(h).querySelectorAll('[data-turn-marker]')].map((m) => m.getAttribute('data-turn-marker') ?? '');
  const focused = (h: Harness): string[] =>
    [...map(h).querySelectorAll('[data-fence-marker][data-focus="true"]')].map((m) => m.getAttribute('data-fence-marker') ?? '');

  it('the walk draws the map as an SVG: one marker per fence in course order, one arrow per turn in route order with its direction', async () => {
    const h = await walkingOver();
    expect(map(h).tagName.toLowerCase()).toBe('svg');
    expect(fenceMarkers(h)).toEqual(['1', '2', '3']);
    expect(turnMarkers(h)).toEqual(['left', 'right']);
  });

  it('the legend stays: [data-list="fences"] lists every fence beside the map', async () => {
    const h = await walkingOver();
    const items = [...q(h.root, '[data-list="fences"]').querySelectorAll('li')];
    expect(items).toHaveLength(3);
    expect(text(items[1] ?? null)).toContain('Fence 2: óxer');
  });

  it('the focus of the fly-over moves along the map: exactly one marker is data-focus="true", fence 1 → 2 → 3 over the server\'s window', async () => {
    const h = await walkingOver(6_000);
    h.game.frame(h.clock.now());
    expect(focused(h)).toEqual(['1']);
    h.clock.t += 2_500;
    h.game.frame(h.clock.now());
    expect(focused(h)).toEqual(['2']);
    h.clock.t += 2_000;
    h.game.frame(h.clock.now());
    expect(focused(h)).toEqual(['3']);
  });

  it('the map is named and its start and finish are labelled in the locale, Spanish after the switch', async () => {
    const h = await walkingOver();
    expect(map(h).getAttribute('aria-label')).toBe(localized('en', 'walk.map.label'));
    expect(text(q(h.root, '[data-walk-start]'))).toBe(localized('en', 'walk.map.start'));
    expect(text(q(h.root, '[data-walk-finish]'))).toBe(localized('en', 'walk.map.finish'));
    click(h.root, '[data-action="locale"][data-locale="es"]');
    expect(map(h).getAttribute('aria-label')).toBe(localized('es', 'walk.map.label'));
    expect(text(q(h.root, '[data-walk-start]'))).toBe(localized('es', 'walk.map.start'));
    expect(fenceMarkers(h)).toEqual(['1', '2', '3']);
  });

  it('a club course of eight fences: eight markers on the map', async () => {
    const h = await hostInLobby();
    const club = clubCourse('screen-map', 8);
    h.session().emitMessage({ type: 'class-course', course: club, classNumber: 1 });
    h.session().emitState(snapshot({ phase: 'walk', heatIndex: 0 }));
    await settle();
    expect(fenceMarkers(h)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(turnMarkers(h)).toEqual([...club.turns].sort((a, b) => a.distanceM - b.distanceM).map((turn) => turn.direction));
  });

  it('negative: the round screen has no map', async () => {
    const h = await inRound();
    expect(h.root.querySelector('[data-walk-map]')).toBeNull();
  });
});

describe('the take-off marker in the frames of the round (K1.1 step 7)', () => {
  /** 70 cm (the default class of a C pony) in collected canter: 157.5 ms clean, 58.5 ms perfect; at 5 m/s 0.7875 m and 0.2925 m. */
  const CLEAN = 157.5;
  const marker = (h: Harness, now = h.clock.now()) => {
    h.game.frame(now);
    return h.scene.frames.at(-1)?.takeoff ?? null;
  };

  it('the own approach with a speed: fence, take-off point and band from the shared window, the state by the clock against t0', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    const first = marker(h);
    expect(first).toMatchObject({ fence: 1, distanceM: 30, state: 'approach' });
    expect(first?.cleanHalfM).toBeCloseTo((CLEAN / 1000) * 5, 9);
    expect(first?.perfectHalfM).toBeCloseTo((58.5 / 1000) * 5, 9);
    expect(marker(h, t0 - CLEAN - 1)?.state).toBe('approach');
    expect(marker(h, t0 - CLEAN)?.state).toBe('clean');
    expect(marker(h, t0)?.state).toBe('perfect');
    expect(marker(h, t0 + CLEAN)?.state).toBe('clean');
    expect(marker(h, t0 + CLEAN + 1)?.state).toBe('late');
  });

  it('the own take-off verdict puts the bright band out: no marker in the frames after it', async () => {
    const h = await inRound();
    approachOwn(h, 1, 1, h.clock.now() + 1_000, 5);
    expect(marker(h)).not.toBeNull();
    h.clock.t += 1_000;
    h.session().emitMessage(roundEvent({ type: 'takeoff', riderId: 'host', fence: 1, attempt: 1, decidedAt: h.clock.now(), offsetMs: 0, outcome: clean, approach: approach70 }));
    expect(marker(h)).toBeNull();
  });

  it('an approach without speed: only the outline — state approach, no band length', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, null);
    expect(marker(h, t0)).toEqual({ fence: 1, distanceM: 30, state: 'approach', cleanHalfM: null, perfectHalfM: null });
  });

  it('a clock not measured yet: only the outline, whatever the moment', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.ready = () => false;
    h.clock.toServer = () => null;
    expect(marker(h, t0)?.state).toBe('approach');
  });

  it('negative: another rider\'s approach draws no marker for the own horse', async () => {
    const h = await inRound();
    h.session().emitMessage(roundEvent({ type: 'approach', riderId: 'ana', fence: 1, attempt: 1, t0: h.clock.now() + 900, speedMps: 5 }));
    expect(marker(h)).toBeNull();
  });

  it('approach-sync with an approach and a speed lights the marker; one without an approach puts it out', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    h.session().emitMessage({ type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: false, approach: { fence: 1, attempt: 1, t0, speedMps: 5 } });
    expect(marker(h, t0)).toMatchObject({ fence: 1, state: 'perfect' });
    h.session().emitMessage({ type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: false, approach: null });
    expect(marker(h, t0)).toBeNull();
  });

  it('a gear change after the approach opened changes the band (gallop halves it), never the speed', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.session().emitState(ridingState({ riders: { host: rider('host', { gear: 'gallop', positionM: 20 }), ana: rider('ana') } }));
    h.clock.t += 100;
    expect(marker(h)?.cleanHalfM).toBeCloseTo((CLEAN * 0.5 / 1000) * 5, 9);
  });

  it('a new class starts without a marker', async () => {
    const h = await inApproach();
    approachOwn(h, 1, 1, h.clock.now() + 1_000, 5);
    await inResults(h);
    startClass(h, 2);
    await settle();
    expect(marker(h)).toBeNull();
  });
});

describe('the own horse on the approach: one visible position, the camera with it (K1.1 step 7)', () => {
  const track = buildTrack(course);
  /** The own horse in the latest frame at `now`, its mode, and whether the camera follows that very point. */
  function own(h: Harness, now = h.clock.now()): { positionM: number | null; mode: string | null; cameraFollows: boolean } {
    h.game.frame(now);
    const frame = h.scene.frames.at(-1);
    const entry = frame?.riders.find((r) => r.isOwn);
    if (!frame || !entry) return { positionM: null, mode: frame?.ownMode ?? null, cameraFollows: false };
    // The position along the track whose point is drawn (the one-fence course is a straight line along +x).
    const positionM = entry.point.x;
    const expected = chaseCamera(entry.point);
    const cameraFollows = JSON.stringify(frame.camera) === JSON.stringify(expected);
    return { positionM, mode: frame.ownMode, cameraFollows };
  }
  const expectOwn = (h: Harness, positionM: number, mode: string, now = h.clock.now()): void => {
    const seen = own(h, now);
    expect(seen.mode, `mode at ${String(now)}`).toBe(mode);
    expect(seen.positionM ?? Number.NaN, `position at ${String(now)}`).toBeCloseTo(positionM, 6);
    expect(seen.cameraFollows, 'the camera follows the drawn position').toBe(true);
    expect(pointAt(track, positionM).x).toBeCloseTo(positionM, 9); // the straight course: position = x
  };
  /** A state patch with the own horse at `positionM` (Ana stays at 0 m). */
  const patch = (h: Harness, positionM: number, over: Partial<RiderView> = {}): void =>
    h.session().emitState(ridingState({ riders: { host: rider('host', { positionM, ...over }), ana: rider('ana') } }));
  const takeoffOwn = (h: Harness, outcome: TakeoffOutcome, attempt = 1): void =>
    h.session().emitMessage(roundEvent({ type: 'takeoff', riderId: 'host', fence: 1, attempt, decidedAt: h.clock.now(), offsetMs: 0, outcome, approach: approach70 }));
  const refusal: TakeoffOutcome = { kind: 'refusal', faults: 0, cleared: false, label: 'rehuse', horseJumped: false };

  it("forecast: fence − speedMps × (t0 − server now) / 1000 at t0 − 1000, t0 − cleanMs and t0 — the server's own run, ahead of the patch", async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    patch(h, 24);
    approachOwn(h, 1, 1, t0, 5);
    expectOwn(h, 25, 'forecast', t0 - 1_000);
    expectOwn(h, 30 - 5 * 0.1575, 'forecast', t0 - 157.5);
    expectOwn(h, 30, 'forecast', t0);
  });

  it('forecast: never past the take-off point — after t0 the horse waits at it for the verdict', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    expectOwn(h, 30, 'forecast', t0 + 300);
  });

  it('forecast: a delayed patch (300 ms older) does not move the horse back; a patch ahead of the forecast is not overtaken', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    patch(h, 23.5); // 300 ms behind the server's 25 m
    expectOwn(h, 25, 'forecast', t0 - 1_000);
    patch(h, 26); // the server says further on than the forecast: never behind the latest server position
    expectOwn(h, 26, 'forecast', t0 - 1_000);
  });

  it('negative: without a speed, or without a measured clock, the own horse is drawn from the patch', async () => {
    const noSpeed = await inRound();
    approachOwn(noSpeed, 1, 1, noSpeed.clock.now() + 1_000, null);
    patch(noSpeed, 24);
    expectOwn(noSpeed, 24, 'patch');
    const noClock = await inRound();
    approachOwn(noClock, 1, 1, noClock.clock.now() + 1_000, 5);
    noClock.clock.ready = () => false;
    noClock.clock.toServer = () => null;
    patch(noClock, 24);
    expectOwn(noClock, 24, 'patch');
  });

  it('a cleared fence: forecast → take-off → a stale patch keeps the position (hold, never back) → the fresh patch after the event leads on', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0 + 20;
    expectOwn(h, 30, 'forecast');
    takeoffOwn(h, clean); // the server's events of a tick come before its state: the patch that follows is the fresh one
    expectOwn(h, 30, 'hold');
    patch(h, 30.4, { nextFence: 2 });
    expectOwn(h, 30.4, 'patch');
    patch(h, 33, { nextFence: 2 });
    expectOwn(h, 33, 'patch');
  });

  it('a cleared fence whose first fresh patch is still behind the held position: no step back until a patch ahead of it', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0;
    expectOwn(h, 30, 'forecast');
    takeoffOwn(h, chip);
    patch(h, 29.8, { nextFence: 2 }); // fresh, but behind 30 m: the horse is held, never drawn back
    expectOwn(h, 30, 'hold');
    patch(h, 30.25, { nextFence: 2 });
    expectOwn(h, 30.25, 'patch');
  });

  it('after the verdict, frames before any fresh patch keep the held position: the patch from before the verdict is stale', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    patch(h, 29.5);
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0;
    expectOwn(h, 30, 'forecast');
    takeoffOwn(h, clean);
    expectOwn(h, 30, 'hold'); // a frame before any patch after the event: the last visible position
    h.clock.t += 50;
    expectOwn(h, 30, 'hold');
  });

  it('a refusal: forecast → rehúse → hold → the fresh patch at fence − 2 m is taken (that step back is the server\'s) → the next attempt\'s approach forecasts again', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0 + 700;
    expectOwn(h, 30, 'forecast');
    takeoffOwn(h, refusal);
    expectOwn(h, 30, 'hold');
    patch(h, 28, { attempt: 2 });
    expectOwn(h, 28, 'patch');
    h.clock.t += 3_000;
    const retry = h.clock.now() + 400; // 2 m at 5 m/s
    approachOwn(h, 1, 2, retry, 5);
    expectOwn(h, 28, 'forecast');
    expectOwn(h, 29, 'forecast', retry - 200);
  });

  it('taking control back: approach-sync with an approach forecasts it; one without an approach drops a hold and draws the patch', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    h.session().emitMessage({ type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: false, approach: { fence: 1, attempt: 1, t0, speedMps: 5 } });
    expectOwn(h, 25, 'forecast', t0 - 1_000);
    h.clock.t = t0;
    expectOwn(h, 30, 'forecast');
    takeoffOwn(h, clean);
    expectOwn(h, 30, 'hold');
    h.session().emitMessage({ type: 'approach-sync', classNumber: 1, heatIndex: 0, hardTurn: false, approach: null });
    expectOwn(h, 0, 'patch'); // the latest patch still says 0 m: no hold survives a sync without an approach
  });

  it('a new class drops the hold: the own horse is drawn from the new class\'s patch', async () => {
    const h = await inRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0;
    expectOwn(h, 30, 'forecast');
    takeoffOwn(h, clean);
    expectOwn(h, 30, 'hold');
    await inResults(h);
    startClass(h, 2);
    await settle();
    expectOwn(h, 0, 'patch');
  });

  it("negative: the other horses are drawn as in K1 — another rider's approach and take-off change nothing of the own horse", async () => {
    const h = await inRound();
    patch(h, 12);
    h.session().emitMessage(roundEvent({ type: 'approach', riderId: 'ana', fence: 1, attempt: 1, t0: h.clock.now() + 500, speedMps: 5 }));
    expectOwn(h, 12, 'patch');
  });
});

describe('debugRequested: the page address asks for the debug overlay (K1.1 step 9)', () => {
  it('a parameter named debug, alone, with a value or among others', () => {
    for (const search of ['?debug', '?debug=1', '?debug=', '?x=1&debug', '?debug&x=1']) expect(debugRequested(search), search).toBe(true);
  });

  it('negative: no query, other parameters, or a parameter that only contains the word', () => {
    for (const search of ['', '?', '?x=1', '?debugger', '?nodebug', '?x=debug']) expect(debugRequested(search), search).toBe(false);
  });
});

describe('the debug overlay (K1.1 step 9)', () => {
  /** The host riding heat 1 of class 1 with the overlay on. */
  async function debugRound(schoolmaster = false): Promise<Harness> {
    const h = await hostInLobby({}, snapshot(), undefined, true);
    if (schoolmaster) setChecked(h.root, '[data-assist="schoolmaster"]', true);
    startClass(h);
    await settle();
    expect(h.root.dataset.screen).toBe('round');
    return h;
  }
  const rows = (h: Harness): HTMLElement[] => [...h.root.querySelectorAll<HTMLElement>('[data-debug] [data-debug-press]')];
  const newest = (h: Harness): HTMLElement => {
    const row = rows(h)[0];
    if (row === undefined) throw new Error('no press row in the overlay');
    return row;
  };
  const takeoffOwn = (h: Harness, offsetMs: number | null, riderId = 'host', attempt = 1): void =>
    h.session().emitMessage(roundEvent({ type: 'takeoff', riderId, fence: 1, attempt, decidedAt: h.clock.now(), offsetMs, outcome: clean, approach: approach70 }));

  it('without the flag there is no [data-debug] anywhere — sign-in, lobby, round', async () => {
    const h = await inRound();
    expect(h.root.querySelector('[data-debug]')).toBeNull();
    expect(document.querySelector('[data-debug]')).toBeNull();
  });

  it('with the flag the overlay is there from the sign-in on: no account or PIN needed', async () => {
    const h = await boot({ debug: true, script: { me: [failed(401, 'unauthenticated')] } });
    expect(h.root.dataset.screen).toBe('signin');
    expect(h.root.querySelector('[data-debug]')).not.toBeNull();
  });

  it('a tap that went out: every field of the press, the local offset at the press, then the judge\'s offset — accepted within 20 ms', async () => {
    const h = await debugRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0 + 40;
    press(h, TAP, t0 + 30);
    const row = newest(h);
    expect(row.dataset).toMatchObject({
      zone: 'tap',
      timeStamp: String(t0 + 30),
      source: 'event',
      reason: '',
      clientTime: String(t0 + 30),
      handledAt: String(t0 + 40),
      outcome: 'sent',
      localOffset: '30',
      judge: 'pending',
    });
    takeoffOwn(h, 45); // 15 ms from the local estimate
    expect(newest(h).dataset).toMatchObject({ judge: 'accepted', judgeOffset: '45', localOffset: '30' });
  });

  it("a difference of more than 20 ms is 'unconfirmed' with both numbers; exactly 20 ms is still accepted", async () => {
    const off = await debugRound();
    const t0 = off.clock.now() + 1_000;
    approachOwn(off, 1, 1, t0, 5);
    off.clock.t = t0 + 10;
    press(off, TAP, t0);
    takeoffOwn(off, 21);
    expect(newest(off).dataset).toMatchObject({ judge: 'unconfirmed', judgeOffset: '21', localOffset: '0' });
    off.game.destroy();
    const edge = await debugRound();
    const t1 = edge.clock.now() + 1_000;
    approachOwn(edge, 1, 1, t1, 5);
    edge.clock.t = t1 + 10;
    press(edge, TAP, t1);
    takeoffOwn(edge, 20);
    expect(newest(edge).dataset.judge).toBe('accepted');
  });

  it("a tap too old for the judge: outcome 'too-old', nothing to match", async () => {
    const h = await debugRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0 + 20;
    press(h, TAP, h.clock.now() - PACKET.maxAgeMs - 1);
    expect(newest(h).dataset).toMatchObject({ zone: 'tap', outcome: 'too-old', source: 'event', reason: '' });
    expect(h.session().sentOf('tap')).toEqual([]);
  });

  it("a stamp from the future: source 'fallback', reason 'later-than-now', the moment is the clock at handling", async () => {
    const h = await debugRound();
    const now = h.clock.now();
    press(h, GEAR, now + 50);
    expect(newest(h).dataset).toMatchObject({ zone: 'gear', timeStamp: String(now + 50), source: 'fallback', reason: 'later-than-now', clientTime: String(now), handledAt: String(now), outcome: 'sent' });
  });

  it("locally sent, but the judge saw no tap (offsetMs null): 'no-tap'", async () => {
    const h = await debugRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0 + 10;
    press(h, TAP, t0);
    takeoffOwn(h, null);
    expect(newest(h).dataset).toMatchObject({ judge: 'no-tap', judgeOffset: '' });
  });

  it("negative: another rider's take-off of the same fence and attempt is never matched", async () => {
    const h = await debugRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0 + 10;
    press(h, TAP, t0);
    takeoffOwn(h, 0, 'ana');
    expect(newest(h).dataset.judge).toBe('pending');
  });

  it("an automatic decision after a local 'sent' is not her tap: 'unconfirmed' under schoolmaster, and with the autopilot on", async () => {
    const school = await debugRound(true);
    const t0 = school.clock.now() + 1_000;
    approachOwn(school, 1, 1, t0, 5);
    school.clock.t = t0 + 10;
    press(school, TAP, t0);
    takeoffOwn(school, 5); // the schoolmaster's own take-off, close to her finger by chance
    expect(newest(school).dataset.judge).toBe('unconfirmed');
    school.game.destroy();
    const auto = await debugRound();
    const t1 = auto.clock.now() + 1_000;
    approachOwn(auto, 1, 1, t1, 5);
    auto.clock.t = t1 + 10;
    press(auto, TAP, t1);
    auto.session().emitMessage(roundEvent({ type: 'autopilot', riderId: 'host', at: auto.clock.now(), on: true }));
    auto.session().emitState(ridingState({ riders: { host: rider('host', { autopilot: true }), ana: rider('ana') } }));
    takeoffOwn(auto, 5);
    expect(newest(auto).dataset.judge).toBe('unconfirmed');
  });

  it('a new class clears the matching: a tap of class 1 is never matched to a verdict of class 2', async () => {
    const h = await debugRound();
    const t0 = h.clock.now() + 1_000;
    approachOwn(h, 1, 1, t0, 5);
    h.clock.t = t0 + 10;
    press(h, TAP, t0);
    await inResults(h);
    startClass(h, 2);
    await settle();
    takeoffOwn(h, 0);
    const tapRow = rows(h).find((row) => row.dataset.zone === 'tap');
    expect(tapRow?.dataset.judge).toBe('pending');
  });

  it('a turn that went out shows the quality of the own turn verdict', async () => {
    const h = await debugRound();
    turnAheadOwn(h);
    h.clock.t += 400;
    press(h, TURN_LEFT);
    expect(newest(h).dataset).toMatchObject({ zone: 'turn-left', outcome: 'sent', turnQuality: '' });
    turnVerdict(h, 'host', 'wide');
    expect(newest(h).dataset.turnQuality).toBe('wide');
  });

  it('the five latest presses, the newest first', async () => {
    const h = await debugRound();
    for (let i = 0; i < 6; i += 1) {
      h.clock.t += 100;
      press(h, GEAR);
    }
    expect(rows(h).map((row) => row.dataset.clientTime)).toEqual([10_600, 10_500, 10_400, 10_300, 10_200].map(String));
  });

  it('the line under the presses: FPS over the last second of frames and the draw calls of the scene', async () => {
    const h = await debugRound();
    h.scene.calls = 7;
    for (let i = 0; i <= 50; i += 1) h.game.frame(h.clock.now() + i * 20);
    const stats = q(h.root, '[data-debug] [data-debug-stats]');
    expect(Math.abs(Number(stats.dataset.fps) - 50)).toBeLessThanOrEqual(1);
    expect(stats.dataset.calls).toBe('7');
  });

  it('negative: the overlay sends nothing — the session hears only the gameplay messages', async () => {
    const h = await debugRound();
    press(h, GEAR);
    press(h, TURN_LEFT);
    h.game.frame(h.clock.now());
    expect(h.session().sent.map((m) => m.type)).toEqual(['gear', 'line']);
  });
});
