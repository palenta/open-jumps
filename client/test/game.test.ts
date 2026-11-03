// @vitest-environment happy-dom
// The application in a DOM (plan 2.2; the 1.7 cycle sign-in → home → lobby → course walk → round → results →
// again; 1.12 touch layout; 1.13 HUD; 2.3 instant hint and reconnection): createGame composed with fakes —
// happy-dom for the document, a scripted API, a scripted room session, a recording scene, a settable clock and
// window — and pinned through the DOM contract in game.ts (data attributes, pointerdown on the arena, the
// lifecycle events, the round modules re-created per class-course).
import type { ApproachState, CourseSpec, TakeoffOutcome } from '@open-jumps/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGame,
  type ApiLike,
  type ArenaRect,
  type ClockLike,
  type Game,
  type SceneFrame,
  type SceneLike,
  type SessionLike,
  type WindowLike,
} from '../src/app/game.js';
import type { ApiResult, CreateRoomReply } from '../src/net/api.js';
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

  constructor(private readonly stateOnConnect: LobbyStateSnapshot) {}

  connect(roomId: string, code: string): Promise<void> {
    this.connects.push([roomId, code]);
    this.reconnectionToken = `token-${String(this.connects.length)}`;
    this.state = this.stateOnConnect;
    this.emitStatus('connected');
    this.emitState(this.stateOnConnect);
    return Promise.resolve();
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

  send(message: ClientRoomMessage): void {
    this.sent.push(message);
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
}

/** Timers fired by hand (the lobby polling schedules one poll at a time). */
class ManualTimers {
  readonly pending: Timer[] = [];
  readonly cleared: unknown[] = [];
  private nextHandle = 1;

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const timer: Timer = { handle: this.nextHandle, fn, ms };
    this.nextHandle += 1;
    this.pending.push(timer);
    return timer.handle;
  };

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

const table: ClassTableWire = {
  '70': [
    { place: 1, riderId: 'ana', faults: 0, timeMs: 55_200, status: 'finished', eliminationReason: null, autopilot: false },
    { place: 2, riderId: 'host', faults: 4, timeMs: 60_100, status: 'finished', eliminationReason: null, autopilot: false },
  ],
};

const roundEvent = (event: RoundEventWire): ServerMessage => ({ type: 'round-event', event });

/** Points (CSS px) inside the phone layout zones for 844×390: tap x 422..692 y 58..292; gear x 758..836 y 304..382; turn-left x 0..152 y 97..292. */
const TAP: [number, number] = [500, 150];
const GEAR: [number, number] = [800, 345];
const TURN_LEFT: [number, number] = [10, 195];

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
  /** The state the next connect() installs. */
  settings: { stateOnConnect: LobbyStateSnapshot };
  /** The latest session. */
  session(): FakeSession;
}

interface BootOptions {
  script?: Script;
  stateOnConnect?: LobbyStateSnapshot;
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
  const settings = { stateOnConnect: options.stateOnConnect ?? snapshot() };
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
      const session = new FakeSession(settings.stateOnConnect);
      sessions.push(session);
      return session;
    },
    clock,
    scene,
    locale: 'en',
    measure: () => ({ ...arena }),
    timers,
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
function press(h: Harness, [x, y]: [number, number]): void {
  q(h.root, '[data-arena]').dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
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
async function hostInLobby(script: Script = {}, stateOnConnect: LobbyStateSnapshot = snapshot()): Promise<Harness> {
  const h = await boot({
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
    expect(text(h.root.querySelector('[data-focus]'))).toBe('1');
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

  it('the four controls are placed by the phone layout of 844×390', async () => {
    const h = await inRound();
    const gear = q(h.root, '[data-control="gear"]');
    expect(gear.style.left).toBe(`${String(844 - 78 - 8)}px`);
    expect(gear.style.top).toBe(`${String(390 - 78 - 8)}px`);
    expect(gear.style.width).toBe('78px');
    expect(gear.style.height).toBe('78px');
    expect(q(h.root, '[data-control="turn-left"]').style.left).toBe('0px');
    expect(q(h.root, '[data-control="tap"]').style.left).toBe('422px');
    expect(h.root.querySelector('[data-control="turn-right"]')).not.toBeNull();
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
    const gear = q(h.root, '[data-control="gear"]');
    expect(gear.style.left).toBe(`${String(756 - 76 - 8)}px`); // 672: inside the 756 px wide arena, not 844 − …
    expect(gear.style.top).toBe(`${String(369 - 76 - 8)}px`); // 285
    expect(gear.style.width).toBe('76px');
    expect(q(h.root, '[data-control="turn-left"]').style.left).toBe('0px');
    expect(q(h.root, '[data-control="tap"]').style.left).toBe(`${String(0.5 * 756)}px`);
  });

  it('when the browser bars appear (the arena shrinks to 756×320) resize() keeps the 2 cm pace square and moves it up', async () => {
    const h = await inRound();
    Object.assign(h.arena, { left: 44, top: 0, width: 756, height: 320 });
    h.game.resize();
    const gear = q(h.root, '[data-control="gear"]');
    expect(gear.style.top).toBe(`${String(320 - 76 - 8)}px`); // 236
    expect(gear.style.height).toBe('76px');
    const turnRight = q(h.root, '[data-control="turn-right"]');
    expect(Number.parseFloat(turnRight.style.top) + Number.parseFloat(turnRight.style.height)).toBeLessThanOrEqual(236);
  });
});

describe('pointer presses on the arena', () => {
  it('a press in the tap zone sends the take-off tap stamped with the device clock for fence 1, attempt 1', async () => {
    const h = await inRound();
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: h.clock.now(), fence: 1, attempt: 1 }]);
  });

  it('a second press in the tap zone during the same attempt sends nothing', async () => {
    const h = await inRound();
    press(h, TAP);
    h.clock.t += 50;
    press(h, TAP);
    expect(h.session().sentOf('tap')).toHaveLength(1);
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
    Object.assign(h.arena, { left: 44, top: 30, width: 756, height: 369 });
    h.game.resize();
    // The displayed pace square: arena-local x 672..748, y 285..361 → client x 716..792, y 315..391.
    press(h, [690, 340]); // local (646, 310): left of the square — untranslated (690, 340) would be inside it
    press(h, [720, 310]); // local (676, 280): just above the square (and below the right button) — untranslated (720, 310) would be inside it
    expect(h.session().sent).toEqual([]);
    press(h, [770, 340]); // local (726, 310): inside — untranslated x 770 would be right of the square
    press(h, [760, 370]); // local (716, 340): inside — untranslated y 370 would be below the square
    expect(h.session().sentOf('gear')).toEqual([
      { type: 'gear', gear: 'extended' },
      { type: 'gear', gear: 'gallop' },
    ]);
    // A finger on the safe-area inset, outside the arena, is nothing.
    press(h, [10, 195]);
    press(h, [500, 20]);
    expect(h.session().sent).toHaveLength(2);
    // The tap zone: arena-local x 378..620, y 55..277 → client x 422..664, y 85..307; (650, 90) is local (606, 60),
    // inside — untranslated x 650 would be right of the zone.
    press(h, [650, 90]);
    expect(h.session().sentOf('tap')).toEqual([{ type: 'tap', clientTime: h.clock.now(), fence: 1, attempt: 1 }]);
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
    const h = await inRound();
    press(h, TAP);
    expect(h.session().sentOf('tap')).toHaveLength(1);
    await inResults(h);
    h.clock.t += 60_000;
    startClass(h, 2);
    await settle();
    expect(h.root.dataset.screen).toBe('round');
    press(h, TAP);
    expect(h.session().sentOf('tap')).toEqual([
      { type: 'tap', clientTime: 10_000, fence: 1, attempt: 1 },
      { type: 'tap', clientTime: 70_000, fence: 1, attempt: 1 },
    ]);
  });
});

describe('the caption', () => {
  it('a tap at t0 shows the instant hint at once; the server verdict then replaces it', async () => {
    const h = await inRound();
    h.session().emitMessage(roundEvent({ type: 'approach', riderId: 'host', fence: 1, attempt: 1, t0: h.clock.now() + 100 }));
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
    h.session().emitMessage(roundEvent({ type: 'approach', riderId: 'host', fence: 1, attempt: 1, t0: h.clock.now() + 1_200 }));
    h.game.frame(h.clock.now());
    expect(tap.getAttribute('data-armed')).toBe('true');
    expect(tap.getAttribute('data-takeoff-at')).toBe(String(h.clock.now() + 1_200)); // offset 0: server time is device time
    h.session().emitMessage(roundEvent({ type: 'approach', riderId: 'ana', fence: 1, attempt: 1, t0: h.clock.now() + 900 }));
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

// ---- lifecycle ------------------------------------------------------------------------------------------------

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
