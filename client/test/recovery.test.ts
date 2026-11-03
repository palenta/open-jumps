// The first controlled jump after a return (audit K1 r2 #1), through the app itself against the real server: the
// game (createGame on a happy-dom document that is NOT installed as the global `document`, so the SDK still sends
// the device's cookie as it does in Node) with real RoomSessions and the device's own ClientClock. The rider's
// connection goes away just before her approach opens, the server opens it while she is away (its 'approach'
// broadcast never reaches her), she comes back before the take-off moment — by the SDK's own retries, or by a
// fresh join through the Reconnect button — and her finger on the tap zone at t0 + 100 ms must go out and be judged
// by the server as her own take-off. And a finger the page handled too late for the judge (audit K1 r4 #1) is not a
// take-off at the moment of its handling: nothing goes out, and her next, timely tap is the one the server judges.
// K1.1 step 7 (matrix row 16): a tap after the clean tier while the approach is still open — the marker says "late"
// and the tap still goes out; the hint and the judge both call it a chip ("close", a rail down).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoomSession, type RetrySettings } from '../src/net/roomSession.js';
import type { RoundEventWire, ServerMessage } from '../src/net/types.js';
import { bootApp, newDevice, sleep, until, type Device, type LiveApp } from './helpers.js';
import { appFor, click, dom, dropFromServer, serverRider, tapZone, text, type AppUnderTest } from './liveGame.js';

let live: LiveApp;

beforeAll(async () => {
  live = await bootApp();
});

afterAll(async () => {
  await live?.close();
  await dom.happyDOM.close();
});

/**
 * The SDK's retries as in production (on), the first retry 1.5 s after the drop: dropped at ~2.4 s into the heat
 * (12 m), the rider is back at ~3.9 s — after her approach opened (18 m, 3.6 s), before its t0 (30 m, 6.0 s).
 */
const RETRY: RetrySettings = { minUptime: 0, maxRetries: 3, delay: 1000, minDelay: 1500, maxDelay: 1500 };
/** A drop the server keeps the seat for and the SDK never retries (an application close code): the session ends as lost. */
const UNRETRIED_DROP_CODE = 4005;
/** A drop the SDK retries by itself (GOING_AWAY). */
const RETRIABLE_DROP_CODE = 1001;

/**
 * The SDK's retries as in production (on), the first retry 400 ms after the drop: dropped right after her approach
 * opened (18 m, 3.6 s into the heat), the rider is back at ~4.1 s, well before its t0 (30 m, 6.0 s).
 */
const QUICK_RETRY: RetrySettings = { minUptime: 0, maxRetries: 3, delay: 400, minDelay: 400, maxDelay: 400 };

const roundEvents = <T extends RoundEventWire['type']>(messages: ServerMessage[], type: T, riderId: string) =>
  messages
    .filter((m): m is Extract<ServerMessage, { type: 'round-event' }> => m.type === 'round-event')
    .map((m) => m.event)
    .filter((e): e is Extract<RoundEventWire, { type: T }> => e.type === type && e.riderId === riderId);

/**
 * Maria hosts in the app; her friend Ana (a plain session that also rides, passively) is the witness: the server's
 * broadcasts reach Ana while Maria is away, so the test learns Maria's t0 from Ana's copy of the 'approach' event.
 */
async function classWithWitness(retry: RetrySettings = RETRY): Promise<{ maria: Device; app: AppUnderTest; witness: ServerMessage[]; ana: RoomSession }> {
  const maria = await newDevice(live, 'Maria');
  const anaDevice = await newDevice(live, 'Ana');
  const app = await appFor(maria, { retry });
  click(app.root, '[data-action="create-room"]');
  await until(() => (app.game.session?.state?.code ?? '') !== '' && app.root.dataset.screen === 'lobby', 5000, "Maria's lobby");
  const code = app.game.session?.state?.code ?? '';
  expect(await anaDevice.api.knock(code)).toEqual({ ok: true, value: { status: 'pending' } });
  expect((await maria.api.door(code, 'admit', anaDevice.profile.id)).ok).toBe(true);
  const ana = new RoomSession({ sdk: anaDevice.sdk(), clock: anaDevice.clock });
  const witness: ServerMessage[] = [];
  ana.onMessage((message) => witness.push(message));
  await ana.connect(app.roomId(), code);
  await until(() => maria.clock.ready() && anaDevice.clock.ready(), 5000, 'both clocks');
  await sleep(1000); // the rest of the series: the server's clock for both sessions is ready too
  await until(() => app.root.querySelector('[data-action="start-class"]:not([disabled])') !== null, 5000, 'the start button');
  click(app.root, '[data-action="start-class"]');
  await until(() => app.root.dataset.screen === 'round', 5000, "Maria's round screen");
  return { maria, app, witness, ana };
}

/** Wait for the server to open Maria's approach while she is away, and return it as Ana saw it. */
async function approachWhileAway(witness: ServerMessage[], riderId: string): Promise<Extract<RoundEventWire, { type: 'approach' }>> {
  await until(() => roundEvents(witness, 'approach', riderId).length > 0, 8000, "the server opening Maria's approach");
  const approach = roundEvents(witness, 'approach', riderId)[0];
  if (!approach) throw new Error('no approach');
  return approach;
}

/** Back in control before t0: the tap zone is lit for that approach, the finger lands 100 ms after t0, and the server judges it. */
async function firstJumpAfterReturn(maria: Device, app: AppUnderTest, approach: Extract<RoundEventWire, { type: 'approach' }>): Promise<void> {
  const id = maria.profile.id;
  // The broadcast went out while she was away: the app never got it.
  expect(roundEvents(app.received, 'approach', id)).toEqual([]);
  const takeoffAt = maria.clock.toClient(approach.t0);
  if (takeoffAt === null) throw new Error('the clock is not ready');
  expect(takeoffAt - maria.clock.now()).toBeGreaterThan(300); // she is back well before the take-off moment
  await until(() => app.root.querySelector('[data-control="tap"]')?.getAttribute('data-armed') === 'true', 1500, 'the tap zone lit for the approach in progress');
  expect(Number(app.root.querySelector('[data-control="tap"]')?.getAttribute('data-takeoff-at'))).toBeCloseTo(takeoffAt, 0);
  await sleep(Math.max(0, takeoffAt + 100 - maria.clock.now()));
  tapZone(app);
  expect(app.sent.filter((m) => m.type === 'tap')).toEqual([{ type: 'tap', clientTime: expect.any(Number), fence: approach.fence, attempt: approach.attempt }]);
  await until(() => roundEvents(app.received, 'takeoff', id).length > 0, 3000, "the server's verdict");
  const takeoff = roundEvents(app.received, 'takeoff', id)[0];
  expect(takeoff).toMatchObject({ fence: approach.fence, attempt: approach.attempt });
  // Judged from HER tap (an offset), not as "no tap" at the deadline, and not by the autopilot.
  expect(takeoff?.offsetMs).not.toBeNull();
  expect(takeoff?.offsetMs ?? 0).toBeGreaterThan(40);
  expect(takeoff?.offsetMs ?? 0).toBeLessThan(250);
  expect(['clean', 'perfect', 'chip']).toContain(takeoff?.outcome.kind);
  expect(roundEvents(app.received, 'autopilot', id).at(-1)).toMatchObject({ on: false });
}

describe('the first controlled jump after a return (audit K1 r2 #1)', () => {
  it('the SDK recovers by itself before t0 of an approach opened while she was away: the tap zone is armed for it, and her tap goes out and is judged', async () => {
    const { maria, app, witness, ana } = await classWithWitness();
    const id = maria.profile.id;
    const roomId = app.roomId();
    await until(() => (serverRider(roomId, id)?.positionM ?? 0) >= 12, 5000, 'Maria at 12 m');
    dropFromServer(roomId, id, RETRIABLE_DROP_CODE);
    await until(() => app.game.session?.status === 'dropped', 2000, 'the drop');
    const approach = await approachWhileAway(witness, id);
    expect(app.game.session?.status).toBe('dropped'); // the approach opened during the drop
    await until(() => app.game.session?.status === 'connected', 5000, 'the SDK reconnecting by itself');
    expect(app.root.dataset.screen).toBe('round');
    await firstJumpAfterReturn(maria, app, approach);
    app.game.destroy();
    await ana.leave();
  }, 40000);

  it('a fresh join through the Reconnect button before t0 of an approach opened while she was away: the new session is armed for it, and her tap goes out and is judged', async () => {
    const { maria, app, witness, ana } = await classWithWitness();
    const id = maria.profile.id;
    const roomId = app.roomId();
    await until(() => (serverRider(roomId, id)?.positionM ?? 0) >= 12, 5000, 'Maria at 12 m');
    dropFromServer(roomId, id, UNRETRIED_DROP_CODE);
    await until(() => app.root.dataset.screen === 'ended', 3000, 'the ended screen (lost)');
    const approach = await approachWhileAway(witness, id);
    const first = app.game.session;
    click(app.root, '[data-action="reconnect"]');
    await until(() => app.game.session !== first && app.game.session?.status === 'connected' && app.root.dataset.screen === 'round', 5000, 'a fresh session on the round screen');
    await firstJumpAfterReturn(maria, app, approach);
    app.game.destroy();
    await ana.leave();
  }, 40000);

  it('a press during the drop spends nothing: the SDK recovers before t0, and her first tap that really goes out is the take-off the server judges (audit K1 r3 #1)', async () => {
    const { maria, app, ana } = await classWithWitness(QUICK_RETRY);
    const id = maria.profile.id;
    const roomId = app.roomId();
    // The approach reaches her while she is connected: the zone is lit for it.
    await until(() => roundEvents(app.received, 'approach', id).length > 0, 8000, 'her approach');
    const approach = roundEvents(app.received, 'approach', id)[0];
    if (!approach) throw new Error('no approach');
    await until(() => app.root.querySelector('[data-control="tap"]')?.getAttribute('data-armed') === 'true', 1500, 'the tap zone lit');
    dropFromServer(roomId, id, RETRIABLE_DROP_CODE);
    await until(() => app.game.session?.status === 'dropped', 2000, 'the drop');
    // A finger on the lit zone while the session cannot send: nothing goes out, and nothing is spent.
    tapZone(app);
    expect(app.attempted.filter((m) => m.type === 'tap')).toHaveLength(1);
    expect(app.sent.filter((m) => m.type === 'tap')).toEqual([]);
    await until(() => app.game.session?.status === 'connected', 5000, 'the SDK reconnecting by itself');
    await until(() => app.received.some((m) => m.type === 'approach-sync'), 2000, 'the approach-sync of the return');
    expect(app.received.filter((m) => m.type === 'approach-sync').at(-1)).toMatchObject({ approach: { fence: approach.fence, attempt: approach.attempt, t0: approach.t0 } });
    const takeoffAt = maria.clock.toClient(approach.t0);
    if (takeoffAt === null) throw new Error('the clock is not ready');
    expect(takeoffAt - maria.clock.now()).toBeGreaterThan(300); // back well before the take-off moment
    expect(app.root.querySelector('[data-control="tap"]')?.getAttribute('data-armed')).toBe('true');
    await sleep(Math.max(0, takeoffAt + 100 - maria.clock.now()));
    tapZone(app);
    // The first tap that really went out is this one, for the approach in progress.
    const taps = app.sent.filter((m) => m.type === 'tap');
    expect(taps).toEqual([{ type: 'tap', clientTime: expect.any(Number), fence: approach.fence, attempt: approach.attempt }]);
    expect(taps[0]?.clientTime ?? 0).toBeGreaterThan(takeoffAt);
    // The server judged HER tap (an offset), not a missing tap at the deadline and not the autopilot.
    await until(() => roundEvents(app.received, 'takeoff', id).length > 0, 3000, "the server's verdict");
    const takeoff = roundEvents(app.received, 'takeoff', id)[0];
    expect(takeoff).toMatchObject({ fence: approach.fence, attempt: approach.attempt });
    expect(takeoff?.offsetMs).not.toBeNull();
    expect(takeoff?.offsetMs ?? 0).toBeGreaterThan(40);
    expect(takeoff?.offsetMs ?? 0).toBeLessThan(250);
    expect(['clean', 'perfect', 'chip']).toContain(takeoff?.outcome.kind);
    app.game.destroy();
    await ana.leave();
  }, 40000);
});

describe('a touch the page handled too late for the judge (audit K1 r4 #1)', () => {
  it('a correct timeStamp 1.5 s old handled at t0 + 20 ms: no tap reaches the server; her timely tap that follows is the take-off the server judges, from its own moment', async () => {
    const { maria, app, ana } = await classWithWitness();
    const id = maria.profile.id;
    await until(() => roundEvents(app.received, 'approach', id).length > 0, 8000, 'her approach');
    const approach = roundEvents(app.received, 'approach', id)[0];
    if (!approach) throw new Error('no approach');
    const takeoffAt = maria.clock.toClient(approach.t0);
    if (takeoffAt === null) throw new Error('the clock is not ready');
    await until(() => app.root.querySelector('[data-control="tap"]')?.getAttribute('data-armed') === 'true', 1500, 'the tap zone lit');
    await sleep(Math.max(0, takeoffAt + 20 - maria.clock.now()));
    // The finger landed 1.5 s ago; the page gets round to it only now, right at the take-off moment.
    tapZone(app, maria.clock.now() - 1_520);
    expect(app.attempted.filter((m) => m.type === 'tap')).toEqual([]);
    expect(app.root.querySelector('[data-control="tap"]')?.getAttribute('data-armed')).toBe('true');
    await sleep(Math.max(0, takeoffAt + 100 - maria.clock.now()));
    const touch = maria.clock.now();
    tapZone(app, touch);
    expect(app.sent.filter((m) => m.type === 'tap')).toEqual([{ type: 'tap', clientTime: touch, fence: approach.fence, attempt: approach.attempt }]);
    await until(() => roundEvents(app.received, 'takeoff', id).length > 0, 3000, "the server's verdict");
    const takeoff = roundEvents(app.received, 'takeoff', id)[0];
    expect(takeoff).toMatchObject({ fence: approach.fence, attempt: approach.attempt });
    // Judged from the timely touch, translated as the server translates it — not from the moment the stale one was handled.
    const expected = (maria.clock.toServer(touch) ?? Number.NaN) - approach.t0;
    expect(Math.abs((takeoff?.offsetMs ?? Number.NaN) - expected)).toBeLessThanOrEqual(1);
    expect(['clean', 'perfect', 'chip']).toContain(takeoff?.outcome.kind);
    app.game.destroy();
    await ana.leave();
  }, 40000);
});

describe('a late tap while the approach is still open (K1.1 step 7, matrix row 16)', () => {
  it('past t0 + cleanMs the marker reads late; the tap at t0 + 250 ms still goes out, and the hint and the judge both call it batida corta with a rail', async () => {
    const { maria, app, ana } = await classWithWitness();
    const id = maria.profile.id;
    await until(() => roundEvents(app.received, 'approach', id).length > 0, 8000, 'her approach');
    const approach = roundEvents(app.received, 'approach', id)[0];
    if (!approach) throw new Error('no approach');
    const takeoffAt = maria.clock.toClient(approach.t0);
    if (takeoffAt === null) throw new Error('the clock is not ready');
    // 70 cm in collected canter: the clean tier is ±157.5 ms, the "no tap" limit ±400 ms. 250 ms late is a chip.
    await sleep(Math.max(0, takeoffAt + 250 - maria.clock.now()));
    app.game.frame(maria.clock.now());
    expect(app.frames.at(-1)?.takeoff).toMatchObject({ fence: approach.fence, state: 'late' });
    const touch = maria.clock.now();
    tapZone(app, touch);
    expect(app.sent.filter((m) => m.type === 'tap')).toEqual([{ type: 'tap', clientTime: touch, fence: approach.fence, attempt: approach.attempt }]);
    expect(app.root.querySelector('[data-control="tap"]')?.getAttribute('data-pressed')).toBe('sent');
    expect(text(app.root.querySelector('[data-hud-caption]'))).toBe(`Dakota: batida corta at fence ${String(approach.fence)} — derribo`); // the instant hint
    await until(() => roundEvents(app.received, 'takeoff', id).length > 0, 3000, "the server's verdict");
    const takeoff = roundEvents(app.received, 'takeoff', id)[0];
    expect(takeoff?.offsetMs ?? 0).toBeGreaterThan(157.5);
    expect(takeoff?.offsetMs ?? 999).toBeLessThanOrEqual(400);
    expect(takeoff?.outcome).toMatchObject({ kind: 'chip', label: 'batida_corta', faults: 4, cleared: true });
    app.game.frame(maria.clock.now());
    expect(app.frames.at(-1)?.takeoff ?? null).toBeNull(); // the verdict puts the band out
    app.game.destroy();
    await ana.leave();
  }, 40000);
});
