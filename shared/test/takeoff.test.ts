// Plan 1.8 outcome table and matrix rows 3 and 6: the one pure judge used by server and client.
import { describe, expect, it } from 'vitest';
import { RiderRound } from '../src/rules/attempts.js';
import { gallopRailProbability } from '../src/rules/heightClasses.js';
import {
  BASE_WINDOW,
  NO_TAP_LIMIT_MS,
  judgeTakeoff,
  takeoffWindow,
  type ApproachState,
  type Gear,
} from '../src/rules/takeoff.js';

const good = (over: Partial<ApproachState> = {}): ApproachState => ({
  gear: 'collected',
  heightClass: 60,
  angleSharp: false,
  recentHardTurn: false,
  spooked: false,
  leadHorseBonus: false,
  ...over,
});

/** Rolls that never trigger a chance rail / always trigger it. */
const lucky = () => 0.99;
const unlucky = () => 0.0;

describe('take-off window', () => {
  it('a good collected approach at 60 cm uses the base window', () => {
    expect(takeoffWindow(good())).toEqual(BASE_WINDOW);
  });

  it('extended canter keeps the same window as collected', () => {
    expect(takeoffWindow(good({ gear: 'extended' }))).toEqual(takeoffWindow(good()));
  });

  it('a hard turn, a spook and a sharp angle each narrow the window', () => {
    const base = takeoffWindow(good()).cleanMs;
    expect(takeoffWindow(good({ recentHardTurn: true })).cleanMs).toBeLessThan(base);
    expect(takeoffWindow(good({ spooked: true })).cleanMs).toBeLessThan(base);
    expect(takeoffWindow(good({ angleSharp: true })).cleanMs).toBeLessThan(base);
  });

  it('gallop narrows the window to at most half', () => {
    expect(takeoffWindow(good({ gear: 'gallop' })).cleanMs).toBeLessThanOrEqual(BASE_WINDOW.cleanMs / 2);
  });

  it('following a lead horse widens the clean tier only; the perfect tier stays a skill', () => {
    const w = takeoffWindow(good({ leadHorseBonus: true }));
    expect(w.cleanMs).toBeGreaterThan(BASE_WINDOW.cleanMs);
    expect(w.perfectMs).toBe(BASE_WINDOW.perfectMs);
  });

  it('no modifier ever widens the perfect tier beyond the ideal approach of the same height', () => {
    const ideal = takeoffWindow(good()).perfectMs;
    const variants: Partial<ApproachState>[] = [
      { leadHorseBonus: true },
      { leadHorseBonus: true, gear: 'extended' },
      { leadHorseBonus: true, spooked: true },
      { recentHardTurn: true },
      { angleSharp: true },
      { gear: 'gallop' },
    ];
    for (const v of variants) expect(takeoffWindow(good(v)).perfectMs).toBeLessThanOrEqual(ideal);
  });

  it('80 cm is narrower than 60 cm (row 6)', () => {
    expect(takeoffWindow(good({ heightClass: 80 })).cleanMs).toBeLessThan(takeoffWindow(good()).cleanMs);
  });

  it('the perfect tier is always inside the clean tier', () => {
    for (const approach of [good(), good({ gear: 'gallop' }), good({ heightClass: 100, spooked: true })]) {
      const w = takeoffWindow(approach);
      expect(w.perfectMs).toBeGreaterThan(0);
      expect(w.perfectMs).toBeLessThan(w.cleanMs);
    }
  });
});

describe('judgeTakeoff is deterministic', () => {
  it('the same inputs give the same outcome', () => {
    const a = judgeTakeoff(good(), 30, lucky);
    const b = judgeTakeoff(good(), 30, lucky);
    expect(a).toEqual(b);
  });
});

describe.each<Gear>(['collected', 'extended'])('outcome table on %s canter', (gear) => {
  const approach = good({ gear });

  it('perfect tier → perfect, no faults, fence cleared', () => {
    const w = takeoffWindow(approach);
    const o = judgeTakeoff(approach, w.perfectMs - 1, lucky);
    expect(o).toMatchObject({ kind: 'perfect', faults: 0, cleared: true, horseJumped: true });
  });

  it('clean tier → clean, no faults, on either side of t0', () => {
    const w = takeoffWindow(approach);
    expect(judgeTakeoff(approach, w.cleanMs - 1, lucky)).toMatchObject({ kind: 'clean', faults: 0, cleared: true });
    expect(judgeTakeoff(approach, -(w.cleanMs - 1), lucky)).toMatchObject({ kind: 'clean', faults: 0 });
  });

  it('too early (outside the window) → long: back rail, 4 faults, fence still cleared', () => {
    const w = takeoffWindow(approach);
    const o = judgeTakeoff(approach, -(w.cleanMs + 1), lucky);
    expect(o).toMatchObject({ kind: 'long', faults: 4, cleared: true, horseJumped: true, label: 'batida_larga' });
  });

  it('too late (outside the window) → chip: front rail, 4 faults', () => {
    const w = takeoffWindow(approach);
    const o = judgeTakeoff(approach, w.cleanMs + 1, lucky);
    expect(o).toMatchObject({ kind: 'chip', faults: 4, cleared: true, label: 'batida_corta' });
  });

  it('exactly +400 ms is still a tap: chip', () => {
    expect(judgeTakeoff(approach, NO_TAP_LIMIT_MS, lucky).kind).toBe('chip');
  });

  it('beyond ±400 ms is judged like no tap at all', () => {
    expect(judgeTakeoff(approach, NO_TAP_LIMIT_MS + 1, lucky)).toEqual(judgeTakeoff(approach, null, lucky));
    expect(judgeTakeoff(approach, -(NO_TAP_LIMIT_MS + 1), lucky)).toEqual(judgeTakeoff(approach, null, lucky));
  });

  it('a sharp angle plus a miss (early or late) → run-out instead of a rail, fence not cleared', () => {
    const sharp = good({ gear, angleSharp: true });
    const w = takeoffWindow(sharp);
    for (const offset of [w.cleanMs + 1, -(w.cleanMs + 1)]) {
      const o = judgeTakeoff(sharp, offset, lucky);
      expect(o).toMatchObject({ kind: 'runout', faults: 0, cleared: false, horseJumped: false, label: 'desvio' });
    }
  });

  it('no tap on a good approach → the horse jumps by itself but chips: 4 faults, cleared', () => {
    expect(judgeTakeoff(approach, null, lucky)).toMatchObject({ kind: 'chip', faults: 4, cleared: true });
  });
});

describe('outcome table: no tap on a bad approach', () => {
  it('after a hard turn or a spook → refusal, fence not cleared', () => {
    for (const approach of [good({ recentHardTurn: true }), good({ spooked: true })]) {
      const o = judgeTakeoff(approach, null, lucky);
      expect(o).toMatchObject({ kind: 'refusal', cleared: false, horseJumped: false, label: 'rehuse' });
    }
  });

  it('refusal outcomes carry no disobedience faults themselves (the round numbers them 4/8/elimination)', () => {
    expect(judgeTakeoff(good({ spooked: true }), null, lucky).faults).toBe(0);
  });
});

describe('outcome table: gallop (the only source of falls)', () => {
  const gallop = good({ gear: 'gallop' });

  it('perfect tier on gallop → clean, never perfect (flat arc)', () => {
    const w = takeoffWindow(gallop);
    expect(judgeTakeoff(gallop, 0, lucky)).toMatchObject({ kind: 'clean', faults: 0 });
    expect(judgeTakeoff(gallop, w.perfectMs - 1, lucky).kind).not.toBe('perfect');
  });

  it('clean tier on gallop drops the back rail when the roll is below the height probability', () => {
    const w = takeoffWindow(gallop);
    const offset = w.cleanMs - 1;
    expect(judgeTakeoff(gallop, offset, unlucky)).toMatchObject({ kind: 'long', faults: 4, cleared: true });
    expect(judgeTakeoff(gallop, offset, lucky)).toMatchObject({ kind: 'clean', faults: 0 });
  });

  it('uses the height table: one roll between the 60 cm and 80 cm probabilities is clean at 60 and a rail at 80', () => {
    const p60 = gallopRailProbability(60);
    const p80 = gallopRailProbability(80);
    expect(p80).toBeGreaterThan(p60);
    const between = () => (p60 + p80) / 2;
    const at60 = good({ gear: 'gallop', heightClass: 60 });
    const at80 = good({ gear: 'gallop', heightClass: 80 });
    expect(judgeTakeoff(at60, takeoffWindow(at60).cleanMs - 1, between)).toMatchObject({ kind: 'clean' });
    expect(judgeTakeoff(at80, takeoffWindow(at80).cleanMs - 1, between)).toMatchObject({ kind: 'long', faults: 4 });
  });

  it('the rail falls only when roll < probability: a roll exactly at the probability is clean', () => {
    const p60 = gallopRailProbability(60);
    const offset = takeoffWindow(gallop).cleanMs - 1;
    expect(judgeTakeoff(gallop, offset, () => p60).kind).toBe('clean');
    expect(judgeTakeoff(gallop, offset, () => p60 - 1e-9).kind).toBe('long');
  });

  it('a miss on gallop → fall: 8 faults, the horse jumped, the rider must remount and re-jump', () => {
    const w = takeoffWindow(gallop);
    for (const offset of [w.cleanMs + 1, -(w.cleanMs + 1)]) {
      const o = judgeTakeoff(gallop, offset, lucky);
      expect(o).toMatchObject({ kind: 'fall', faults: 8, cleared: false, horseJumped: true, label: 'caida' });
    }
  });

  it('a sharp angle plus a miss on gallop is still a run-out, never a fall (last row of the table)', () => {
    const sharp = good({ gear: 'gallop', angleSharp: true });
    const w = takeoffWindow(sharp);
    for (const offset of [w.cleanMs + 1, -(w.cleanMs + 1)]) {
      const o = judgeTakeoff(sharp, offset, lucky);
      expect(o).toMatchObject({ kind: 'runout', faults: 0, cleared: false, horseJumped: false, label: 'desvio' });
    }
  });

  it('a run-out from the judge is numbered by the round as a disobedience: 4 faults', () => {
    const sharp = good({ gear: 'gallop', angleSharp: true });
    const round = new RiderRound(8);
    round.recordOutcome(judgeTakeoff(sharp, takeoffWindow(sharp).cleanMs + 1, lucky));
    expect(round.faults).toBe(4);
    expect(round.currentFence).toBe(1);
    expect(round.currentAttempt).toBe(2);
  });

  it('no tap on gallop → refusal with a fall: 8 fall faults plus the disobedience, not cleared', () => {
    const o = judgeTakeoff(gallop, null, lucky);
    expect(o).toMatchObject({ kind: 'refusal', faults: 8, cleared: false, horseJumped: false });
  });

  it('pranks, moods and collisions never appear here: only gallop outcomes can be falls', () => {
    const w = takeoffWindow(good());
    for (const offset of [null, w.cleanMs + 1, -(w.cleanMs + 1), 0]) {
      expect(judgeTakeoff(good({ spooked: true, recentHardTurn: true }), offset, unlucky).kind).not.toBe('fall');
    }
  });
});
