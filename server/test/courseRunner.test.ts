// Matrix row 3 (server side), row 8 and plan 1.8 on one horse: fixed take-off moments, taps judged as of their
// action time, "no tap" at the deadline, refusals and falls with restarts, turns with timing, schoolmaster,
// autopilot, the finish and the time limit. Everything below is in server milliseconds with the start at 0; the
// moments come from the THREE_FENCE_COURSE fixture (t0 = 6000 / 12 000 / 20 000, turn moment 9000, finish 24 000).
import { BASE_WINDOW, RANKED_NO_ASSISTS, freezeForRound, type RoundRules } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { CourseRunner, RUN, type RunnerDeps, type RunnerEvent, type TapResult } from '../src/round/courseRunner.js';
import { LIMIT_EDGE_COURSE, SLOW_LIMIT_COURSE, THREE_FENCE_COURSE as COURSE } from './fixtures/courses.js';

const SCHOOLMASTER: RoundRules = { mode: 'ranked', assists: freezeForRound({ schoolmaster: true, widerWindow: false }) };

function runner(over: Partial<RunnerDeps> = {}): CourseRunner {
  return new CourseRunner({ riderId: 'r1', course: COURSE, heightClass: 60, rules: RANKED_NO_ASSISTS, seed: 'seed', startAt: 0, ...over });
}

/** Tick every 50 ms from `from` (exclusive) up to `until` (inclusive), collecting events. */
function drive(r: CourseRunner, from: number, until: number, events: RunnerEvent[] = []): RunnerEvent[] {
  for (let t = from + RUN.tickMs; t <= until; t += RUN.tickMs) events.push(...r.tick(t));
  return events;
}

/** Tick from `from` until an event matches; returns the event and the tick it came with. */
function driveUntil(r: CourseRunner, from: number, match: (e: RunnerEvent) => boolean, limit = 120_000): { event: RunnerEvent; at: number } {
  for (let t = from + RUN.tickMs; t <= limit; t += RUN.tickMs) {
    const event = r.tick(t).find(match);
    if (event) return { event, at: t };
  }
  throw new Error('event not reached');
}

/** The first tick strictly after `time` (packets are submitted before the tick they belong to). */
const nextTick = (time: number) => (Math.floor(time / RUN.tickMs) + 1) * RUN.tickMs;

const tap = (actionTime: number, receiveTime: number, fence = 1, attempt = 1) => ({ actionTime, receiveTime, fence, attempt });

describe('running and the approach', () => {
  it('constants of the model', () => {
    expect(RUN).toMatchObject({ tickMs: 50, approachZoneM: 12, landingAdvanceM: 3, flightMs: 600, restartBackM: 2, refusalDelayMs: 3000, fallDelayMs: 8000, turnZoneM: 10, autopilotMaxMs: 10_000, historyMs: 1000, leadHorseMs: 2000 });
  });

  it('moves at the gear speed and fixes t0 when entering the approach zone', () => {
    const r = runner();
    expect(r.snapshot()).toMatchObject({ positionM: 0, gear: 'collected', phase: 'running', nextFence: 1, attempt: 1, t0: null, autopilot: false, usedAutopilot: false });
    const events = drive(r, 0, 3550);
    expect(r.snapshot()).toMatchObject({ positionM: 17.75, phase: 'running', t0: null });
    expect(events).toEqual([]);
    expect(r.tick(3600)).toEqual([{ type: 'approach', fence: 1, attempt: 1, t0: 6000 }]);
    expect(r.snapshot()).toMatchObject({ positionM: 18, phase: 'approach', t0: 6000 });
    expect(r.elapsedMs(3600)).toBe(3600);
  });

  it('extended canter is 6 m/s and the gear in force follows the request outside the approach', () => {
    const r = runner();
    r.setGear('extended', 1000);
    drive(r, 0, 2000);
    expect(r.snapshot().positionM).toBeCloseTo(11, 6); // 5 m in the first second, 6 m in the second
    expect(r.snapshot()).toMatchObject({ gear: 'extended', requestedGear: 'extended' });
  });

  it('inside the approach the speed stays frozen while gear and line changes are logged for judging', () => {
    const r = runner();
    drive(r, 0, 6000);
    r.setGear('gallop', 6150);
    r.setLine('angle', 6150);
    expect(r.snapshot().positionM).toBe(30); // at the take-off point from t0 on
    expect(r.approachAt(6100)).toMatchObject({ gear: 'collected', angleSharp: false, heightClass: 60, recentHardTurn: false, spooked: false, leadHorseBonus: false });
    expect(r.approachAt(6200)).toMatchObject({ gear: 'gallop', angleSharp: true });
    expect(r.approachAt(3599)).toBeNull();
  });
});

describe('taps and the decision moment (matrix row 3)', () => {
  it('an admissible tap decides at once: offset 0 is perfect, the horse flies from t0 and lands at 33 m at 6600', () => {
    const r = runner();
    drive(r, 0, 6000);
    const result = r.tap(tap(6000, 6050));
    expect(result).toEqual({ kind: 'judged', verdict: { accepted: true, offsetMs: 0 }, decision: { decided: true, offsetMs: 0, decidedAt: 6050 } });
    const events = r.tick(6050);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'takeoff', fence: 1, attempt: 1, decidedAt: 6050, offsetMs: 0, outcome: { kind: 'perfect', faults: 0, cleared: true } });
    expect(r.snapshot()).toMatchObject({ phase: 'flight', positionM: 30 });
    drive(r, 6050, 6550);
    expect(r.snapshot()).toMatchObject({ phase: 'flight', positionM: 30 });
    r.tick(6600);
    expect(r.snapshot()).toMatchObject({ phase: 'running', positionM: 33, nextFence: 2, attempt: 1, t0: null });
    r.tick(6650);
    expect(r.snapshot().positionM).toBe(33.25);
    expect(r.round.faults).toBe(0);
  });

  it('a delayed tap is judged by the state at its action time, not at receipt (rewind)', () => {
    const r = runner();
    drive(r, 0, 6100);
    r.setGear('gallop', 6150);
    drive(r, 6100, 6300);
    const result = r.tap(tap(6100, 6350)); // age 250 ≤ 300; the action happened while still collected
    expect(result).toMatchObject({ kind: 'judged', verdict: { accepted: true, offsetMs: 100 } });
    const [event] = r.tick(6350);
    expect(event).toMatchObject({ type: 'takeoff', offsetMs: 100, outcome: { kind: 'clean' }, approach: { gear: 'collected' } });
  });

  it('no tap: fixed at t0 + 700 on a good approach as a chip (4 faults); the horse lands at the decision', () => {
    const r = runner();
    const events = drive(r, 0, 6650);
    expect(events.filter((e) => e.type === 'takeoff')).toHaveLength(0);
    expect(r.snapshot()).toMatchObject({ phase: 'approach', positionM: 30 });
    const [event] = r.tick(6700);
    expect(event).toMatchObject({ type: 'takeoff', decidedAt: 6700, offsetMs: null, outcome: { kind: 'chip', faults: 4, cleared: true } });
    expect(r.snapshot()).toMatchObject({ phase: 'running', positionM: 33, nextFence: 2 });
    expect(r.round.faults).toBe(4);
    expect(r.round.entries).toEqual([{ fence: 1, attempt: 1, kind: 'chip', faults: 4, label: 'batida_corta' }]);
  });

  it('a packet older than 300 ms is rejected and does not decide; "no tap" is fixed only at the deadline', () => {
    const r = runner();
    drive(r, 0, 6200);
    expect(r.tap(tap(5820, 6220))).toMatchObject({ kind: 'judged', verdict: { accepted: false, reason: 'too-old' }, decision: { decided: false } });
    const events = drive(r, 6200, 6650);
    expect(events.filter((e) => e.type === 'takeoff')).toHaveLength(0);
    expect(r.tick(6700)[0]).toMatchObject({ type: 'takeoff', offsetMs: null, decidedAt: 6700 });
  });

  it('a packet received exactly at the deadline is accepted (offset +400 is a chip); later ones are ignored', () => {
    const r = runner();
    drive(r, 0, 6650);
    expect(r.tap(tap(6400, 6700))).toMatchObject({ kind: 'judged', verdict: { accepted: true, offsetMs: 400 }, decision: { decided: true, offsetMs: 400, decidedAt: 6700 } });
    expect(r.tick(6700)[0]).toMatchObject({ type: 'takeoff', offsetMs: 400, outcome: { kind: 'chip' } });
    expect(r.tap(tap(6400, 6701))).toMatchObject({ kind: 'judged', verdict: { accepted: false, reason: 'after-deadline' } });
  });

  it('a second packet with the same key is a duplicate; a packet for another attempt is wrong-attempt; outside an approach it is ignored', () => {
    const r = runner();
    expect(r.tap(tap(100, 150))).toEqual({ kind: 'ignored', reason: 'no-approach' });
    drive(r, 0, 6000);
    r.tap(tap(6000, 6050));
    expect(r.tap(tap(6010, 6060))).toMatchObject({ kind: 'judged', verdict: { accepted: false, reason: 'duplicate' } });
    expect(r.tap(tap(6010, 6060, 1, 2))).toMatchObject({ kind: 'judged', verdict: { accepted: false, reason: 'wrong-attempt' } });
  });

  it('the lead-horse bonus widens only the clean tier: +200 ms is clean with it and a chip without it', () => {
    const withBonus = runner({ leadHorse: (fence, t0) => fence === 1 && t0 === 6000 });
    drive(withBonus, 0, 6200);
    withBonus.tap(tap(6200, 6250));
    expect(withBonus.tick(6250)[0]).toMatchObject({ type: 'takeoff', outcome: { kind: 'clean' }, approach: { leadHorseBonus: true } });
    expect(BASE_WINDOW.cleanMs * 1.25).toBeGreaterThan(200);

    const without = runner();
    drive(without, 0, 6200);
    without.tap(tap(6200, 6250));
    expect(without.tick(6250)[0]).toMatchObject({ type: 'takeoff', outcome: { kind: 'chip' }, approach: { leadHorseBonus: false } });
  });

  it('a sharp line turns a miss into a run-out (4 for the disobedience, fence to be re-attempted)', () => {
    const r = runner();
    r.setLine('angle', 100);
    drive(r, 0, 6300);
    r.tap(tap(6300, 6350));
    expect(r.tick(6350)[0]).toMatchObject({ type: 'takeoff', outcome: { kind: 'runout', cleared: false }, approach: { angleSharp: true } });
    expect(r.round.faults).toBe(4);
    expect(r.snapshot()).toMatchObject({ phase: 'stopped', positionM: 28, nextFence: 1, attempt: 2 });
  });

  it('three falls restart the fence without counting as disobediences; attempt 4 is judged like any other', () => {
    const r = runner();
    r.setGear('gallop', 100); // 7 m/s: the zone opens at 2600, t0 is not a whole number — every moment below comes from the events
    let cursor = 100;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const { event, at } = driveUntil(r, cursor, (e) => e.type === 'approach' && e.attempt === attempt);
      if (event.type !== 'approach') throw new Error('approach expected');
      if (attempt > 1) r.setGear('gallop', at); // after a restart the gear in force is collected; ask for gallop again (judging only)
      const missAt = event.t0 + 300; // a miss at gallop is a fall
      const receiveAt = nextTick(missAt);
      drive(r, at, receiveAt - RUN.tickMs);
      expect(r.tap(tap(missAt, receiveAt, 1, attempt))).toMatchObject({ kind: 'judged', verdict: { accepted: true } });
      const [fall] = r.tick(receiveAt);
      expect(fall).toMatchObject({ type: 'takeoff', fence: 1, attempt, outcome: { kind: 'fall', faults: 8, cleared: false } });
      expect(r.snapshot()).toMatchObject({ phase: 'stopped', positionM: 28, nextFence: 1, attempt: attempt + 1 });
      expect(r.round.status).toBe('riding');
      cursor = receiveAt;
    }
    expect(r.round.faults).toBe(24);
    const { event, at } = driveUntil(r, cursor, (e) => e.type === 'approach' && e.attempt === 4);
    if (event.type !== 'approach') throw new Error('approach expected');
    r.setGear('collected', at);
    const receiveAt = nextTick(event.t0);
    drive(r, at, receiveAt - RUN.tickMs);
    expect(r.tap(tap(event.t0, receiveAt, 1, 4))).toMatchObject({ kind: 'judged', verdict: { accepted: true, offsetMs: 0 } });
    expect(r.tick(receiveAt)[0]).toMatchObject({ type: 'takeoff', attempt: 4, outcome: { kind: 'perfect', cleared: true } });
    expect(r.round.faults).toBe(24);
    expect(r.round.entries.map((e) => [e.attempt, e.kind])).toEqual([[1, 'fall'], [2, 'fall'], [3, 'fall'], [4, 'perfect']]);
    expect(r.snapshot()).toMatchObject({ nextFence: 2, attempt: 1 });
  });
});

// The engine submits every packet with receiveTime ≤ T before tick(T); a packet stamped T that arrives after
// tick(T) (the same millisecond, later in the event loop) keeps its TRUE times for the age, future and deadline
// rules, and the decision it makes — dated T — is applied at the start of the next tick.
describe('packets stamped with the last tick\'s own millisecond, submitted after that tick', () => {
  const takeoffs = (events: RunnerEvent[]) => events.filter((e) => e.type === 'takeoff');

  it('true age exactly 300 (action 6000, received 6300): accepted, offset 0, decided at 6300; the take-off is applied at the next tick', () => {
    const r = runner();
    drive(r, 0, 6300);
    expect(r.tap(tap(6000, 6300))).toEqual({ kind: 'judged', verdict: { accepted: true, offsetMs: 0 }, decision: { decided: true, offsetMs: 0, decidedAt: 6300 } });
    const events = r.tick(6350);
    expect(events).toMatchObject([{ type: 'takeoff', fence: 1, attempt: 1, decidedAt: 6300, offsetMs: 0, outcome: { kind: 'perfect', faults: 0, cleared: true } }]);
    expect(r.snapshot()).toMatchObject({ phase: 'flight', positionM: 30, nextFence: 2 });
    drive(r, 6350, 6600);
    expect(r.snapshot()).toMatchObject({ phase: 'running', positionM: 33 }); // landed at t0 + 600 as usual
  });

  it('true age 301 (action 5999, received 6300): too old; "no tap" is fixed at the deadline', () => {
    const r = runner();
    drive(r, 0, 6300);
    expect(r.tap(tap(5999, 6300))).toMatchObject({ kind: 'judged', verdict: { accepted: false, reason: 'too-old' }, decision: { decided: false } });
    expect(takeoffs(drive(r, 6300, 6700))).toMatchObject([{ decidedAt: 6700, offsetMs: null, outcome: { kind: 'chip' } }]);
  });

  it('from the future by exactly 100 ms (action 6400, received 6300): accepted, offset +400; by 101 ms: rejected', () => {
    const accepted = runner();
    drive(accepted, 0, 6300);
    expect(accepted.tap(tap(6400, 6300))).toMatchObject({ kind: 'judged', verdict: { accepted: true, offsetMs: 400 }, decision: { decided: true, offsetMs: 400, decidedAt: 6300 } });
    expect(accepted.tick(6350)).toMatchObject([{ type: 'takeoff', decidedAt: 6300, offsetMs: 400, outcome: { kind: 'chip', cleared: true } }]);

    const rejected = runner();
    drive(rejected, 0, 6300);
    expect(rejected.tap(tap(6401, 6300))).toMatchObject({ kind: 'judged', verdict: { accepted: false, reason: 'future' }, decision: { decided: false } });
    expect(rejected.tick(6350)).toEqual([]);
    expect(takeoffs(drive(rejected, 6350, 6700))).toMatchObject([{ decidedAt: 6700, offsetMs: null }]);
  });

  it('the deadline millisecond: the engine ticks only completed milliseconds, so a packet stamped 6700 always reaches the judge before tick(6700) and is a chip; 6701 is after the deadline', () => {
    const r = runner();
    drive(r, 0, 6650);
    r.tick(6699);
    expect(r.tap(tap(6400, 6700))).toMatchObject({ kind: 'judged', verdict: { accepted: true, offsetMs: 400 }, decision: { decided: true, offsetMs: 400, decidedAt: 6700 } });
    expect(takeoffs(drive(r, 6699, 7000))).toMatchObject([{ decidedAt: 6700, offsetMs: 400, outcome: { kind: 'chip', cleared: true } }]);
    expect(r.tap(tap(6400, 6701))).toMatchObject({ kind: 'judged', verdict: { accepted: false, reason: 'after-deadline' } });
    expect(r.round.faults).toBe(4);
    expect(r.snapshot()).toMatchObject({ nextFence: 2 });
  });

  it('a late chip stamped 6650 (action 6400, age 250): decided at 6650 and landed at that very moment, at the start of the next tick', () => {
    const r = runner();
    drive(r, 0, 6650);
    expect(r.tap(tap(6400, 6650))).toMatchObject({ kind: 'judged', verdict: { accepted: true, offsetMs: 400 }, decision: { decidedAt: 6650 } });
    expect(r.tick(6700)).toMatchObject([{ type: 'takeoff', decidedAt: 6650, offsetMs: 400, outcome: { kind: 'chip', cleared: true } }]);
    expect(r.snapshot()).toMatchObject({ phase: 'running', positionM: 33.25, nextFence: 2 }); // landed at 6650 at 33 m, then 50 ms of running
  });

  it('a turn press stamped at the last tick (9000), submitted after it: applied at the next tick with decidedAt = that stamp', () => {
    const r = runner();
    drive(r, 0, 6000);
    r.tap(tap(6000, 6050));
    drive(r, 6000, 9000);
    expect(r.turn({ choice: 'left', actionTime: 9000, receiveTime: 9000 })).toMatchObject({ kind: 'judged', outcome: { quality: 'tight', stopSec: 0 } });
    expect(r.tick(9050)).toMatchObject([{ type: 'turn', distanceM: 45, decidedAt: 9000, outcome: { quality: 'tight' } }]);
    expect(r.turn({ choice: 'left', actionTime: 9050, receiveTime: 9100 })).toEqual({ kind: 'ignored', reason: 'no-turn' });
    expect(drive(r, 9050, 12000).find((e) => e.type === 'approach')).toMatchObject({ fence: 2, t0: 12000 });
    expect(r.approachAt(12000)?.recentHardTurn).toBe(false);
  });

  it('a wrong turn stamped at the last tick: the 6 s stop runs from that stamp', () => {
    const r = runner();
    drive(r, 0, 6000);
    r.tap(tap(6000, 6050));
    drive(r, 6000, 9000);
    expect(r.turn({ choice: 'right', actionTime: 9000, receiveTime: 9000 })).toMatchObject({ kind: 'judged', outcome: { quality: 'wrong', stopSec: 6 } });
    expect(r.tick(9050)).toMatchObject([{ type: 'turn', decidedAt: 9000, outcome: { quality: 'wrong' } }]);
    expect(r.snapshot()).toMatchObject({ phase: 'stopped', positionM: 45 });
    drive(r, 9050, 14950);
    expect(r.snapshot().phase).toBe('stopped');
    r.tick(15000);
    expect(r.snapshot()).toMatchObject({ phase: 'running', positionM: 45 });
  });

  it('a duplicate tap stamped at the last tick: no exception and no second take-off', () => {
    const r = runner();
    drive(r, 0, 6000);
    expect(r.tap(tap(6000, 6000))).toMatchObject({ kind: 'judged', verdict: { accepted: true, offsetMs: 0 }, decision: { decidedAt: 6000 } });
    expect(r.tick(6050)).toMatchObject([{ type: 'takeoff', decidedAt: 6000, offsetMs: 0, outcome: { kind: 'perfect' } }]);
    let result: TapResult | undefined;
    expect(() => { result = r.tap(tap(6010, 6050)); }).not.toThrow();
    expect(result).toMatchObject({ kind: 'judged', verdict: { accepted: false, reason: 'duplicate' }, decision: { decided: true, offsetMs: 0, decidedAt: 6000 } });
    expect(takeoffs(drive(r, 6050, 6700))).toEqual([]);
    expect(r.snapshot()).toMatchObject({ nextFence: 2, attempt: 1 });
    expect(r.round.faults).toBe(0);
  });
});

describe('turns, refusals, restarts and the finish', () => {
  it('the turn zone announces the moment; a tight turn costs nothing; at gallop it still counts as a hard turn', () => {
    const r = runner();
    drive(r, 0, 6000);
    r.tap(tap(6000, 6050));
    const toTurn = drive(r, 6000, 8950);
    expect(toTurn.find((e) => e.type === 'turn-ahead')).toEqual({ type: 'turn-ahead', distanceM: 45, at: 9000 });
    expect(r.turn({ choice: 'left', actionTime: 9000, receiveTime: 9050 })).toMatchObject({ kind: 'judged', outcome: { quality: 'tight', hardTurn: false, stopSec: 0 } });
    const events = drive(r, 8950, 12000);
    expect(events.find((e) => e.type === 'turn')).toMatchObject({ type: 'turn', distanceM: 45, decidedAt: 9050 });
    expect(events.find((e) => e.type === 'approach')).toMatchObject({ fence: 2, t0: 12000 });
    expect(r.approachAt(12000)?.recentHardTurn).toBe(false);
  });

  it('a late press is a wide turn: gear drops to collected and the next window is narrowed', () => {
    const r = runner();
    drive(r, 0, 6000);
    r.tap(tap(6000, 6050));
    drive(r, 6000, 9450);
    expect(r.turn({ choice: 'left', actionTime: 9500, receiveTime: 9550 })).toMatchObject({ kind: 'judged', outcome: { quality: 'wide', hardTurn: true, stopSec: 0 } });
    r.tick(9500);
    r.tick(9550);
    expect(r.snapshot()).toMatchObject({ gear: 'collected', requestedGear: 'collected' });
    const approach = drive(r, 9550, 12000).find((e) => e.type === 'approach');
    expect(approach).toMatchObject({ fence: 2, t0: 12000 });
    expect(r.approachAt(12000)?.recentHardTurn).toBe(true);
  });

  it('a missed turn: "¡Recto!", back at the turn point for 4 s, hard turn; then a refusal without a tap, a restart and the finish with time faults', () => {
    const r = runner();
    drive(r, 0, 6000);
    r.tap(tap(6000, 6050));
    const events = drive(r, 6000, 10150);
    expect(events.filter((e) => e.type === 'turn')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'approach')).toHaveLength(0); // an undecided turn keeps the approach closed
    const [missed] = r.tick(10200); // 9000 + 900 + 300
    expect(missed).toMatchObject({ type: 'turn', decidedAt: 10200, outcome: { quality: 'missed', stopSec: 4, hardTurn: true, label: 'recto' } });
    expect(r.snapshot()).toMatchObject({ phase: 'stopped', positionM: 45 });
    drive(r, 10200, 14150);
    expect(r.snapshot()).toMatchObject({ phase: 'stopped', positionM: 45 });
    r.tick(14200);
    expect(r.snapshot()).toMatchObject({ phase: 'running', positionM: 45 });
    const approach = drive(r, 14200, 14800).find((e) => e.type === 'approach');
    expect(approach).toMatchObject({ fence: 2, attempt: 1, t0: 17200 });
    expect(r.approachAt(17200)?.recentHardTurn).toBe(true);
    const refusal = drive(r, 14800, 17900).find((e) => e.type === 'takeoff');
    expect(refusal).toMatchObject({ decidedAt: 17900, offsetMs: null, outcome: { kind: 'refusal', cleared: false, faults: 0 } });
    expect(r.round.faults).toBe(4);
    expect(r.snapshot()).toMatchObject({ phase: 'stopped', positionM: 58, nextFence: 2, attempt: 2 });
    const restart = drive(r, 17900, 20900);
    expect(restart.find((e) => e.type === 'restart')).toMatchObject({ fence: 2, attempt: 2, at: 20900 });
    expect(restart.find((e) => e.type === 'approach')).toMatchObject({ fence: 2, attempt: 2, t0: 21300 });
    expect(r.tap(tap(21300, 21350, 2, 1))).toMatchObject({ kind: 'judged', verdict: { accepted: false, reason: 'wrong-attempt' } });
    expect(r.tap(tap(21300, 21350, 2, 2))).toMatchObject({ kind: 'judged', verdict: { accepted: true, offsetMs: 0 } });
    expect(drive(r, 20900, 21350).find((e) => e.type === 'takeoff')).toMatchObject({ outcome: { kind: 'perfect' }, approach: { recentHardTurn: true } });
    expect(drive(r, 21350, 29300).find((e) => e.type === 'approach')).toMatchObject({ fence: 3, t0: 29300 });
    expect(r.approachAt(29300)?.recentHardTurn).toBe(false);
    r.tap(tap(29300, 29350, 3, 1));
    const finish = drive(r, 29300, 33300).find((e) => e.type === 'finish');
    expect(finish).toEqual({ type: 'finish', at: 33300, elapsedMs: 33300 });
    expect(r.round.status).toBe('finished');
    expect(r.round.faults).toBe(14); // 4 for the refusal + 10 time faults (33.3 s over 24 s allowed)
    expect(r.snapshot().phase).toBe('done');
    expect(r.elapsedMs(40000)).toBe(33300);
  });

  it('the wrong direction: "recorrido equivocado", 6 s at the turn point', () => {
    const r = runner();
    drive(r, 0, 6000);
    r.tap(tap(6000, 6050));
    drive(r, 6000, 9000);
    expect(r.turn({ choice: 'right', actionTime: 9000, receiveTime: 9050 })).toMatchObject({ kind: 'judged', outcome: { quality: 'wrong', stopSec: 6, label: 'recorrido_equivocado' } });
    r.tick(9050);
    expect(r.snapshot()).toMatchObject({ phase: 'stopped', positionM: 45 });
    drive(r, 9050, 15000);
    expect(r.snapshot().phase).toBe('stopped');
    r.tick(15050);
    expect(r.snapshot()).toMatchObject({ phase: 'running', positionM: 45 });
    expect(r.turn({ choice: 'left', actionTime: 15000, receiveTime: 15100 })).toEqual({ kind: 'ignored', reason: 'no-turn' });
  });

  it('turn packets: too old or from the future are ignored, a second press is a duplicate', () => {
    const r = runner();
    drive(r, 0, 6000);
    r.tap(tap(6000, 6050));
    drive(r, 6000, 9000);
    expect(r.turn({ choice: 'left', actionTime: 8600, receiveTime: 9000 })).toEqual({ kind: 'ignored', reason: 'too-old' });
    expect(r.turn({ choice: 'left', actionTime: 9200, receiveTime: 9000 })).toEqual({ kind: 'ignored', reason: 'future' });
    expect(r.turn({ choice: 'left', actionTime: 9000, receiveTime: 9040 })).toMatchObject({ kind: 'judged' });
    expect(r.turn({ choice: 'right', actionTime: 9010, receiveTime: 9045 })).toEqual({ kind: 'ignored', reason: 'duplicate' });
  });

  it('a clean run (tap, turn, tap, tap in time order) finishes at 24 000 with no faults', () => {
    const r = runner();
    const all: RunnerEvent[] = [];
    drive(r, 0, 6000, all);
    r.tap(tap(6000, 6050));
    drive(r, 6000, 9000, all);
    r.turn({ choice: 'left', actionTime: 9000, receiveTime: 9050 });
    drive(r, 9000, 12000, all);
    r.tap(tap(12000, 12050, 2));
    drive(r, 12000, 20000, all);
    r.tap(tap(20000, 20050, 3));
    drive(r, 20000, 24000, all);
    expect(all.filter((e) => e.type === 'takeoff').map((e) => (e.type === 'takeoff' ? e.outcome.kind : ''))).toEqual(['perfect', 'perfect', 'perfect']);
    expect(all.find((e) => e.type === 'finish')).toEqual({ type: 'finish', at: 24000, elapsedMs: 24000 });
    expect(r.round).toMatchObject({ status: 'finished', faults: 0 });
    expect(r.snapshot().phase).toBe('done');
  });

  it('reaching the time limit on course eliminates by time (the line at 60.1 s against a 60 s limit)', () => {
    const slow = runner({ course: SLOW_LIMIT_COURSE });
    const events = drive(slow, 0, 60000);
    expect(events.find((e) => e.type === 'eliminated')).toEqual({ type: 'eliminated', at: 60000, reason: 'time' });
    expect(slow.round).toMatchObject({ status: 'eliminated', eliminationReason: 'time' });
    expect(slow.snapshot().phase).toBe('done');
  });
});

describe('the line and the limit inside one tick: exactly one terminal event', () => {
  const terminal = (events: RunnerEvent[]) => events.filter((e) => e.type === 'finish' || e.type === 'eliminated');

  /** LIMIT_EDGE_COURSE without assists: a chip tap received at `receiveAt` (age 300) decides and lands there; the line is 1350 ms later. */
  function rideToTheLine(receiveAt: number): { r: CourseRunner; events: RunnerEvent[] } {
    const r = runner({ course: LIMIT_EDGE_COURSE });
    const events = drive(r, 0, 58600);
    expect(r.tap(tap(receiveAt - 300, receiveAt))).toMatchObject({ kind: 'judged', verdict: { accepted: true }, decision: { decided: true, decidedAt: receiveAt } });
    drive(r, 58600, 60200, events);
    const takeoffs = events.filter((e) => e.type === 'takeoff');
    expect(takeoffs).toHaveLength(1);
    expect(takeoffs[0]).toMatchObject({ type: 'takeoff', decidedAt: receiveAt, outcome: { kind: 'chip', cleared: true } });
    return { r, events };
  }

  it('the line 1 ms before the limit: finished with time faults, and the limit a millisecond later changes nothing', () => {
    const { r, events } = rideToTheLine(58649);
    const [event, ...rest] = terminal(events);
    expect(rest).toEqual([]);
    if (event?.type !== 'finish') throw new Error(`finish expected, got ${JSON.stringify(event)}`);
    expect(event.at).toBeCloseTo(59999, 6);
    expect(event.at).toBeLessThan(60000);
    expect(event.elapsedMs).toBe(event.at);
    expect(r.round).toMatchObject({ status: 'finished', faults: 34 }); // 4 for the chip + 30 started seconds over the 30 s allowed
    expect(r.snapshot().phase).toBe('done');
    expect(r.elapsedMs(70000)).toBe(event.at);
  });

  it('the line exactly at the limit: eliminated by time once (the limit is not applied a second time)', () => {
    const { r, events } = rideToTheLine(58650);
    expect(terminal(events)).toEqual([{ type: 'eliminated', at: 60000, reason: 'time' }]);
    expect(r.round).toMatchObject({ status: 'eliminated', eliminationReason: 'time' });
    expect(r.snapshot()).toMatchObject({ phase: 'done', positionM: LIMIT_EDGE_COURSE.lengthM });
    expect(r.elapsedMs(70000)).toBe(60000);
  });

  it('the line 1 ms after the limit: eliminated at the limit moment once; the horse never reaches the line', () => {
    const { r, events } = rideToTheLine(58651);
    expect(terminal(events)).toEqual([{ type: 'eliminated', at: 60000, reason: 'time' }]);
    expect(r.round).toMatchObject({ status: 'eliminated', eliminationReason: 'time' });
    expect(r.snapshot().phase).toBe('done');
    expect(r.snapshot().positionM).toBeLessThan(LIMIT_EDGE_COURSE.lengthM);
  });

  it('schoolmaster on SLOW_LIMIT_COURSE: auto take-off ≈ 58 100, landing at 58 600 at 293 m, the line at 300 m exactly at the 60 s limit', () => {
    const r = runner({ course: SLOW_LIMIT_COURSE, rules: SCHOOLMASTER });
    const events = drive(r, 0, 60200);
    const takeoff = events.find((e) => e.type === 'takeoff');
    if (takeoff?.type !== 'takeoff' || takeoff.offsetMs === null) throw new Error('auto take-off expected');
    expect(takeoff).toMatchObject({ fence: 1, outcome: { kind: 'clean', cleared: true } });
    expect(takeoff.decidedAt).toBeLessThan(58600);
    expect(terminal(events)).toEqual([{ type: 'eliminated', at: 60000, reason: 'time' }]);
    expect(r.round).toMatchObject({ status: 'eliminated', eliminationReason: 'time', faults: 0 });
    expect(r.snapshot()).toMatchObject({ phase: 'done', positionM: 300 });
  });
});

describe('schoolmaster, autopilot and withdrawal (matrix rows 8, 9)', () => {
  it('schoolmaster takes off by itself in the clean tier, never perfect, and ignores the rider\'s taps', () => {
    const r = runner({ rules: SCHOOLMASTER });
    drive(r, 0, 5000);
    expect(r.tap(tap(5000, 5050))).toEqual({ kind: 'ignored', reason: 'schoolmaster' });
    const event = drive(r, 5000, 6700).find((e) => e.type === 'takeoff');
    expect(event).toMatchObject({ type: 'takeoff', outcome: { kind: 'clean' } });
    if (event?.type !== 'takeoff' || event.offsetMs === null) throw new Error('no auto tap');
    expect(Math.abs(event.offsetMs)).toBeGreaterThan(BASE_WINDOW.perfectMs);
    expect(Math.abs(event.offsetMs)).toBeLessThanOrEqual(BASE_WINDOW.cleanMs);
    expect(event.decidedAt).toBeCloseTo(6000 + event.offsetMs, 6);
  });

  it('schoolmaster collects the canter in the approach whatever the rider asked', () => {
    const r = runner({ rules: SCHOOLMASTER });
    r.setGear('gallop', 1000);
    drive(r, 0, 2000);
    expect(r.snapshot()).toMatchObject({ gear: 'gallop', requestedGear: 'gallop' });
    const approach = drive(r, 2000, 3000).find((e) => e.type === 'approach');
    expect(approach).toBeDefined();
    expect(r.snapshot().gear).toBe('collected');
    if (approach?.type === 'approach') expect(r.approachAt(approach.t0)?.gear).toBe('collected');
  });

  it('autopilot after a disconnection: collected, turns tight, auto take-off, the flag stays; within 10 s the fences are jumped', () => {
    const r = runner();
    drive(r, 0, 1950);
    r.disconnected(2000);
    expect(r.tick(2000)).toEqual([{ type: 'autopilot', at: 2000, on: true }]);
    expect(r.snapshot()).toMatchObject({ autopilot: true, usedAutopilot: true, gear: 'collected' });
    const events = drive(r, 2000, 12700);
    expect(events.filter((e) => e.type === 'takeoff').map((e) => (e.type === 'takeoff' ? e.outcome.kind : ''))).toEqual(['clean', 'clean']);
    expect(events.find((e) => e.type === 'turn')).toMatchObject({ decidedAt: 9000, outcome: { quality: 'tight' } });
    expect(r.tap(tap(12000, 12050, 2, 1))).toEqual({ kind: 'ignored', reason: 'autopilot' });
  });

  it('past the 10 s budget the horse waits before the next fence; a reconnection resumes and the result keeps the flag', () => {
    const r = runner();
    drive(r, 0, 1950);
    r.disconnected(2000);
    const events = drive(r, 1950, 17600);
    expect(events.find((e) => e.type === 'waiting')).toEqual({ type: 'waiting', at: 17600 });
    expect(r.snapshot()).toMatchObject({ phase: 'waiting', positionM: 88, nextFence: 3 });
    drive(r, 17600, 19950);
    expect(r.snapshot()).toMatchObject({ phase: 'waiting', positionM: 88 });
    r.reconnected(20000);
    expect(r.tick(20000)).toEqual([{ type: 'autopilot', at: 20000, on: false }, { type: 'approach', fence: 3, attempt: 1, t0: 22400 }]);
    expect(r.snapshot()).toMatchObject({ autopilot: false, usedAutopilot: true, phase: 'approach' });
    r.tap(tap(22400, 22450, 3, 1));
    const finish = drive(r, 20000, 26400).find((e) => e.type === 'finish');
    expect(finish).toEqual({ type: 'finish', at: 26400, elapsedMs: 26400 });
    expect(r.round).toMatchObject({ status: 'finished', faults: 3 }); // 26.4 s over 24 s allowed
  });

  it('never reconnected: eliminated "sin conexión" at the time limit', () => {
    const r = runner();
    r.disconnected(2000);
    const events = drive(r, 0, 48000);
    expect(events.find((e) => e.type === 'eliminated')).toEqual({ type: 'eliminated', at: 48000, reason: 'disconnected' });
    expect(r.round).toMatchObject({ status: 'eliminated', eliminationReason: 'disconnected' });
  });

  it('several short disconnections in a row: each gets its own budget, the rider keeps control in between', () => {
    const r = runner();
    drive(r, 0, 2000);
    r.disconnected(2000);
    drive(r, 2000, 2500);
    r.reconnected(2500);
    drive(r, 2500, 6000);
    r.tap(tap(6000, 6050));
    drive(r, 6000, 7000);
    r.disconnected(7000);
    drive(r, 7000, 7100);
    r.reconnected(7100);
    drive(r, 7100, 9000);
    r.turn({ choice: 'left', actionTime: 9000, receiveTime: 9050 });
    drive(r, 9000, 12000);
    expect(r.snapshot()).toMatchObject({ autopilot: false, usedAutopilot: true, phase: 'approach', t0: 12000 });
    r.tap(tap(12000, 12050, 2, 1));
    expect(drive(r, 12000, 12050).find((e) => e.type === 'takeoff')).toMatchObject({ outcome: { kind: 'perfect' } });
    drive(r, 12050, 13000);
    r.disconnected(13000); // a third segment with a fresh budget until 23 000: fence 3 (zone at 17 600) is auto-jumped
    const events = drive(r, 13000, 20700);
    expect(events.find((e) => e.type === 'waiting')).toBeUndefined();
    expect(events.find((e) => e.type === 'takeoff' && e.fence === 3)).toMatchObject({ outcome: { kind: 'clean' } });
  });

  describe('the autopilot taking over an open approach (the synthetic tap is never dated before the last tick)', () => {
    /** The planned automatic take-off moment at fence 1, attempt 1 for `seed`: the autopilot from the start takes off exactly there. */
    function plannedAutoTapAt(seed: string): number {
      const probe = runner({ seed });
      probe.disconnected(0);
      const { event } = driveUntil(probe, 0, (e) => e.type === 'takeoff');
      if (event?.type !== 'takeoff') throw new Error('auto take-off expected');
      return event.decidedAt;
    }

    /** A seed whose planned auto tap lies on the wanted side of t0 = 6000 (the sign of the offset comes from the seeded roll). */
    function seedWith(side: 'early' | 'late'): { seed: string; autoTapAt: number } {
      for (let i = 0; i < 64; i += 1) {
        const seed = `auto-${i}`;
        const autoTapAt = plannedAutoTapAt(seed);
        if (side === 'early' ? autoTapAt < 6000 : autoTapAt > 6000) return { seed, autoTapAt };
      }
      throw new Error(`no ${side} auto tap among the seeds`);
    }

    /** Ride without tapping up to the last tick strictly before `at`, disconnect at `at`, then run on to 7000. */
    function disconnectAt(seed: string, at: number): RunnerEvent[] {
      const r = runner({ seed });
      const lastTick = Math.floor((at - 1) / RUN.tickMs) * RUN.tickMs;
      const events = drive(r, 0, lastTick);
      r.disconnected(at);
      drive(r, lastTick, 7000, events);
      return events;
    }

    function theTakeoff(events: RunnerEvent[]): Extract<RunnerEvent, { type: 'takeoff' }> {
      const takeoffs = events.filter((e) => e.type === 'takeoff' && e.fence === 1);
      expect(takeoffs).toHaveLength(1);
      const [takeoff] = takeoffs;
      if (takeoff?.type !== 'takeoff') throw new Error('take-off expected');
      return takeoff;
    }

    it('before the planned moment: the auto tap fires at its planned time (clean, never perfect)', () => {
      const { seed, autoTapAt } = seedWith('early');
      const at = autoTapAt - 100;
      const takeoff = theTakeoff(disconnectAt(seed, at));
      expect(takeoff.decidedAt).toBeCloseTo(autoTapAt, 6);
      expect(takeoff.decidedAt).toBeGreaterThanOrEqual(at);
      expect(takeoff.offsetMs).toBeCloseTo(autoTapAt - 6000, 6);
      expect(takeoff.outcome).toMatchObject({ kind: 'clean', cleared: true });
    });

    it('after the planned moment but before t0: takes off at the disconnection moment (inside the window)', () => {
      const { seed, autoTapAt } = seedWith('early');
      const at = autoTapAt + 50; // still before t0: |offset| ≤ 175 ms, so autoTapAt + 50 < 6000
      expect(at).toBeLessThan(6000);
      const takeoff = theTakeoff(disconnectAt(seed, at));
      expect(takeoff.decidedAt).toBe(at);
      expect(takeoff.offsetMs).toBe(at - 6000);
      expect(['perfect', 'clean']).toContain(takeoff.outcome.kind);
      expect(takeoff.outcome.cleared).toBe(true);
    });

    it('after t0, before the deadline (6301): takes off now with offset +301 — a chip', () => {
      const { seed } = seedWith('late');
      const events = disconnectAt(seed, 6301);
      expect(events.find((e) => e.type === 'autopilot')).toEqual({ type: 'autopilot', at: 6301, on: true });
      const takeoff = theTakeoff(events);
      expect(takeoff).toMatchObject({ decidedAt: 6301, offsetMs: 301, outcome: { kind: 'chip', faults: 4, cleared: true } });
    });

    it('beyond ±400 ms (6450): takes off now under the "no tap" rules — a chip on a good approach', () => {
      const { seed } = seedWith('late');
      const takeoff = theTakeoff(disconnectAt(seed, 6450));
      expect(takeoff).toMatchObject({ decidedAt: 6450, offsetMs: 450, outcome: { kind: 'chip', cleared: true } });
    });

    it('exactly at the deadline (6700): the synthetic packet is still admissible and decides there', () => {
      const { seed } = seedWith('late');
      const takeoff = theTakeoff(disconnectAt(seed, 6700));
      expect(takeoff).toMatchObject({ decidedAt: 6700, offsetMs: 700, outcome: { kind: 'chip', cleared: true } });
    });

    it('after the deadline (6750): "no tap" already decided the fence; the disconnection adds nothing', () => {
      const { seed } = seedWith('late');
      const takeoff = theTakeoff(disconnectAt(seed, 6750));
      expect(takeoff).toMatchObject({ decidedAt: 6700, offsetMs: null, outcome: { kind: 'chip' } });
    });

    it('in the same millisecond as the last tick: the auto tap is dated 1 ms after it', () => {
      const { seed } = seedWith('late');
      const r = runner({ seed });
      const events = drive(r, 0, 6300);
      r.disconnected(6300);
      drive(r, 6300, 7000, events);
      expect(theTakeoff(events)).toMatchObject({ decidedAt: 6301, offsetMs: 301, outcome: { kind: 'chip' } });
    });

    it('between the decision and the landing (in flight): no second take-off', () => {
      const r = runner();
      const events = drive(r, 0, 6000);
      r.tap(tap(6000, 6050));
      drive(r, 6000, 6250, events);
      r.disconnected(6300);
      drive(r, 6250, 7000, events);
      expect(theTakeoff(events)).toMatchObject({ decidedAt: 6050, offsetMs: 0, outcome: { kind: 'perfect' } });
      expect(r.snapshot()).toMatchObject({ phase: 'running', nextFence: 2, autopilot: true });
    });

    it('reconnected, then disconnected again mid-approach after the planned moment: takes off at the second disconnection', () => {
      const { seed, autoTapAt } = seedWith('late');
      const r = runner({ seed });
      const events = drive(r, 0, 3650);
      r.disconnected(3700); // the planned moment is still ahead: nothing moves
      drive(r, 3650, 3750, events);
      r.reconnected(3800);
      drive(r, 3750, 6250, events); // the rider is back but never taps; the planned moment passes
      expect(autoTapAt).toBeLessThan(6250);
      r.disconnected(6301);
      drive(r, 6250, 7000, events);
      expect(events.filter((e) => e.type === 'autopilot')).toEqual([
        { type: 'autopilot', at: 3700, on: true },
        { type: 'autopilot', at: 3800, on: false },
        { type: 'autopilot', at: 6301, on: true },
      ]);
      expect(theTakeoff(events)).toMatchObject({ decidedAt: 6301, offsetMs: 301, outcome: { kind: 'chip', cleared: true } });
    });
  });

  it('withdrawal eliminates at once and freezes the clock', () => {
    const r = runner();
    drive(r, 0, 5000);
    r.withdraw(5000);
    expect(r.round).toMatchObject({ status: 'eliminated', eliminationReason: 'disconnected' });
    expect(r.snapshot().phase).toBe('done');
    expect(r.elapsedMs(9000)).toBe(5000);
    expect(r.tick(5050)).toEqual([]);
    expect(r.tap(tap(6000, 6050))).toEqual({ kind: 'ignored', reason: 'done' });
  });
});
