// The smoke route (plan 2.9 row 19) through the client's own modules against the real server, in Node: the
// host creates a room → a friend enters the code → the host lets her in → heights → course walk → a round where
// the friend taps at her t0 (her clock 5 s ahead) and sees the instant hint confirmed by the server → the
// results table → "again". Playwright drives the same route in a browser later; this proves the modules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { screenFor } from '../src/app/screens.js';
import { hudModel, resultsModel, type HudNames } from '../src/hud/viewModel.js';
import { InputController } from '../src/input/controller.js';
import { LobbyFlow } from '../src/lobby/lobbyFlow.js';
import { lobbyModel } from '../src/lobby/lobbyModel.js';
import { RoomSession } from '../src/net/roomSession.js';
import type { ClientRoomMessage, RoundEventWire, ServerMessage } from '../src/net/types.js';
import { InstantHint, type Hint, type Reconciliation } from '../src/round/hint.js';
import { walkModel } from '../src/walk/walkModel.js';
import { bootApp, LIVE_COURSE, newDevice, until, type Device, type LiveApp } from './helpers.js';

let live: LiveApp;

beforeAll(async () => {
  live = await bootApp();
});

afterAll(async () => {
  await live?.close();
});

/** One player: her device, her room session and the round-side modules wired as the app wires them. */
class Player {
  readonly session: RoomSession;
  readonly controller: InputController;
  readonly hint: InstantHint;
  readonly messages: ServerMessage[] = [];
  readonly hints: Hint[] = [];
  readonly reconciliations: Reconciliation[] = [];
  /** Every command the controller sent (the session is the only way out). */
  readonly sent: ClientRoomMessage[] = [];
  caption = '';
  classNumber = 0;

  constructor(readonly device: Device, readonly tapOffsetMs: number | null) {
    this.session = new RoomSession({ sdk: device.sdk(), clock: device.clock });
    this.controller = new InputController({
      send: (m) => {
        this.sent.push(m);
        this.session.send(m);
      },
    });
    this.hint = new InstantHint(device.clock, { heightClass: 70, rules: { mode: 'ranked', assists: { schoolmaster: false, widerWindow: false } } });
    this.session.onMessage((m) => this.onMessage(m));
    this.session.onState((state) => {
      const own = state.riders[device.profile.id];
      this.controller.update({
        riding: state.phase === 'riding' && own !== undefined && own.status === 'riding',
        round: `${this.classNumber}#${state.heatIndex}`,
        nextFence: own?.nextFence ?? 1,
        attempt: own?.attempt ?? 1,
      });
    });
  }

  get id(): string {
    return this.device.profile.id;
  }

  private onMessage(m: ServerMessage): void {
    this.messages.push(m);
    if (m.type === 'class-course') this.classNumber = m.classNumber;
    if (m.type !== 'round-event' || m.event.riderId !== this.id) return;
    const event = m.event;
    if (event.type === 'approach') {
      this.hint.approach(event);
      this.controller.approach(event);
      if (this.tapOffsetMs === null) return;
      const tapAt = this.device.clock.toClient(event.t0);
      if (tapAt === null) throw new Error('clock not ready at the approach');
      setTimeout(() => {
        const now = this.device.clock.now();
        const hint = this.hint.tap(now);
        if (hint) {
          this.hints.push(hint);
          this.caption = hint.outcome.label;
        }
        this.controller.press('tap', now);
      }, Math.max(0, tapAt + this.tapOffsetMs - this.device.clock.now()));
    } else if (event.type === 'takeoff') {
      const reconciliation = this.hint.verdict(event);
      this.controller.approachClosed();
      this.reconciliations.push(reconciliation);
      this.caption = event.outcome.label;
    }
  }

  eventsOf<T extends RoundEventWire['type']>(type: T): Extract<RoundEventWire, { type: T }>[] {
    return this.messages
      .filter((m): m is Extract<ServerMessage, { type: 'round-event' }> => m.type === 'round-event')
      .map((m) => m.event)
      .filter((e): e is Extract<RoundEventWire, { type: T }> => e.type === type && e.riderId === this.id);
  }

  table() {
    return this.messages.find((m): m is Extract<ServerMessage, { type: 'class-table' }> => m.type === 'class-table')?.table ?? null;
  }
}

describe('the smoke route through the client modules', () => {
  it('create → code → ring → admit → heights → walk → round with a confirmed hint → results → again', async () => {
    const hostDevice = await newDevice(live, 'FlowHost');
    const friendDevice = await newDevice(live, 'FlowFriend', 5000); // her tablet runs 5 s ahead
    const names: HudNames = {
      [hostDevice.profile.id]: { riderName: hostDevice.profile.riderName, ponyName: 'Dakota', ponyGender: 'yegua' },
      [friendDevice.profile.id]: { riderName: friendDevice.profile.riderName, ponyName: 'Dakota', ponyGender: 'yegua' },
    };

    // Home → the host creates a room and is in; the friend rings and waits.
    expect(screenFor({ signedIn: false, room: 'none', phase: null })).toBe('signin');
    expect(screenFor({ signedIn: true, room: 'none', phase: null })).toBe('home');
    const hostFlow = new LobbyFlow({ api: hostDevice.api });
    const created = await hostFlow.create();
    if (created.kind !== 'ready') throw new Error(`host flow: ${created.kind}`);
    expect(created.role).toBe('host');
    const { code, roomId } = created;

    const friendFlow = new LobbyFlow({ api: friendDevice.api });
    const ringing = friendFlow.enter(code.toLowerCase()); // typed in lower case on the keyboard
    await until(() => friendFlow.phase.kind === 'waiting', 3000, 'the friend waiting at the door');
    expect(screenFor({ signedIn: true, room: 'joining', phase: null })).toBe('lobby');

    // The host is in the room; the lobby model shows the friend ringing with her club (none) and lets her in.
    const host = new Player(hostDevice, null); // the host never taps: her horse jumps by itself ("close", a rail)
    await host.session.connect(roomId, code);
    const view = await hostDevice.api.lobby(code);
    if (!view.ok) throw new Error(view.error);
    const state = host.session.state;
    if (!state) throw new Error('no state');
    const hostLobby = lobbyModel({ state, view: view.value, ownId: host.id, ponyCategory: 'C', heightClass: 70, assists: { schoolmaster: false, widerWindow: false }, locale: 'en' });
    expect(hostLobby.isHost).toBe(true);
    expect(hostLobby.pending).toEqual([{ accountId: friendDevice.profile.id, name: `${friendDevice.profile.riderName} on Dakota`, club: null }]);
    expect(hostLobby.canStart).toBe(true);
    await hostDevice.api.door(code, 'admit', friendDevice.profile.id);
    const admitted = await ringing;
    expect(admitted).toEqual({ kind: 'ready', code, roomId, role: 'guest' });

    const friend = new Player(friendDevice, 110); // taps 110 ms after t0: inside the clean tier, outside perfect
    await friend.session.connect(roomId, code);
    await until(() => Object.keys(host.session.state?.participants ?? {}).length === 2, 3000, 'two participants');
    expect(screenFor({ signedIn: true, room: 'joined', phase: host.session.state?.phase ?? null })).toBe('lobby');
    friend.session.send({ type: 'height', heightClass: 70 });
    await until(() => friendDevice.clock.ready() && hostDevice.clock.ready(), 5000, 'both clocks ready');

    // The host starts: the course walk shows the one fence; then the round.
    host.session.send({ type: 'start-class', order: 'random' });
    await until(() => friend.session.state?.phase === 'walk', 5000, "phase 'walk' on the friend's device");
    expect(screenFor({ signedIn: true, room: 'joined', phase: 'walk' })).toBe('walk');
    const course = friend.session.course();
    expect(course).toEqual(LIVE_COURSE);
    const walk = walkModel(LIVE_COURSE, 70, 'en');
    expect(walk.fences.map((f) => f.text)).toEqual(['Fence 1: vertical, 70 cm']);
    expect(walk.timeText).toBe('Time allowed 12 s · limit 24 s');

    await until(() => friend.session.state?.phase === 'riding', 5000, "phase 'riding'");
    expect(screenFor({ signedIn: true, room: 'joined', phase: 'riding' })).toBe('round');
    await until(() => friend.eventsOf('takeoff').length > 0 && host.eventsOf('takeoff').length > 0, 10000, 'both take-offs');

    // The friend's tap: the instant hint said 'clean'; the server agreed; the host's horse jumped by itself.
    expect(friend.hints).toHaveLength(1);
    expect(friend.hints[0]?.outcome.kind).toBe('clean');
    expect(friend.hints[0]?.provisional).toBe(false);
    expect(friend.reconciliations).toEqual([{ hint: friend.hints[0], verdict: friend.eventsOf('takeoff')[0]?.outcome, agreed: true }]);
    const friendTakeoff = friend.eventsOf('takeoff')[0];
    expect(friendTakeoff?.outcome.kind).toBe('clean');
    expect(friendTakeoff?.offsetMs ?? 0).toBeGreaterThan(60);
    expect(friendTakeoff?.offsetMs ?? 0).toBeLessThan(170);
    expect(host.eventsOf('takeoff')[0]).toMatchObject({ offsetMs: null, outcome: { kind: 'chip', faults: 4 } });
    expect(host.reconciliations).toEqual([{ hint: null, verdict: host.eventsOf('takeoff')[0]?.outcome, agreed: null }]);

    // The HUD on the friend's device after her fence: her caption, her faults, the clock running.
    await until(() => (friend.session.state?.riders[friend.id]?.lastLabel ?? '') !== '', 2000, 'the label in the state');
    const friendState = friend.session.state;
    if (!friendState) throw new Error('no state');
    const hud = hudModel({ state: friendState, ownId: friend.id, locale: 'en', names, fenceCount: 1, caption: friend.caption, requestedGear: friend.controller.requestedGear });
    expect(hud).toMatchObject({ phase: 'riding', riding: true, spectating: false, faults: 0, gear: 'collected', gearText: 'galope reunido', caption: 'cero_faltas', phaseText: 'manga 1' });
    expect(hud.nextFence).toBeNull(); // the only fence is behind her; the line is ahead
    expect(hud.riders.map((r) => r.name).sort()).toEqual([`${hostDevice.profile.riderName} on Dakota`, `${friendDevice.profile.riderName} on Dakota`].sort());
    expect(Number.parseFloat(hud.timeText)).toBeGreaterThan(5);

    // Results: one table for 70 cm, the friend first with no faults, the host second with her rail.
    await until(() => friend.session.state?.phase === 'done', 20000, "phase 'done'");
    expect(screenFor({ signedIn: true, room: 'joined', phase: 'results' })).toBe('results');
    expect(screenFor({ signedIn: true, room: 'joined', phase: 'done' })).toBe('results');
    const table = friend.table();
    if (!table) throw new Error('no class table');
    const results = resultsModel(table, names, 'en', friend.id);
    expect(results.map((c) => c.heightClass)).toEqual([70]);
    expect(results[0]?.rows.map((r) => [r.placeText, r.name, r.faults, r.note, r.isOwn])).toEqual([
      ['1', `${friendDevice.profile.riderName} on Dakota`, 0, '', true],
      ['2', `${hostDevice.profile.riderName} on Dakota`, 4, '', false],
    ]);
    expect(results[0]?.rows[0]?.timeText).toMatch(/^\d+\.\d$/);

    // Again: the host starts a second class in the same room; the course is announced anew.
    const hostLobbyAgain = lobbyModel({ state: host.session.state!, view: null, ownId: host.id, ponyCategory: 'C', heightClass: 70, assists: { schoolmaster: false, widerWindow: false }, locale: 'en' });
    expect(hostLobbyAgain.canStart).toBe(true);
    host.session.send({ type: 'start-class', order: 'random' });
    await until(() => friend.session.state?.phase === 'walk', 5000, "the second class's walk");
    expect(friend.messages.filter((m) => m.type === 'class-course').map((m) => (m as { classNumber: number }).classNumber)).toEqual([1, 2]);

    // The second class is a fresh round for the client modules: the friend's first tap goes out again (fence 1,
    // attempt 1, like the first class), gets a hint and is judged by the server; the horse starts from the line.
    await until(() => friend.session.state?.phase === 'riding', 5000, "the second class riding");
    expect(friend.session.state?.riders[friend.id]?.positionM ?? 99).toBeLessThan(5);
    await until(() => friend.eventsOf('takeoff').length === 2, 10000, 'the second take-off');
    expect(friend.sent.filter((m) => m.type === 'tap')).toEqual([
      { type: 'tap', clientTime: expect.any(Number), fence: 1, attempt: 1 },
      { type: 'tap', clientTime: expect.any(Number), fence: 1, attempt: 1 },
    ]);
    expect(friend.hints).toHaveLength(2);
    expect(friend.reconciliations.map((r) => r.agreed)).toEqual([true, true]);
    expect(friend.eventsOf('takeoff')[1]).toMatchObject({ offsetMs: expect.any(Number), outcome: { kind: 'clean' } });
    await until(() => friend.session.state?.phase === 'done', 20000, "the second class done");

    await friend.session.leave();
    await host.session.leave();
    friendFlow.stop();
    hostFlow.stop();
  }, 60000);
});
