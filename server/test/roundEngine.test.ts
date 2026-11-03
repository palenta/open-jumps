// Matrix row 3 (the server queue before the tick), row 8 (results with the autopilot flag, written once by the
// room) and plan 2.3 (seeded chance, the lead horse between riders) on the whole round.
import { RULES_VERSION } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { RUN } from '../src/round/courseRunner.js';
import { RoundEngine, type RiderCommand, type RoundEvent, type RoundSetup } from '../src/round/roundEngine.js';
import { THREE_FENCE_COURSE as COURSE } from './fixtures/courses.js';

const NO_ASSISTS = { schoolmaster: false, widerWindow: false };

function setup(over: Partial<RoundSetup> = {}): RoundSetup {
  return {
    roundId: 'class-1#0',
    course: COURSE,
    riders: [
      { riderId: 'ana', heightClass: 60, assists: NO_ASSISTS },
      { riderId: 'bea', heightClass: 60, assists: NO_ASSISTS },
    ],
    mode: 'ranked',
    seed: 'round-seed',
    startAt: 0,
    ...over,
  };
}

function drive(engine: RoundEngine, from: number, until: number, events: RoundEvent[] = []): RoundEvent[] {
  for (let t = from + RUN.tickMs; t <= until; t += RUN.tickMs) events.push(...engine.tick(t));
  return events;
}

/** Tick from `from` until an event matches; returns the event and the tick it came with (events are kept in `log`). */
function driveUntil(engine: RoundEngine, from: number, match: (e: RoundEvent) => boolean, log: RoundEvent[] = [], limit = 120_000): { event: RoundEvent; at: number } {
  for (let t = from + RUN.tickMs; t <= limit; t += RUN.tickMs) {
    const step = engine.tick(t);
    log.push(...step);
    const event = step.find(match);
    if (event) return { event, at: t };
  }
  throw new Error('event not reached');
}

const nextTick = (time: number) => (Math.floor(time / RUN.tickMs) + 1) * RUN.tickMs;

const tapOf = (riderId: string, actionTime: number, receiveTime: number, fence = 1, attempt = 1): RiderCommand => ({ riderId, receiveTime, kind: 'tap', actionTime, fence, attempt });

/** Ride ana clean through the whole course (tap, turn, tap, tap in time order) from `from` on; returns the log. */
function rideAnaClean(engine: RoundEngine, from: number, log: RoundEvent[] = []): RoundEvent[] {
  drive(engine, from, 6000, log);
  engine.enqueue(tapOf('ana', 6000, 6050));
  drive(engine, 6000, 9000, log);
  engine.enqueue({ riderId: 'ana', receiveTime: 9050, kind: 'turn', choice: 'left', actionTime: 9000 });
  drive(engine, 9000, 12000, log);
  engine.enqueue(tapOf('ana', 12000, 12050, 2));
  drive(engine, 12000, 20000, log);
  engine.enqueue(tapOf('ana', 20000, 20050, 3));
  drive(engine, 20000, 24000, log);
  return log;
}

describe('the command queue and the tick', () => {
  it('commands with the same receive time are handed over in enqueue order and all decide at that time', () => {
    const engine = new RoundEngine(setup());
    drive(engine, 0, 6000);
    engine.enqueue(tapOf('bea', 6000, 6050));
    engine.enqueue(tapOf('ana', 5990, 6050));
    const events = engine.tick(6050);
    expect(events.map((e) => [e.riderId, e.type, e.type === 'takeoff' ? e.offsetMs : null])).toEqual([
      ['bea', 'takeoff', 0],
      ['ana', 'takeoff', -10],
    ]);
  });

  it('a packet for a later moment is submitted right before the sub-step of that moment, even inside one tick call', () => {
    const engine = new RoundEngine(setup({ riders: [{ riderId: 'ana', heightClass: 60, assists: NO_ASSISTS }] }));
    drive(engine, 0, 6600);
    engine.enqueue(tapOf('ana', 6400, 6700)); // exactly at the deadline: must reach the judge before tick(6700)
    const events = engine.tick(6750); // one call spanning 6650, 6700 and 6750
    expect(events.find((e) => e.type === 'takeoff')).toMatchObject({ riderId: 'ana', offsetMs: 400, decidedAt: 6700, outcome: { kind: 'chip' } });
  });

  it('gear, line and turn commands reach the right horse; commands for unknown or finished riders are dropped', () => {
    const engine = new RoundEngine(setup());
    engine.enqueue({ riderId: 'ana', receiveTime: 1000, kind: 'gear', gear: 'extended' });
    engine.enqueue({ riderId: 'nadie', receiveTime: 1000, kind: 'gear', gear: 'gallop' });
    drive(engine, 0, 2000);
    const snap = engine.snapshot();
    expect(snap.riders.find((r) => r.riderId === 'ana')?.positionM).toBeCloseTo(11, 6);
    expect(snap.riders.find((r) => r.riderId === 'bea')?.positionM).toBe(10);
    engine.riderLeft('bea', 2000);
    expect(() => engine.enqueue(tapOf('bea', 6000, 6050))).not.toThrow();
    expect(() => drive(engine, 2000, 6100)).not.toThrow();
  });

  it('ticks must not go backwards', () => {
    const engine = new RoundEngine(setup());
    engine.tick(100);
    expect(() => engine.tick(50)).toThrow(/backwards|order/);
  });

  // The room stamps receiveTime with a millisecond clock, so a message handled right after tick(T) carries
  // receiveTime = T. The command keeps that TRUE time: the age, future and deadline rules of plan 2.3 are judged
  // against it (never a shifted one), and the decision is applied at the next tick, dated with the stamp.
  describe('a command stamped with the last tick\'s own millisecond, enqueued after that tick', () => {
    const anaOnly = () => new RoundEngine(setup({ riders: [{ riderId: 'ana', heightClass: 60, assists: NO_ASSISTS }] }));
    const takeoffs = (events: RoundEvent[]) => events.filter((e) => e.type === 'takeoff');

    it('true age exactly 300 ms (action 6000, received 6300 after tick(6300)): accepted, perfect, decided at 6300', () => {
      const engine = anaOnly();
      drive(engine, 0, 6300); // the attempt at fence 1 is open (t0 = 6000) and the engine has ticked at 6300
      engine.enqueue(tapOf('ana', 6000, 6300));
      let events: RoundEvent[] = [];
      expect(() => { events = engine.tick(6350); }).not.toThrow();
      expect(takeoffs(events)).toMatchObject([{ riderId: 'ana', fence: 1, decidedAt: 6300, offsetMs: 0, outcome: { kind: 'perfect' } }]);
    });

    it('true age 301 ms (action 5999, received 6300 after tick(6300)): too old — "no tap" is fixed at 6700', () => {
      const engine = anaOnly();
      drive(engine, 0, 6300);
      engine.enqueue(tapOf('ana', 5999, 6300));
      const events = drive(engine, 6300, 6700);
      expect(takeoffs(events)).toMatchObject([{ riderId: 'ana', decidedAt: 6700, offsetMs: null, outcome: { kind: 'chip' } }]);
    });

    it('from the future by exactly 100 ms (action 6400, received 6300 after tick(6300)): accepted as +400; by 101 ms: rejected', () => {
      const accepted = anaOnly();
      drive(accepted, 0, 6300);
      accepted.enqueue(tapOf('ana', 6400, 6300));
      expect(takeoffs(accepted.tick(6350))).toMatchObject([{ riderId: 'ana', decidedAt: 6300, offsetMs: 400, outcome: { kind: 'chip' } }]);

      const rejected = anaOnly();
      drive(rejected, 0, 6300);
      rejected.enqueue(tapOf('ana', 6401, 6300));
      expect(takeoffs(drive(rejected, 6300, 6700))).toMatchObject([{ riderId: 'ana', decidedAt: 6700, offsetMs: null }]);
    });

    it('the deadline millisecond is simulated only once complete: a packet stamped 6700 counts the same whether its callback ran before or after the tick that closed 6699 — even with a line change after t0; 6701 is late both ways', () => {
      // The live room ticks clock() − 1: the tick that may fix "no tap" at 6700 runs only once 6700 is over, so
      // every packet stamped 6700 has been enqueued by then, whatever order the event loop handled them in.
      const run = (enqueueFirst: boolean, receiveTime: number) => {
        const engine = anaOnly();
        engine.enqueue({ riderId: 'ana', receiveTime: 5900, kind: 'line', line: 'angle' });
        engine.enqueue({ riderId: 'ana', receiveTime: 6350, kind: 'line', line: 'center' });
        if (enqueueFirst) engine.enqueue(tapOf('ana', 6400, receiveTime));
        drive(engine, 0, 6699);
        if (!enqueueFirst) engine.enqueue(tapOf('ana', 6400, receiveTime));
        return { events: drive(engine, 6699, 7000), rider: engine.snapshot().riders[0]! };
      };
      for (const first of [true, false]) {
        const inTime = run(first, 6700);
        expect(takeoffs(inTime.events)).toMatchObject([{ riderId: 'ana', decidedAt: 6700, offsetMs: 400, outcome: { kind: 'chip', cleared: true }, approach: { angleSharp: false } }]);
        expect(inTime.rider).toMatchObject({ faults: 4, nextFence: 2 });
        const late = run(first, 6701); // after the deadline: "no tap", judged on the state at t0 — the angled line refuses
        expect(takeoffs(late.events)).toMatchObject([{ riderId: 'ana', decidedAt: 6700, offsetMs: null, outcome: { kind: 'refusal', cleared: false }, approach: { angleSharp: true } }]);
        expect(late.rider).toMatchObject({ nextFence: 1, attempt: 2 });
      }
    });

    it('a turn press stamped at the last tick (9000), enqueued after it: applied at the next tick, decidedAt = that stamp', () => {
      const engine = anaOnly();
      drive(engine, 0, 6000);
      engine.enqueue(tapOf('ana', 6000, 6050));
      drive(engine, 6000, 9000);
      engine.enqueue({ riderId: 'ana', receiveTime: 9000, kind: 'turn', choice: 'left', actionTime: 9000 }); // the press at the turn moment
      let events: RoundEvent[] = [];
      expect(() => { events = engine.tick(9050); }).not.toThrow();
      expect(events.filter((e) => e.type === 'turn')).toMatchObject([{ riderId: 'ana', decidedAt: 9000, outcome: { quality: 'tight' } }]);
      expect(drive(engine, 9050, 12000).find((e) => e.type === 'approach')).toMatchObject({ riderId: 'ana', fence: 2, t0: 12000 });
      expect(engine.snapshot().riders[0]).toMatchObject({ nextFence: 2, faults: 0 });
    });

    it('a duplicate tap stamped at the last tick: no exception and no second take-off', () => {
      const engine = anaOnly();
      drive(engine, 0, 6000);
      engine.enqueue(tapOf('ana', 6000, 6000)); // the room handled the message right after tick(6000), same clock value
      let events: RoundEvent[] = [];
      expect(() => { events = engine.tick(6050); }).not.toThrow();
      expect(takeoffs(events)).toMatchObject([{ riderId: 'ana', fence: 1, decidedAt: 6000, offsetMs: 0, outcome: { kind: 'perfect' } }]);

      engine.enqueue(tapOf('ana', 6010, 6050)); // a duplicate after the decision, again stamped with the last tick's time
      expect(() => { events = drive(engine, 6050, 6700); }).not.toThrow();
      expect(takeoffs(events)).toEqual([]);
      expect(engine.snapshot().riders[0]).toMatchObject({ nextFence: 2, faults: 0 });
    });
  });
});

describe('chance, the lead horse and the snapshot', () => {
  /** One gallop attempt at fence 1 with a clean-tier tap (+60 ms; the gallop window is halved): the roll decides clean or long. */
  function gallopOutcome(seed: string): { kind: string; events: RoundEvent[] } {
    const engine = new RoundEngine(setup({ seed, riders: [{ riderId: 'ana', heightClass: 60, assists: NO_ASSISTS }] }));
    engine.enqueue({ riderId: 'ana', receiveTime: 100, kind: 'gear', gear: 'gallop' });
    const log: RoundEvent[] = [];
    const { event, at } = driveUntil(engine, 0, (e) => e.type === 'approach', log);
    if (event.type !== 'approach') throw new Error('approach expected');
    const action = event.t0 + 60;
    const receive = nextTick(action);
    drive(engine, at, receive - RUN.tickMs, log);
    engine.enqueue(tapOf('ana', action, receive));
    log.push(...engine.tick(receive));
    const takeoff = log.find((e) => e.type === 'takeoff');
    if (takeoff?.type !== 'takeoff') throw new Error('takeoff expected');
    return { kind: takeoff.outcome.kind, events: log };
  }

  it('the same seed reproduces the same events; different seeds spread over both chance outcomes, each repeatable', () => {
    expect(gallopOutcome('a').events).toEqual(gallopOutcome('a').events);
    const kinds = new Map<string, string>();
    for (let i = 0; i < 40 && (!kinds.has('clean') || !kinds.has('long')); i += 1) {
      const seed = `seed-${i}`;
      const { kind } = gallopOutcome(seed);
      expect(['clean', 'long']).toContain(kind);
      if (!kinds.has(kind)) kinds.set(kind, seed);
    }
    expect([...kinds.keys()].sort()).toEqual(['clean', 'long']); // a constant outcome would never give both
    for (const [kind, seed] of kinds) expect(gallopOutcome(seed).kind).toBe(kind);
  });

  it('a rider who cleared the fence within 2 s before another rider\'s t0 gives that rider the lead-horse bonus', () => {
    const engine = new RoundEngine(setup());
    engine.enqueue({ riderId: 'ana', receiveTime: 100, kind: 'gear', gear: 'gallop' }); // ana reaches fence 1 at ~4.3 s
    const log: RoundEvent[] = [];
    const { event, at } = driveUntil(engine, 0, (e) => e.riderId === 'ana' && e.type === 'approach', log);
    if (event.type !== 'approach') throw new Error('approach expected');
    const receive = nextTick(event.t0 + 40);
    drive(engine, at, receive - RUN.tickMs, log);
    engine.enqueue(tapOf('ana', event.t0, receive));
    log.push(...engine.tick(receive));
    expect(log.find((e) => e.riderId === 'ana' && e.type === 'takeoff')).toMatchObject({ outcome: { kind: 'clean', cleared: true } });
    drive(engine, receive, 6200, log);
    engine.enqueue(tapOf('bea', 6200, 6250)); // +200 ms: a chip without the bonus, clean with it
    const bea = engine.tick(6250).find((e) => e.riderId === 'bea' && e.type === 'takeoff');
    expect(bea).toMatchObject({ outcome: { kind: 'clean' }, approach: { leadHorseBonus: true } });
  });

  it('a clear with a rail (ana\'s chip at +200) is no lead horse: bea\'s +200 stays a chip', () => {
    const engine = new RoundEngine(setup());
    engine.enqueue({ riderId: 'ana', receiveTime: 100, kind: 'gear', gear: 'extended' }); // ana reaches fence 1 at ~5 s, full window
    const log: RoundEvent[] = [];
    const { event, at } = driveUntil(engine, 0, (e) => e.riderId === 'ana' && e.type === 'approach', log);
    if (event.type !== 'approach') throw new Error('approach expected');
    const action = event.t0 + 200;
    const receive = nextTick(action);
    drive(engine, at, receive - RUN.tickMs, log);
    engine.enqueue(tapOf('ana', action, receive));
    log.push(...engine.tick(receive));
    expect(log.find((e) => e.riderId === 'ana' && e.type === 'takeoff')).toMatchObject({ decidedAt: receive, outcome: { kind: 'chip', faults: 4, cleared: true }, approach: { angleSharp: false } });
    expect(receive).toBeGreaterThanOrEqual(6000 - RUN.leadHorseMs); // inside bea's lead-horse window: only the quality of the jump decides
    drive(engine, receive, 6200, log);
    engine.enqueue(tapOf('bea', 6200, 6250));
    const bea = engine.tick(6250).find((e) => e.riderId === 'bea' && e.type === 'takeoff');
    expect(bea).toMatchObject({ outcome: { kind: 'chip' }, approach: { leadHorseBonus: false } });
  });

  it('a clean jump off a sharp line is no lead horse either: bea\'s +200 stays a chip', () => {
    const engine = new RoundEngine(setup());
    engine.enqueue({ riderId: 'ana', receiveTime: 100, kind: 'gear', gear: 'gallop' }); // ana reaches fence 1 at ~4.3 s
    engine.enqueue({ riderId: 'ana', receiveTime: 100, kind: 'line', line: 'angle' });
    const log: RoundEvent[] = [];
    const { event, at } = driveUntil(engine, 0, (e) => e.riderId === 'ana' && e.type === 'approach', log);
    if (event.type !== 'approach') throw new Error('approach expected');
    const receive = nextTick(event.t0);
    drive(engine, at, receive - RUN.tickMs, log);
    engine.enqueue(tapOf('ana', event.t0, receive)); // offset 0: the perfect tier clears even on the sharp line (a miss would be a run-out)
    log.push(...engine.tick(receive));
    expect(log.find((e) => e.riderId === 'ana' && e.type === 'takeoff')).toMatchObject({ offsetMs: 0, outcome: { kind: 'clean', faults: 0, cleared: true }, approach: { angleSharp: true } });
    drive(engine, receive, 6200, log);
    engine.enqueue(tapOf('bea', 6200, 6250));
    const bea = engine.tick(6250).find((e) => e.riderId === 'bea' && e.type === 'takeoff');
    expect(bea).toMatchObject({ outcome: { kind: 'chip' }, approach: { leadHorseBonus: false } });
  });

  it('the snapshot carries faults, status, elapsed time and the last caption per rider', () => {
    const engine = new RoundEngine(setup());
    drive(engine, 0, 6700);
    const snap = engine.snapshot();
    expect(snap).toMatchObject({ roundId: 'class-1#0', elapsedMs: 6700, complete: false });
    for (const rider of snap.riders) {
      expect(rider).toMatchObject({ heightClass: 60, faults: 4, status: 'riding', eliminationReason: null, elapsedMs: 6700, lastLabel: 'batida_corta', nextFence: 2 });
    }
  });
});

describe('results (row 8: flags, once per rider) and completion', () => {
  it('results are available only when every rider is done; a withdrawn rider has no time and the reason', () => {
    const engine = new RoundEngine(setup());
    drive(engine, 0, 5000);
    expect(engine.isComplete()).toBe(false);
    expect(() => engine.results()).toThrow(/complete/);
    engine.riderLeft('bea', 5000);
    rideAnaClean(engine, 5000);
    expect(engine.isComplete()).toBe(true);
    const results = engine.results();
    expect(results.map((r) => r.riderId).sort()).toEqual(['ana', 'bea']);
    expect(results.find((r) => r.riderId === 'ana')).toEqual({
      roundId: 'class-1#0', riderId: 'ana', heightClass: 60, faults: 0, timeMs: 24000, status: 'finished', eliminationReason: null,
      autopilot: false, schoolmaster: false, entries: [], rulesVersion: RULES_VERSION, courseId: 'runner-test', courseVersion: 1, seed: 'round-seed',
    });
    expect(results.find((r) => r.riderId === 'bea')).toMatchObject({ faults: 0, timeMs: null, status: 'eliminated', eliminationReason: 'disconnected', autopilot: false });
  });

  it('a disconnection marks the result "con autopiloto" even after a reconnection; schoolmaster is recorded too', () => {
    const engine = new RoundEngine(setup({ riders: [
      { riderId: 'ana', heightClass: 60, assists: { schoolmaster: true, widerWindow: false } },
      { riderId: 'bea', heightClass: 70, assists: { schoolmaster: true, widerWindow: false } },
    ] }));
    drive(engine, 0, 3000);
    engine.riderDisconnected('bea', 3000);
    drive(engine, 3000, 3500);
    engine.riderReconnected('bea', 3500);
    drive(engine, 3500, 40000); // schoolmaster jumps for both; the turn is missed by both (no press) and costs 4 s
    expect(engine.isComplete()).toBe(true);
    const results = engine.results();
    expect(results.find((r) => r.riderId === 'ana')).toMatchObject({ status: 'finished', autopilot: false, schoolmaster: true, heightClass: 60 });
    expect(results.find((r) => r.riderId === 'bea')).toMatchObject({ status: 'finished', autopilot: true, schoolmaster: true, heightClass: 70 });
    expect(engine.events.filter((e) => e.type === 'autopilot')).toEqual([
      { type: 'autopilot', at: 3000, on: true, riderId: 'bea' },
      { type: 'autopilot', at: 3500, on: false, riderId: 'bea' },
    ]);
  });

  it('the round ends without a client: a never-returning rider is eliminated at the limit and the round completes', () => {
    const engine = new RoundEngine(setup({ riders: [{ riderId: 'bea', heightClass: 60, assists: NO_ASSISTS }] }));
    engine.riderDisconnected('bea', 0);
    const events = drive(engine, 0, 48000);
    expect(events.find((e) => e.type === 'waiting')).toMatchObject({ riderId: 'bea', at: 17600 });
    expect(engine.isComplete()).toBe(true);
    expect(engine.results()[0]).toMatchObject({ status: 'eliminated', eliminationReason: 'disconnected', autopilot: true, timeMs: null });
  });
});
