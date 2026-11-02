// Matrix row 4 (plan 2.9): time allowed, the single time-limit formula, started-second faults, disobediences.
import { describe, expect, it } from 'vitest';
import {
  FAULTS,
  TIME_LIMIT_CAP_SEC,
  isTimeEliminated,
  refusalFaults,
  timeAllowedSec,
  timeFaults,
  timeLimitSec,
} from '../src/rules/faults.js';

describe('time allowed', () => {
  it('300 m at 300 m/min is 60 s', () => {
    expect(timeAllowedSec(300, 300)).toBe(60);
  });

  it('rounds a fractional result up to the next whole second (450 m at 325 m/min → 84)', () => {
    expect(timeAllowedSec(450, 325)).toBe(84);
  });

  it('rejects a non-positive length or speed with a RangeError', () => {
    expect(() => timeAllowedSec(0, 300)).toThrow(RangeError);
    expect(() => timeAllowedSec(300, 0)).toThrow(RangeError);
  });
});

describe('time limit: 2 × allowed, but never more than 150 s (plan 1.7)', () => {
  it('norm 60 → limit 120', () => {
    expect(timeLimitSec(60)).toBe(120);
  });

  it('norm 85 → limit 150 (the cap)', () => {
    expect(timeLimitSec(85)).toBe(150);
  });

  it('norm 75 → limit exactly 150', () => {
    expect(timeLimitSec(75)).toBe(150);
  });

  it('the cap constant is 150', () => {
    expect(TIME_LIMIT_CAP_SEC).toBe(150);
  });
});

describe('time faults: one per started second over the time allowed', () => {
  it('no faults at or under the time allowed', () => {
    expect(timeFaults(59.9, 60)).toBe(0);
    expect(timeFaults(60, 60)).toBe(0);
  });

  it('60.2 s with norm 60 → 1 fault', () => {
    expect(timeFaults(60.2, 60)).toBe(1);
  });

  it('61.0 → 1 fault, 61.1 → 2 faults', () => {
    expect(timeFaults(61.0, 60)).toBe(1);
    expect(timeFaults(61.1, 60)).toBe(2);
  });

  it('rejects a negative elapsed time with a RangeError', () => {
    expect(() => timeFaults(-1, 60)).toThrow(RangeError);
  });
});

describe('time elimination at the limit', () => {
  it('a finish strictly before the limit counts', () => {
    expect(isTimeEliminated(119.9, 60)).toBe(false);
  });

  it('reaching the limit exactly is an elimination', () => {
    expect(isTimeEliminated(120, 60)).toBe(true);
  });

  it('uses the 150 s cap: norm 85, elapsed 150 → eliminated, 149.9 → not', () => {
    expect(isTimeEliminated(150, 85)).toBe(true);
    expect(isTimeEliminated(149.9, 85)).toBe(false);
  });
});

describe('disobediences (refusal or run-out)', () => {
  it('first 4, second 8, third eliminated', () => {
    expect(refusalFaults(1)).toBe(4);
    expect(refusalFaults(2)).toBe(8);
    expect(refusalFaults(3)).toBe('eliminated');
  });

  it('a number below 1 is invalid (RangeError)', () => {
    expect(() => refusalFaults(0)).toThrow(RangeError);
  });

  it('fault constants: rail 4, fall 8, one per started second', () => {
    expect(FAULTS.rail).toBe(4);
    expect(FAULTS.fall).toBe(8);
    expect(FAULTS.timePerStartedSecond).toBe(1);
  });
});
