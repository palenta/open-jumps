// Matrix row 9 (plan 1.8): the wider window only in training; schoolmaster is clean but slow and still
// carries the approach risk; settings freeze per round.
import { describe, expect, it } from 'vitest';
import {
  WIDER_WINDOW_FACTOR,
  effectiveWindow,
  freezeForRound,
  gearInForce,
  schoolmasterGear,
  schoolmasterReferenceWindow,
  schoolmasterTapOffset,
  type AssistSettings,
} from '../src/rules/assists.js';
import { BASE_WINDOW, judgeTakeoff, takeoffWindow, type ApproachState } from '../src/rules/takeoff.js';

const wider: AssistSettings = { schoolmaster: false, widerWindow: true };
const none: AssistSettings = { schoolmaster: false, widerWindow: false };

const good = (over: Partial<ApproachState> = {}): ApproachState => ({
  gear: 'collected',
  heightClass: 60,
  angleSharp: false,
  recentHardTurn: false,
  spooked: false,
  leadHorseBonus: false,
  ...over,
});
const lucky = () => 0.99;

describe('effectiveWindow', () => {
  it('a ranked round ignores the wider-window setting: everyone has the same window', () => {
    expect(effectiveWindow(BASE_WINDOW, wider, 'ranked')).toEqual(BASE_WINDOW);
  });

  it('training applies the wider window to both tiers', () => {
    expect(effectiveWindow(BASE_WINDOW, wider, 'training')).toEqual({
      cleanMs: BASE_WINDOW.cleanMs * WIDER_WINDOW_FACTOR,
      perfectMs: BASE_WINDOW.perfectMs * WIDER_WINDOW_FACTOR,
    });
  });

  it('training without the setting leaves the window unchanged', () => {
    expect(effectiveWindow(BASE_WINDOW, none, 'training')).toEqual(BASE_WINDOW);
  });
});

describe('schoolmaster gear', () => {
  it('collects the canter before a fence whatever the rider asked for', () => {
    expect(schoolmasterGear('gallop', true)).toBe('collected');
    expect(schoolmasterGear('extended', true)).toBe('collected');
  });

  it('leaves the gear alone between fences', () => {
    expect(schoolmasterGear('gallop', false)).toBe('gallop');
  });
});

describe('gearInForce: the one rule of the gear in force, for the server and the client (K1.1 code audit r2)', () => {
  const free = { schoolmaster: false, autopilot: false, wideTurn: false };

  it('nothing forcing: the gear the rider asked for, whichever it is', () => {
    for (const gear of ['collected', 'extended', 'gallop'] as const) expect(gearInForce(gear, free)).toBe(gear);
  });

  it('the schoolmaster, the own autopilot or a wide turn each collect the canter whatever was asked for', () => {
    for (const forcing of [{ ...free, schoolmaster: true }, { ...free, autopilot: true }, { ...free, wideTurn: true }]) {
      expect(gearInForce('gallop', forcing)).toBe('collected');
      expect(gearInForce('extended', forcing)).toBe('collected');
    }
  });

  it('negative: the requested gear is not lost under the forcing — once it ends, the same request is in force again', () => {
    expect(gearInForce('gallop', { ...free, autopilot: true })).toBe('collected');
    expect(gearInForce('gallop', free)).toBe('gallop');
  });
});

describe('schoolmaster reference window', () => {
  it('is the window of an ideal collected approach at the same height, ignoring the actual approach modifiers', () => {
    expect(schoolmasterReferenceWindow(good({ spooked: true, angleSharp: true, gear: 'gallop' }))).toEqual(takeoffWindow(good()));
    expect(schoolmasterReferenceWindow(good({ heightClass: 80, recentHardTurn: true }))).toEqual(takeoffWindow(good({ heightClass: 80 })));
  });

  it('is wider than the actual window on a spooked approach (that gap is the schoolmaster\'s risk)', () => {
    const spooked = good({ spooked: true });
    expect(schoolmasterReferenceWindow(spooked).cleanMs).toBeGreaterThan(takeoffWindow(spooked).cleanMs);
  });
});

describe('schoolmaster tap offset', () => {
  it('lies inside the reference clean tier but never inside its perfect tier, on both sides', () => {
    let positive = 0;
    let negative = 0;
    for (let i = 0; i < 500; i += 1) {
      const roll = () => (i + 0.5) / 500;
      const offset = schoolmasterTapOffset(BASE_WINDOW, roll);
      expect(Math.abs(offset)).toBeGreaterThan(BASE_WINDOW.perfectMs);
      expect(Math.abs(offset)).toBeLessThanOrEqual(BASE_WINDOW.cleanMs);
      if (offset > 0) positive += 1;
      else negative += 1;
    }
    expect(positive).toBeGreaterThan(0);
    expect(negative).toBeGreaterThan(0);
  });

  it('a roll of 0 lands strictly outside the perfect tier (perfectMs + 1 ms), never on its boundary', () => {
    const magnitude = Math.abs(schoolmasterTapOffset(BASE_WINDOW, () => 0));
    expect(magnitude).toBeGreaterThan(BASE_WINDOW.perfectMs);
    expect(magnitude).toBeLessThanOrEqual(BASE_WINDOW.perfectMs + 1);
  });

  it('a roll near 1 reaches the far edge of the clean tier but not beyond it', () => {
    const magnitude = Math.abs(schoolmasterTapOffset(BASE_WINDOW, () => 0.999999));
    expect(magnitude).toBeGreaterThan(BASE_WINDOW.cleanMs - 1);
    expect(magnitude).toBeLessThanOrEqual(BASE_WINDOW.cleanMs);
  });
});

describe('schoolmaster composed with the judge (plan 1.8: clean but slow, with the approach risk kept)', () => {
  const rideWithSchoolmaster = (approach: ApproachState, roll: () => number) => {
    const gear = schoolmasterGear(approach.gear, true);
    const collected: ApproachState = { ...approach, gear };
    const offset = schoolmasterTapOffset(schoolmasterReferenceWindow(collected), roll);
    return judgeTakeoff(collected, offset, lucky);
  };

  it('a good approach gives clean, never perfect, and the gear is collected even if gallop was requested', () => {
    expect(schoolmasterGear('gallop', true)).toBe('collected');
    for (let i = 0; i < 50; i += 1) {
      const o = rideWithSchoolmaster(good({ gear: 'gallop' }), () => (i + 0.5) / 50);
      expect(o.kind).toBe('clean');
      expect(o.faults).toBe(0);
    }
  });

  it('roll 0 on a good approach is judged clean, not perfect: the boundary is outside the perfect tier', () => {
    expect(rideWithSchoolmaster(good(), () => 0)).toMatchObject({ kind: 'clean', faults: 0 });
  });

  it('with the lead-horse bonus the auto-tap is still never perfect (the bonus widens only the clean tier)', () => {
    const led = good({ leadHorseBonus: true });
    expect(takeoffWindow(led).perfectMs).toBe(takeoffWindow(good()).perfectMs);
    for (const roll of [0, 0.01, 0.1, 0.5, 0.999999]) {
      const o = rideWithSchoolmaster(led, () => roll);
      expect(o.kind).toBe('clean');
      expect(o.faults).toBe(0);
    }
  });

  it('a spooked or sharp-angled approach with an unlucky roll gives a chip (4 faults) or a run-out, not a fall', () => {
    const outcomes = new Set<string>();
    for (const approach of [good({ spooked: true }), good({ angleSharp: true })]) {
      const o = rideWithSchoolmaster(approach, () => 0.999999); // aims at the far edge of the reference clean tier
      expect(o.kind).not.toBe('fall');
      expect(o.kind).not.toBe('perfect');
      outcomes.add(o.kind);
    }
    expect(outcomes.has('chip') || outcomes.has('long')).toBe(true);
    expect(outcomes.has('runout')).toBe(true);
  });

  it('a spooked approach with a lucky roll is still clean: the risk exists but is not certain', () => {
    const o = rideWithSchoolmaster(good({ spooked: true }), () => 0);
    expect(o.kind).toBe('clean');
  });
});

describe('settings are frozen for the round', () => {
  it('changing the live settings mid-round does not change the frozen copy', () => {
    const live: AssistSettings = { schoolmaster: false, widerWindow: false };
    const frozen = freezeForRound(live);
    live.widerWindow = true;
    live.schoolmaster = true;
    expect(frozen).toEqual({ schoolmaster: false, widerWindow: false });
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});
