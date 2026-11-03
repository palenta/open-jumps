// Matrix row 5 on the class: heats of four over one course, transitions walk → riding → results, a rider leaving
// in the middle of a heat is eliminated while the heat goes on, and one class table at the end.
import { describe, expect, it } from 'vitest';
import { ClassFlow, CLASS_TIMING, buildClassTable, type ClassEvent, type ClassSetup } from '../src/round/classFlow.js';
import { RUN } from '../src/round/courseRunner.js';
import type { RoundResult } from '../src/round/roundEngine.js';
import { THREE_FENCE_COURSE as COURSE } from './fixtures/courses.js';

const NO_ASSISTS = { schoolmaster: false, widerWindow: false };
const CLASS_60 = ['ana', 'bea', 'cris', 'dani'];
const CLASS_70 = ['eva', 'fran'];

function setup(over: Partial<ClassSetup> = {}): ClassSetup {
  return {
    classId: 'class-7',
    course: COURSE,
    riders: [...CLASS_60.map((riderId) => ({ riderId, heightClass: 60 as const, assists: NO_ASSISTS })), ...CLASS_70.map((riderId) => ({ riderId, heightClass: 70 as const, assists: NO_ASSISTS }))],
    order: 'random',
    mode: 'ranked',
    seed: 'class-seed',
    timing: { walkMs: 1000, resultsMs: 500 },
    ...over,
  };
}

/**
 * Tick every 50 ms from `from` (exclusive) to `until` (inclusive). Riders in `clean` answer every 'approach' with a
 * tap at t0 and every 'turn-ahead' with the right press at the turn moment (packets received 50 ms later); the
 * others never press anything: a chip at fence 1, a missed turn, then three refusals → eliminated.
 */
function drive(flow: ClassFlow, from: number, until: number, clean: readonly string[] = [], events: ClassEvent[] = []): ClassEvent[] {
  for (let t = from + RUN.tickMs; t <= until; t += RUN.tickMs) {
    const step = flow.tick(t);
    for (const event of step) {
      if (event.type === 'approach' && clean.includes(event.riderId)) {
        flow.enqueue({ riderId: event.riderId, receiveTime: event.t0 + 50, kind: 'tap', actionTime: event.t0, fence: event.fence, attempt: event.attempt });
      }
      if (event.type === 'turn-ahead' && clean.includes(event.riderId)) {
        const direction = COURSE.turns.find((turn) => turn.distanceM === event.distanceM)?.direction ?? 'left';
        flow.enqueue({ riderId: event.riderId, receiveTime: event.at + 50, kind: 'turn', choice: direction, actionTime: event.at });
      }
    }
    events.push(...step);
  }
  return events;
}

const phasesOf = (events: ClassEvent[]) => events.filter((e) => e.type === 'phase').map((e) => (e.type === 'phase' ? [e.phase, e.heatIndex, e.at] : null));

const result = (riderId: string, over: Partial<RoundResult> = {}): RoundResult => ({
  roundId: 'class-7#0', riderId, heightClass: 60, faults: 0, timeMs: 60000, status: 'finished', eliminationReason: null,
  autopilot: false, schoolmaster: false, entries: [], rulesVersion: 1, courseId: 'c', courseVersion: 1, seed: 's', ...over,
});

describe('buildClassTable', () => {
  it('groups by height class, sorts by faults then time, shares places on ties and skips the next place; eliminated last', () => {
    const table = buildClassTable([
      result('ana', { faults: 4, timeMs: 60000 }),
      result('bea', { faults: 8, timeMs: 50000 }),
      result('cris', { faults: 0, timeMs: 55000 }),
      result('dani', { faults: 0, timeMs: 55000 }),
      result('eva', { faults: 4, timeMs: null, status: 'eliminated', eliminationReason: 'refusals' }),
      result('fran', { heightClass: 70, faults: 0, timeMs: 70000, autopilot: true }),
      result('gus', { faults: 0, timeMs: null, status: 'eliminated', eliminationReason: 'disconnected', autopilot: true }),
    ]);
    expect(Object.keys(table).map(Number).sort()).toEqual([60, 70]);
    expect(table[60]?.map((row) => [row.place, row.riderId])).toEqual([[1, 'cris'], [1, 'dani'], [3, 'ana'], [4, 'bea'], [null, 'gus'], [null, 'eva']]);
    expect(table[60]?.[4]).toEqual({ place: null, riderId: 'gus', faults: 0, timeMs: null, status: 'eliminated', eliminationReason: 'disconnected', autopilot: true });
    expect(table[70]).toEqual([{ place: 1, riderId: 'fran', faults: 0, timeMs: 70000, status: 'finished', eliminationReason: null, autopilot: true }]);
    expect(buildClassTable([])).toEqual({});
  });
});

describe('phases and heats', () => {
  it('default timing is 10 s walk and 15 s results', () => {
    expect(CLASS_TIMING).toEqual({ walkMs: 10_000, resultsMs: 15_000 });
  });

  it('walk → riding → results per heat, two heats for six riders, then done with one table and no lost or doubled rider', () => {
    const flow = new ClassFlow(setup());
    expect(flow.schedule.heats.map((h) => h.length)).toEqual([4, 2]);
    expect(flow.phase).toBe('walk');
    expect(flow.engine()).toBeNull();
    flow.start(0);
    const events: ClassEvent[] = [];
    drive(flow, 0, 1000, ['ana'], events);
    expect(phasesOf(events)).toEqual([['walk', 0, 0], ['riding', 0, 1000]]);
    expect(flow.engine()?.roundId).toBe('class-7#0');
    expect(flow.engine()?.snapshot().riders.map((r) => r.riderId).sort()).toEqual([...flow.schedule.heats[0]!].sort());

    // Ana rides clean (24 s on course); everyone else is eliminated after three refusals at fence 2 (~26 s).
    drive(flow, 1000, 90000, ['ana'], events);
    expect(flow.phase).toBe('done');
    expect(flow.engine()).toBeNull();
    const phases = phasesOf(events);
    expect(phases.map((p) => p?.[0])).toEqual(['walk', 'riding', 'results', 'walk', 'riding', 'results', 'done']);
    expect(phases.map((p) => p?.[1])).toEqual([0, 0, 0, 1, 1, 1, 1]);
    const at = (index: number) => Number(phases[index]?.[2]);
    expect(at(3) - at(2)).toBe(500); // results → walk after resultsMs
    expect(at(4) - at(3)).toBe(1000); // walk → riding after walkMs
    expect(at(6) - at(5)).toBe(500);
    expect(at(2) - at(1)).toBeGreaterThanOrEqual(24000); // the first heat lasts at least Ana's clean round
    expect(events.filter((e) => e.type === 'eliminated').map((e) => (e.type === 'eliminated' ? e.reason : ''))).toEqual(Array(5).fill('refusals'));

    const results = flow.results();
    expect(results.map((r) => r.riderId).sort()).toEqual([...CLASS_60, ...CLASS_70].sort()); // every rider exactly once
    expect(new Set(results.map((r) => r.roundId))).toEqual(new Set(['class-7#0', 'class-7#1']));
    expect(results.find((r) => r.riderId === 'ana')).toMatchObject({ status: 'finished', faults: 0, timeMs: 24000 });
    const table = flow.table();
    expect(Object.keys(table).map(Number).sort()).toEqual([60, 70]);
    expect(table[60]?.map((row) => row.riderId).sort()).toEqual([...CLASS_60].sort());
    expect(table[60]?.[0]).toMatchObject({ place: 1, riderId: 'ana', faults: 0, timeMs: 24000 });
    expect(table[60]?.slice(1).every((row) => row.place === null && row.status === 'eliminated' && row.eliminationReason === 'refusals')).toBe(true);
    expect(table[70]?.map((row) => row.riderId).sort()).toEqual([...CLASS_70].sort());
    expect(table[70]?.every((row) => row.place === null)).toBe(true);
  });

  it('every phase event says when the phase began and when its timer ends: walk → at + walkMs, results → at + resultsMs, riding and done have no timer (audit K1 r1 #6)', () => {
    const flow = new ClassFlow(setup());
    flow.start(0);
    const events: ClassEvent[] = [];
    drive(flow, 0, 90000, ['ana'], events);
    const phases = events.filter((e): e is Extract<ClassEvent, { type: 'phase' }> => e.type === 'phase');
    expect(phases.map((p) => [p.phase, p.endsAt === null ? null : p.endsAt - p.at])).toEqual([
      ['walk', 1000],
      ['riding', null],
      ['results', 500],
      ['walk', 1000],
      ['riding', null],
      ['results', 500],
      ['done', null],
    ]);
    // The timer of one phase is the start of the next: the second walk begins when the first results end.
    expect(phases[3]?.at).toBe(phases[2]?.endsAt);
    expect(phases[4]?.at).toBe(phases[3]?.endsAt);
  });

  it('phaseStartedAt and phaseEndsAt describe the phase in progress, for a late joiner (audit K1 r1 #6)', () => {
    const flow = new ClassFlow(setup());
    expect(flow.phaseStartedAt).toBeNull();
    expect(flow.phaseEndsAt()).toBeNull();
    flow.start(100);
    expect(flow.phaseStartedAt).toBe(100);
    expect(flow.phaseEndsAt()).toBe(1100);
    drive(flow, 100, 1100);
    expect(flow.phase).toBe('riding');
    expect(flow.phaseStartedAt).toBe(1100);
    expect(flow.phaseEndsAt()).toBeNull();
    drive(flow, 1100, 90000, ['ana']);
    expect(flow.phase).toBe('done');
    expect(flow.phaseEndsAt()).toBeNull();
  });

  it('a rider who leaves mid-heat is eliminated "disconnected", the heat continues, and they are out of later heats', () => {
    const flow = new ClassFlow(setup());
    flow.start(0);
    const events = drive(flow, 0, 5000, ['ana']);
    const [first] = flow.schedule.heats[0]!;
    const inLaterHeat = flow.schedule.heats[1]![0]!;
    flow.riderLeft(first!, 5000);
    flow.riderLeft(inLaterHeat, 5000);
    drive(flow, 5000, 5100, ['ana'], events);
    expect(events.find((e) => e.type === 'eliminated')).toMatchObject({ riderId: first, reason: 'disconnected', at: 5000, heatIndex: 0 });
    expect(flow.phase).toBe('riding');
    expect(flow.engine()?.snapshot().riders.filter((r) => r.status === 'riding')).toHaveLength(3);
    drive(flow, 5100, 90000, ['ana'], events);
    expect(flow.phase).toBe('done');
    expect(flow.results().map((r) => r.riderId)).not.toContain(inLaterHeat);
    expect(flow.results().find((r) => r.riderId === first)).toMatchObject({ status: 'eliminated', eliminationReason: 'disconnected' });
    expect(flow.results()).toHaveLength(5);
    expect(new Set(flow.results().map((r) => r.riderId)).size).toBe(5);
  });

  it('disconnections and reconnections are forwarded to the running heat only; commands outside riding are dropped', () => {
    const flow = new ClassFlow(setup());
    flow.start(0);
    expect(() => flow.enqueue({ riderId: 'ana', receiveTime: 10, kind: 'gear', gear: 'gallop' })).not.toThrow();
    expect(() => flow.riderDisconnected('ana', 10)).not.toThrow();
    const events = drive(flow, 0, 2000);
    const rider = flow.schedule.heats[0]![0]!;
    flow.riderDisconnected(rider, 2000);
    drive(flow, 2000, 2500, [], events);
    flow.riderReconnected(rider, 2500);
    drive(flow, 2500, 2600, [], events);
    expect(events.filter((e) => e.type === 'autopilot').map((e) => (e.type === 'autopilot' ? [e.riderId, e.on, e.heatIndex] : null))).toEqual([[rider, true, 0], [rider, false, 0]]);
  });
});
