// Plan 2.3, matrix row 3: the instant hint runs the SAME judge as the server (judgeAttempt) on the client
// the moment the rider taps, with the approach the client can see (gear, line, hard turn — spooks and the
// lead horse unknown) and the tap translated through the clock estimate; the server's verdict closes it.
import {
  freezeForRound,
  judgeAttempt,
  NO_TAP_LIMIT_MS,
  RANKED_NO_ASSISTS,
  windowForAttempt,
  type ApproachState,
  type CourseSpec,
  type RoundRules,
  type TakeoffOutcome,
} from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { ClockSync } from '../../server/src/round/clockSync.js';
import { CourseRunner, RUN, type RunnerEvent } from '../../server/src/round/courseRunner.js';
import { ClientClock } from '../src/net/clientClock.js';
import { ApproachWindow } from '../src/round/approachWindow.js';
import { InstantHint, type Hint, type HintContext } from '../src/round/hint.js';
import { markerHalfLengths } from '../src/scene/takeoffMarker.js';

/** The favourable roll: a gallop tap in the clean tier keeps the rail up. */
const favourable = (): number => 1;

const context70: HintContext = { heightClass: 70, rules: RANKED_NO_ASSISTS };

const trainingWider: RoundRules = {
  mode: 'training',
  assists: freezeForRound({ schoolmaster: false, widerWindow: true }),
};

/** The approach the hint assumes: collected, straight, no hard turn; spooks and the lead horse unknown (false). */
const assumed = (over: Partial<ApproachState> = {}): ApproachState => ({
  gear: 'collected',
  heightClass: 70,
  angleSharp: false,
  recentHardTurn: false,
  spooked: false,
  leadHorseBonus: false,
  ...over,
});

/** The shared judge's verdict for the assumed approach, as the hint must reproduce it. */
const judged = (offsetMs: number | null, over: Partial<ApproachState> = {}, rules: RoundRules = RANKED_NO_ASSISTS): TakeoffOutcome =>
  judgeAttempt(assumed(over), offsetMs, favourable, rules);

/**
 * A ready clock whose server runs `offset` ms ahead of the device (three pings 200 ms apart, device at 1 000). Its
 * now() (1 600) comes before every tap the tests stamp, as a gear the state reports always reaches the hint before
 * the taps it applies to: the hint keeps a gear from the clock's now on (K1.1 step 6, ApproachWindow).
 */
function readyClock(offset: number): ClientClock {
  let t = 1_000;
  const clock = new ClientClock(() => t);
  for (let i = 0; i < 3; i += 1) {
    clock.onPing(t + offset);
    t += 200;
  }
  return clock;
}

/** A hint with an open approach for fence 1, attempt 1 at server time 6000. */
function armed(offset = 0, context: HintContext = context70): InstantHint {
  const hint = new InstantHint(readyClock(offset), context);
  hint.approach({ fence: 1, attempt: 1, t0: 6000 });
  return hint;
}

const T0 = 6000;

describe('InstantHint.tap', () => {
  it('is null before any approach was opened', () => {
    const hint = new InstantHint(readyClock(0), context70);
    expect(hint.tap(T0 + 10)).toBeNull();
    expect(hint.current()).toBeNull();
  });

  it('is null while the clock estimate is not ready (no translation of the tap into server time)', () => {
    const hint = new InstantHint(new ClientClock(() => 10_000), context70);
    hint.approach({ fence: 1, attempt: 1, t0: T0 });
    expect(hint.tap(T0 + 10)).toBeNull();
    expect(hint.current()).toBeNull();
  });

  it('a tap 10 ms after t0 on a collected approach is a perfect, not provisional hint, and current() shows it', () => {
    const hint = armed();
    const expected: Hint = { fence: 1, attempt: 1, offsetMs: 10, outcome: judged(10), provisional: false };
    expect(judged(10).kind).toBe('perfect');
    expect(hint.tap(T0 + 10)).toEqual(expected);
    expect(hint.current()).toEqual(expected);
  });

  it('applies the clock estimate: with the server 5 s ahead a device reading of t0 − 5000 + 10 is offset 10', () => {
    const hint = armed(5000);
    expect(hint.tap(T0 - 5000 + 10)?.offsetMs).toBe(10);
  });

  it('the first tap decides: a second tap in the same attempt is null and current() is unchanged', () => {
    const hint = armed();
    const first = hint.tap(T0 + 10);
    expect(first).not.toBeNull();
    expect(hint.tap(T0 + 300)).toBeNull();
    expect(hint.current()).toEqual(first);
  });

  it('a late tap outside the clean window is a chip, exactly as the shared judge says', () => {
    const hint = armed();
    const outcome = hint.tap(T0 + 300)?.outcome;
    expect(outcome).toEqual(judged(300));
    expect(outcome?.kind).toBe('chip');
  });

  it('a tap beyond the no-tap limit is judged as the no-tap outcome of that approach', () => {
    const hint = armed();
    const outcome = hint.tap(T0 - 700)?.outcome;
    expect(700).toBeGreaterThan(NO_TAP_LIMIT_MS);
    expect(outcome).toEqual(judged(-700));
    expect(outcome).toEqual(judged(null));
  });

  it('at gallop a tap in the clean tier outside the perfect band is provisional and judged with the favourable roll', () => {
    const hint = armed();
    hint.setGear('gallop');
    const result = hint.tap(T0 + 60);
    const window = windowForAttempt(assumed({ gear: 'gallop' }), RANKED_NO_ASSISTS);
    expect(60).toBeGreaterThan(window.perfectMs);
    expect(60).toBeLessThanOrEqual(window.cleanMs);
    expect(result?.outcome).toEqual(judged(60, { gear: 'gallop' }));
    expect(result?.outcome.kind).toBe('clean');
    expect(result?.provisional).toBe(true);
  });

  it('at gallop a tap inside the perfect band is still clean (gallop never scores perfect) and provisional', () => {
    const hint = armed();
    hint.setGear('gallop');
    const result = hint.tap(T0 + 10);
    expect(result?.outcome).toEqual(judged(10, { gear: 'gallop' }));
    expect(result?.outcome.kind).toBe('clean');
    expect(result?.provisional).toBe(true);
  });

  it('a gallop miss is a fall and not provisional: only the clean window depends on the roll', () => {
    const hint = armed();
    hint.setGear('gallop');
    const result = hint.tap(T0 + 200);
    expect(result?.outcome).toEqual(judged(200, { gear: 'gallop' }));
    expect(result?.outcome.kind).toBe('fall');
    expect(result?.provisional).toBe(false);
  });

  it('setGear back to collected judges with the collected window and is not provisional', () => {
    const hint = armed();
    hint.setGear('gallop');
    hint.setGear('collected');
    const result = hint.tap(T0 + 60);
    expect(result?.outcome).toEqual(judged(60));
    expect(result?.provisional).toBe(false);
  });

  it('setLine(angle) narrows the window: a tap that is clean on the centre line becomes the judge\'s sharp-angle verdict (a run-out)', () => {
    const hint = armed();
    hint.setLine('angle');
    const outcome = hint.tap(T0 + 140)?.outcome;
    expect(judged(140).kind).toBe('clean');
    expect(outcome).toEqual(judged(140, { angleSharp: true }));
    expect(outcome?.kind).toBe('runout');
  });

  it('setLine(center) after an angle restores the centre-line window', () => {
    const hint = armed();
    hint.setLine('angle');
    hint.setLine('center');
    expect(hint.tap(T0 + 140)?.outcome).toEqual(judged(140));
  });

  it('setHardTurn(true) narrows the window: a tap that is clean without it becomes the judge\'s hard-turn verdict (a chip)', () => {
    const hint = armed();
    hint.setHardTurn(true);
    const outcome = hint.tap(T0 + 140)?.outcome;
    expect(outcome).toEqual(judged(140, { recentHardTurn: true }));
    expect(outcome?.kind).toBe('chip');
  });

  it('the hard turn is cleared by the take-off that clears the fence: the next approach is judged without it', () => {
    const hint = armed();
    hint.setHardTurn(true);
    const first = hint.tap(T0 + 140);
    expect(first?.outcome.kind).toBe('chip');
    hint.verdict({ fence: 1, attempt: 1, outcome: judged(140, { recentHardTurn: true }), offsetMs: 140 });
    hint.approach({ fence: 2, attempt: 1, t0: 9000 });
    const second = hint.tap(9000 + 140);
    expect(second?.outcome).toEqual(judged(140));
    expect(second?.outcome.kind).toBe('clean');
  });

  it('the hard turn survives a refusal: the next attempt of the same fence is still judged with it, as on the server, and only the cleared take-off drops it (audit K1 r1 #8)', () => {
    const hint = armed();
    hint.setHardTurn(true);
    // No tap in time: on a bad approach (the hard turn) the verdict is a refusal — the fence is not cleared.
    const refusal = judged(null, { recentHardTurn: true });
    expect(refusal).toMatchObject({ kind: 'refusal', cleared: false });
    hint.verdict({ fence: 1, attempt: 1, outcome: refusal, offsetMs: null });
    hint.approach({ fence: 1, attempt: 2, t0: 9000 });
    const retry = hint.tap(9000 + 140);
    // 70 cm, collected, straight: clean up to 157.5 ms without the hard turn, 110.25 ms with it — the server keeps it.
    expect(retry?.outcome).toEqual(judged(140, { recentHardTurn: true }));
    expect(retry?.outcome.kind).toBe('chip');
    expect(judged(140).kind).toBe('clean');
    // The chip clears the fence: the hard turn is spent, fence 2 is judged without it.
    hint.verdict({ fence: 1, attempt: 2, outcome: judged(140, { recentHardTurn: true }), offsetMs: 140 });
    hint.approach({ fence: 2, attempt: 1, t0: 15_000 });
    expect(hint.tap(15_000 + 140)?.outcome).toEqual(judged(140));
  });

  it('a new approach for the next attempt of the same fence (after a refusal) re-arms the tap', () => {
    const hint = armed();
    expect(hint.tap(T0 + 500)).not.toBeNull();
    hint.approach({ fence: 1, attempt: 2, t0: 9000 });
    const retry = hint.tap(9000 + 10);
    expect(retry).toEqual({ fence: 1, attempt: 2, offsetMs: 10, outcome: judged(10), provisional: false });
    expect(hint.current()).toEqual(retry);
  });

  it('configure() with a higher class narrows the window: a tap that is clean at 70 cm is a chip at 90 cm', () => {
    const hint = armed();
    const at70 = windowForAttempt(assumed(), RANKED_NO_ASSISTS);
    const at90 = windowForAttempt(assumed({ heightClass: 90 }), RANKED_NO_ASSISTS);
    const offset = Math.ceil((at70.cleanMs + at90.cleanMs) / 2);
    hint.configure({ heightClass: 90, rules: RANKED_NO_ASSISTS });
    const outcome = hint.tap(T0 + offset)?.outcome;
    expect(judged(offset).kind).toBe('clean');
    expect(outcome).toEqual(judged(offset, { heightClass: 90 }));
    expect(outcome?.kind).toBe('chip');
  });

  it('configure() with training rules and the wider window widens the hint like the server: a ranked chip is a training clean', () => {
    const hint = armed(0, { heightClass: 70, rules: trainingWider });
    const outcome = hint.tap(T0 + 200)?.outcome;
    expect(judged(200).kind).toBe('chip');
    expect(outcome).toEqual(judged(200, {}, trainingWider));
    expect(outcome?.kind).toBe('clean');
  });
});

describe('InstantHint against the server judge: a hard turn, a refusal, the retry (audit K1 r1 #8)', () => {
  /**
   * The server fixture's course: collected canter is 5 m/s, so fence 1 (30 m) has t0 = 6000, the turn at 45 m its
   * moment at 9000 (missed → decided at 10 200, the horse stands 4 s at 45 m), fence 2 (60 m) opens at 48 m.
   */
  const course: CourseSpec = {
    id: 'hint-vs-judge',
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

  /** Tick every 50 ms from `from` (exclusive) to `until` (inclusive), feeding every event to the hint as the game does. */
  function drive(runner: CourseRunner, hint: InstantHint, from: number, until: number): RunnerEvent[] {
    const events: RunnerEvent[] = [];
    for (let t = from + RUN.tickMs; t <= until; t += RUN.tickMs) {
      for (const event of runner.tick(t)) {
        events.push(event);
        if (event.type === 'approach') hint.approach(event);
        else if (event.type === 'turn') hint.setHardTurn(event.outcome.hardTurn);
        else if (event.type === 'takeoff') hint.verdict(event);
      }
    }
    return events;
  }

  it('the missed turn narrows fence 2; the refusal without a tap keeps it narrow; the retry tap 140 ms late is a chip for both the hint and the judge; fence 3 is wide again', () => {
    const runner = new CourseRunner({ riderId: 'r1', course, heightClass: 70, rules: RANKED_NO_ASSISTS, seed: 'seed', startAt: 0 });
    const hint = new InstantHint(readyClock(0), context70);

    // Fence 1: a tap at t0, perfect on both sides.
    drive(runner, hint, 0, 6000);
    const first = hint.tap(6000);
    runner.tap({ actionTime: 6000, receiveTime: 6050, fence: 1, attempt: 1 });
    const firstVerdict = drive(runner, hint, 6000, 6050).find((e) => e.type === 'takeoff');
    expect(firstVerdict).toMatchObject({ outcome: { kind: 'perfect' } });
    expect(first?.outcome.kind).toBe('perfect');

    // The turn is missed (no press): '¡Recto!', a hard turn before fence 2 — the hint hears it from the turn event.
    const turn = drive(runner, hint, 6050, 10_200).find((e) => e.type === 'turn');
    expect(turn).toMatchObject({ outcome: { quality: 'missed', hardTurn: true } });

    // Fence 2, attempt 1: nobody taps; the bad approach ends in a refusal at the deadline.
    const approach1 = drive(runner, hint, 10_200, 14_800).find((e) => e.type === 'approach');
    expect(approach1).toMatchObject({ fence: 2, attempt: 1, t0: 17_200 });
    const refusal = drive(runner, hint, 14_800, 17_900).find((e) => e.type === 'takeoff');
    expect(refusal).toMatchObject({ fence: 2, attempt: 1, offsetMs: null, outcome: { kind: 'refusal', cleared: false }, approach: { recentHardTurn: true } });

    // Fence 2, attempt 2: the server still judges with the hard turn; a tap 140 ms late is a chip there — and here.
    const approach2 = drive(runner, hint, 17_900, 21_300).find((e) => e.type === 'approach');
    expect(approach2).toMatchObject({ fence: 2, attempt: 2, t0: 21_300 });
    const retry = hint.tap(21_300 + 140);
    runner.tap({ actionTime: 21_440, receiveTime: 21_450, fence: 2, attempt: 2 });
    const retryVerdict = drive(runner, hint, 21_300, 21_450).find((e) => e.type === 'takeoff');
    expect(retryVerdict).toMatchObject({ fence: 2, attempt: 2, offsetMs: 140, outcome: { kind: 'chip' }, approach: { recentHardTurn: true } });
    expect(retry?.outcome.kind).toBe('chip');
    expect(retry?.outcome).toEqual((retryVerdict as Extract<RunnerEvent, { type: 'takeoff' }>).outcome);

    // Fence 3: the cleared fence spent the hard turn on both sides; the same late tap is clean.
    // The horse lands at 63 m at 21 900 and reaches fence 3's zone (88 m) at 26 900: t0 = 29 300.
    const approach3 = drive(runner, hint, 21_450, 27_000).find((e) => e.type === 'approach');
    expect(approach3).toMatchObject({ fence: 3, attempt: 1, t0: 29_300 });
    const t0 = (approach3 as Extract<RunnerEvent, { type: 'approach' }>).t0;
    const third = hint.tap(t0 + 140);
    runner.tap({ actionTime: t0 + 140, receiveTime: t0 + 150, fence: 3, attempt: 1 });
    const thirdVerdict = drive(runner, hint, 27_000, t0 + 200).find((e) => e.type === 'takeoff');
    expect(thirdVerdict).toMatchObject({ fence: 3, outcome: { kind: 'clean' }, approach: { recentHardTurn: false } });
    expect(third?.outcome.kind).toBe('clean');
  });
});

describe('InstantHint against the server judge with an asymmetric round trip, at the edge of the window (audit K1 r3 #5)', () => {
  /** One fence at 30 m on the club course: collected canter 5 m/s, t0 = 6000 server ms. */
  const course: CourseSpec = { id: 'hint-vs-judge-clock', version: 1, lengthM: 50, speedMPerMin: 300, fences: [{ number: 1, distanceM: 30, type: 'vertical' }], turns: [] };
  /** The device runs 5 s ahead of the server; a ping takes 2 ms down, its pong 40 ms up. */
  const SKEW_MS = 5000;
  const DOWN_MS = 2;
  const UP_MS = 40;

  /**
   * The room's clock series between this device and the server: 8 pings 200 ms apart from server time 1000. The device
   * answers each at once (the session does); the server keeps its ClockSync; every refined offset it would announce
   * ('clock-offset') is heard by the device — or not, to see what the device's own estimate alone gives.
   */
  function measured(announce: boolean): { client: ClientClock; server: ClockSync } {
    let deviceNow = 0;
    const client = new ClientClock(() => deviceNow);
    const server = new ClockSync();
    for (let i = 0; i < 8; i += 1) {
      const serverSent = 1000 + i * 200;
      deviceNow = serverSent + DOWN_MS + SKEW_MS;
      const pong = client.onPing(serverSent);
      server.addSample({ serverSent, clientTime: pong.clientTime, serverReceived: serverSent + DOWN_MS + UP_MS });
      const offset = server.offsetMs;
      if (announce && offset !== null) client.onServerOffset(offset);
    }
    return { client, server };
  }

  /** The runner to its approach of fence 1; a tap `lateMs` after the take-off moment the device shows; both verdicts. */
  function tapAtEdge(clock: { client: ClientClock; server: ClockSync }, lateMs: number) {
    const runner = new CourseRunner({ riderId: 'r1', course, heightClass: 70, rules: RANKED_NO_ASSISTS, seed: 'seed', startAt: 0 });
    const hint = new InstantHint(clock.client, context70);
    let approach: Extract<RunnerEvent, { type: 'approach' }> | undefined;
    for (let t = RUN.tickMs; t <= 5000; t += RUN.tickMs) {
      for (const event of runner.tick(t)) if (event.type === 'approach') approach = event;
    }
    if (!approach) throw new Error('no approach');
    hint.approach(approach);
    const shownAt = clock.client.toClient(approach.t0); // data-takeoff-at
    if (shownAt === null) throw new Error('the clock is not ready');
    const tapAt = shownAt + lateMs; // the finger, in device time
    const shown = hint.tap(tapAt);
    const actionTime = clock.server.toServerTime(tapAt);
    if (actionTime === null) throw new Error('the server clock is not ready');
    runner.tap({ actionTime, receiveTime: actionTime + UP_MS, fence: 1, attempt: 1 });
    let verdict: Extract<RunnerEvent, { type: 'takeoff' }> | undefined;
    for (let t = 5000 + RUN.tickMs; t <= approach.t0 + 800; t += RUN.tickMs) {
      for (const event of runner.tick(t)) if (event.type === 'takeoff') verdict = event;
    }
    if (!verdict) throw new Error('no verdict');
    return { shown, verdict };
  }

  it("the device announced the server's offset: the zone and the hint use the judge's translation — a tap 1 ms past the clean window is a rail for both", () => {
    const clock = measured(true);
    expect(clock.server.rttMs).toBe(DOWN_MS + UP_MS);
    for (const t of [0, 6000, 123_456.5]) expect(clock.client.toServer(t)).toBeCloseTo(clock.server.toServerTime(t) ?? Number.NaN, 9);
    const edge = windowForAttempt(assumed(), RANKED_NO_ASSISTS).cleanMs;
    const { shown, verdict } = tapAtEdge(clock, edge + 1);
    expect(verdict.offsetMs).toBeCloseTo(edge + 1, 6);
    expect(verdict.outcome.kind).toBe('chip');
    expect(shown?.offsetMs).toBeCloseTo(edge + 1, 6);
    expect(shown?.outcome).toEqual(verdict.outcome);
    // And just inside the perfect window both say perfecta.
    const perfect = windowForAttempt(assumed(), RANKED_NO_ASSISTS).perfectMs;
    const inside = tapAtEdge(clock, perfect);
    expect(inside.verdict.outcome.kind).toBe('perfect');
    expect(inside.shown?.outcome).toEqual(inside.verdict.outcome);
  });

  it("without it the device's own estimate is rtt/2 off — the very disagreement the smoke route saw (the hint said clean, the judge a rail)", () => {
    const clock = measured(false);
    const own = clock.client.toServer(0) ?? Number.NaN;
    expect(Math.abs(own - (clock.server.toServerTime(0) ?? Number.NaN))).toBeCloseTo((DOWN_MS + UP_MS) / 2, 6);
  });
});

describe('InstantHint.verdict', () => {
  it('agrees when the server\'s kind matches the hint, then closes the approach: current() null, no more taps', () => {
    const hint = armed();
    const shown = hint.tap(T0 + 10);
    const verdict = judged(10);
    expect(hint.verdict({ fence: 1, attempt: 1, outcome: verdict, offsetMs: 10 })).toEqual({ hint: shown, verdict, agreed: true });
    expect(hint.current()).toBeNull();
    expect(hint.tap(T0 + 20)).toBeNull();
  });

  it('disagrees when the server knew more: a lead-horse clean where the hint said chip', () => {
    const hint = armed();
    const shown = hint.tap(T0 + 180);
    expect(shown?.outcome.kind).toBe('chip');
    const verdict = judged(180, { leadHorseBonus: true });
    expect(verdict.kind).toBe('clean');
    expect(hint.verdict({ fence: 1, attempt: 1, outcome: verdict, offsetMs: 180 })).toEqual({ hint: shown, verdict, agreed: false });
    expect(hint.current()).toBeNull();
  });

  it('has nothing to compare when the rider never tapped: hint null, agreed null, and the approach is closed', () => {
    const hint = armed();
    const verdict = judged(null);
    expect(hint.verdict({ fence: 1, attempt: 1, outcome: verdict, offsetMs: null })).toEqual({ hint: null, verdict, agreed: null });
    expect(hint.tap(T0 + 10)).toBeNull();
    expect(hint.current()).toBeNull();
  });

  it('a verdict for another fence or attempt is not compared with the hint (hint null, agreed null) and still closes the approach', () => {
    const hint = armed();
    expect(hint.tap(T0 + 10)).not.toBeNull();
    const verdict = judged(10);
    expect(hint.verdict({ fence: 2, attempt: 1, outcome: verdict, offsetMs: 10 })).toEqual({ hint: null, verdict, agreed: null });
    expect(hint.current()).toBeNull();
    expect(hint.tap(T0 + 20)).toBeNull();
  });
});

describe('InstantHint.sync (audit K1 r2 #1)', () => {
  it('opens the approach missed while away, with the server\'s hard turn: a tap is judged against its t0 with the narrowed window', () => {
    const hint = new InstantHint(readyClock(0), context70);
    expect(hint.tap(T0 + 140)).toBeNull(); // back from a drop: no approach heard
    hint.sync({ hardTurn: true, approach: { fence: 1, attempt: 2, t0: T0 } });
    const shown = hint.tap(T0 + 140);
    expect(shown).toMatchObject({ fence: 1, attempt: 2, offsetMs: 140 });
    expect(shown?.outcome).toEqual(judged(140, { recentHardTurn: true }));
    expect(shown?.outcome.kind).toBe('chip');
  });

  it('a sync of the approach already open and tapped keeps it tapped: no second hint for that attempt', () => {
    const hint = armed();
    const first = hint.tap(T0 + 10);
    hint.sync({ hardTurn: false, approach: { fence: 1, attempt: 1, t0: T0 } });
    expect(hint.tap(T0 + 50)).toBeNull();
    expect(hint.current()).toEqual(first);
  });

  it('a sync with no approach closes the open one (its verdict was missed) and drops a hard turn the server no longer has', () => {
    const hint = armed();
    hint.setHardTurn(true);
    hint.sync({ hardTurn: false, approach: null });
    expect(hint.tap(T0 + 10)).toBeNull();
    expect(hint.current()).toBeNull();
    hint.approach({ fence: 2, attempt: 1, t0: 9000 });
    expect(hint.tap(9000 + 140)?.outcome).toEqual(judged(140));
  });
});

// ---- K1.1 step 6: one source of the window for the hint and the marker ------------------------------------------

describe('InstantHint over the shared window source (K1.1 step 6)', () => {
  /** A hint over a given window source, with the approach of fence 1, attempt 1 at server time 6000 open. */
  function over(window: ApproachWindow): InstantHint {
    const hint = new InstantHint(readyClock(0), context70, window);
    hint.approach({ fence: 1, attempt: 1, t0: T0 });
    return hint;
  }

  it('the hint exposes the very source it was built over; without one it builds its own for the context', () => {
    const window = new ApproachWindow(context70);
    expect(over(window).approachWindow).toBe(window);
    expect(new InstantHint(readyClock(0), context70).approachWindow).toBeInstanceOf(ApproachWindow);
  });

  it("the hint's own setters reach the source: the line, the hard turn and the gear the marker reads are the hint's", () => {
    const window = new ApproachWindow(context70);
    const hint = over(window);
    hint.setLine('angle');
    hint.setHardTurn(true);
    hint.setGear('extended');
    expect(window.stateAt(T0)).toMatchObject({ angleSharp: true, recentHardTurn: true, gear: 'extended' });
  });

  it('the hint judges with the source: a sharp line and a hard turn set on the SOURCE narrow the hint\'s window too', () => {
    const window = new ApproachWindow(context70);
    window.setLine('angle');
    window.setHardTurn(true);
    const clean = window.windowAt(T0 + 10).cleanMs; // 157.5 × 0.8 × 0.7 = 88.2 ms
    expect(clean).toBeCloseTo(157.5 * 0.8 * 0.7, 6);
    expect(over(window).tap(T0 + Math.floor(clean))?.outcome.kind).toBe('clean');
    expect(over(window).tap(T0 + Math.ceil(clean) + 1)?.outcome.kind).toBe('runout'); // a miss off the sharp line
  });

  it('the same window for the hint and the marker for the same state: the band\'s half-length is the hint\'s clean bound at the approach speed', () => {
    const window = new ApproachWindow(context70);
    window.setLine('angle');
    const at = T0 + 20;
    const tiers = window.windowAt(at);
    const band = markerHalfLengths(tiers, 5);
    expect(band?.cleanHalfM).toBeCloseTo((tiers.cleanMs / 1000) * 5, 9);
    expect(band?.perfectHalfM).toBeCloseTo((tiers.perfectMs / 1000) * 5, 9);
    // Inside the band's clean bound the hint says clean, just outside it says the miss.
    expect(over(window).tap(T0 + Math.floor(tiers.cleanMs))?.outcome.kind).toBe('clean');
    expect(over(window).tap(T0 - Math.ceil(tiers.cleanMs) - 1)?.outcome.kind).toBe('runout');
  });

  it('negative: without a sharp line or a hard turn the same offset is clean, not a miss — the narrowing comes from the source alone', () => {
    const window = new ApproachWindow(context70);
    const narrowed = 157.5 * 0.8 * 0.7;
    expect(over(window).tap(T0 + Math.ceil(narrowed) + 1)?.outcome.kind).toBe('clean');
    expect(window.windowAt(T0).cleanMs).toBeCloseTo(157.5, 6);
  });
});
