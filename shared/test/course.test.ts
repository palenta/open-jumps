// Course model (plan 1.7, 2.5): limits, gear speeds, time allowed / limit, structural validation and the
// deterministic club course. The server simulation and the client HUD both read this spec.
import { describe, expect, it } from 'vitest';
import {
  COURSE_LIMITS,
  GEAR_SPEED_M_PER_MIN,
  clubCourse,
  courseTimes,
  gearSpeedMPerS,
  validateCourse,
  type CourseSpec,
  type FenceSpec,
  type TurnDirection,
  type TurnSpec,
} from '../src/rules/course.js';

/** Fences numbered 1..n in the given order of take-off distances, alternating vertical / oxer. */
const fencesAt = (...distances: number[]): FenceSpec[] =>
  distances.map((distanceM, i): FenceSpec => ({ number: i + 1, distanceM, type: i % 2 === 0 ? 'vertical' : 'oxer' }));

const turnsAt = (...turns: [number, TurnDirection][]): TurnSpec[] =>
  turns.map(([distanceM, direction]): TurnSpec => ({ distanceM, direction }));

/**
 * A hand-built valid course: six fences every 40 m from 40 to 240 m, a turn at 60 m (20 m before fence 2) and
 * one at 140 m (20 m before fence 4), finish at 280 m (40 m run-in), club speed.
 */
const valid = (): CourseSpec => ({
  id: 'hand-built',
  version: 1,
  lengthM: 280,
  speedMPerMin: 300,
  fences: fencesAt(40, 80, 120, 160, 200, 240),
  turns: turnsAt([60, 'left'], [140, 'right']),
});

const withFences = (...distances: number[]): CourseSpec => ({ ...valid(), fences: fencesAt(...distances) });

const withTurns = (...turns: [number, TurnDirection][]): CourseSpec => ({ ...valid(), turns: turnsAt(...turns) });

/** The valid take-off distances, with the fences numbered as given instead of 1..6. */
const numbered = (numbers: number[]): CourseSpec => ({
  ...valid(),
  fences: valid().fences.map((fence, i): FenceSpec => ({ ...fence, number: numbers[i]! })),
});

describe('COURSE_LIMITS', () => {
  it('6–12 fences, 8 m minimum gap (also from the start), 10 m run-in before the finish', () => {
    expect(COURSE_LIMITS).toEqual({ minFences: 6, maxFences: 12, minGapM: 8, minRunInM: 10 });
  });
});

describe('gear speeds', () => {
  it('collected 300, extended 360, gallop 420 m per minute', () => {
    expect(GEAR_SPEED_M_PER_MIN).toEqual({ collected: 300, extended: 360, gallop: 420 });
  });

  it('are exactly 5, 6 and 7 m per second', () => {
    expect(gearSpeedMPerS('collected')).toBe(5);
    expect(gearSpeedMPerS('extended')).toBe(6);
    expect(gearSpeedMPerS('gallop')).toBe(7);
  });
});

describe('courseTimes', () => {
  it('300 m at 300 m/min: 60 s allowed, 120 s limit', () => {
    expect(courseTimes({ ...valid(), lengthM: 300, speedMPerMin: 300 })).toEqual({ allowedSec: 60, limitSec: 120 });
  });

  it('450 m at 325 m/min: 83.08 s rounds up to 84 s allowed; the limit is capped at 150 s', () => {
    expect(courseTimes({ ...valid(), lengthM: 450, speedMPerMin: 325 })).toEqual({ allowedSec: 84, limitSec: 150 });
  });
});

describe('validateCourse', () => {
  describe('valid courses', () => {
    it('the hand-built 6-fence course with two turns is valid', () => {
      expect(validateCourse(valid())).toEqual({ ok: true });
    });

    it('12 fences is still within the limit', () => {
      const twelve = Array.from({ length: 12 }, (_, i) => 40 * (i + 1));
      expect(validateCourse({ ...withFences(...twelve), lengthM: 520 })).toEqual({ ok: true });
    });

    it('the boundaries are allowed: 8 m gaps (from the start too), a 10 m run-in, no turns', () => {
      const tight: CourseSpec = { ...valid(), lengthM: 58, fences: fencesAt(8, 16, 24, 32, 40, 48), turns: [] };
      expect(validateCourse(tight)).toEqual({ ok: true });
    });
  });

  describe('fences', () => {
    it('5 fences → fence-count', () => {
      expect(validateCourse(withFences(40, 80, 120, 160, 200))).toEqual({ ok: false, problem: 'fence-count' });
    });

    it('13 fences → fence-count', () => {
      const thirteen = Array.from({ length: 13 }, (_, i) => 40 * (i + 1));
      expect(validateCourse({ ...withFences(...thirteen), lengthM: 560 })).toEqual({ ok: false, problem: 'fence-count' });
    });

    it('numbers that are not 1..n in course order → fence-numbering', () => {
      expect(validateCourse(numbered([1, 2, 4, 3, 5, 6]))).toEqual({ ok: false, problem: 'fence-numbering' });
      expect(validateCourse(numbered([0, 1, 2, 3, 4, 5]))).toEqual({ ok: false, problem: 'fence-numbering' });
      expect(validateCourse(numbered([1, 2, 2, 4, 5, 6]))).toEqual({ ok: false, problem: 'fence-numbering' });
    });

    it('take-off distances that are not strictly increasing → fence-order', () => {
      const swapped: CourseSpec = { ...withFences(40, 80, 160, 120, 200, 240), turns: turnsAt([60, 'left']) };
      expect(validateCourse(swapped)).toEqual({ ok: false, problem: 'fence-order' });
      const repeated: CourseSpec = { ...withFences(40, 80, 120, 120, 200, 240), turns: turnsAt([60, 'left']) };
      expect(validateCourse(repeated)).toEqual({ ok: false, problem: 'fence-order' });
    });

    it('7 m between two consecutive take-off points → fence-gap', () => {
      expect(validateCourse(withFences(40, 80, 120, 127, 160, 200))).toEqual({ ok: false, problem: 'fence-gap' });
    });

    it('the first take-off 7 m from the start → fence-gap', () => {
      expect(validateCourse(withFences(7, 80, 120, 160, 200, 240))).toEqual({ ok: false, problem: 'fence-gap' });
    });

    it('the last take-off 9 m before the finish → fence-beyond-finish', () => {
      expect(validateCourse({ ...valid(), lengthM: 249 })).toEqual({ ok: false, problem: 'fence-beyond-finish' });
    });

    it('the last take-off on or past the finish line → fence-beyond-finish', () => {
      expect(validateCourse({ ...valid(), lengthM: 240 })).toEqual({ ok: false, problem: 'fence-beyond-finish' });
      expect(validateCourse({ ...valid(), lengthM: 230 })).toEqual({ ok: false, problem: 'fence-beyond-finish' });
    });
  });

  describe('turns', () => {
    it('a turn before fence 1 → turn-position', () => {
      expect(validateCourse(withTurns([20, 'left']))).toEqual({ ok: false, problem: 'turn-position' });
    });

    it('a turn after the last fence → turn-position', () => {
      expect(validateCourse(withTurns([260, 'right']))).toEqual({ ok: false, problem: 'turn-position' });
    });

    it('two turns at the same distance → turn-position', () => {
      expect(validateCourse(withTurns([60, 'left'], [60, 'right']))).toEqual({ ok: false, problem: 'turn-position' });
    });

    it('a turn inside the 12 m before a fence → turn-position', () => {
      expect(validateCourse(withTurns([70, 'right']))).toEqual({ ok: false, problem: 'turn-position' });
    });

    it('a turn on a take-off point → turn-position', () => {
      expect(validateCourse(withTurns([80, 'left']))).toEqual({ ok: false, problem: 'turn-position' });
    });
  });

  describe('length and speed', () => {
    it('lengthM ≤ 0 → length', () => {
      expect(validateCourse({ ...valid(), lengthM: 0 })).toEqual({ ok: false, problem: 'length' });
      expect(validateCourse({ ...valid(), lengthM: -280 })).toEqual({ ok: false, problem: 'length' });
    });

    it('speedMPerMin ≤ 0 → speed', () => {
      expect(validateCourse({ ...valid(), speedMPerMin: 0 })).toEqual({ ok: false, problem: 'speed' });
      expect(validateCourse({ ...valid(), speedMPerMin: -300 })).toEqual({ ok: false, problem: 'speed' });
    });
  });
});

describe('clubCourse', () => {
  const seeds: (number | string)[] = [1, 42, 'A', 'barcelona'];
  const counts = [6, 7, 8] as const;
  const every = (check: (course: CourseSpec, seed: number | string, n: number) => void): void => {
    for (const seed of seeds) {
      for (const n of counts) check(clubCourse(seed, n), seed, n);
    }
  };

  it('the same seed always gives the same course', () => {
    expect(clubCourse('A', 7)).toEqual(clubCourse('A', 7));
    expect(clubCourse(42, 6)).toEqual(clubCourse(42, 6));
  });

  it('another seed gives other fence distances', () => {
    const a = clubCourse('A', 7).fences.map((f) => f.distanceM);
    const b = clubCourse('B', 7).fences.map((f) => f.distanceM);
    expect(a).not.toEqual(b);
  });

  it('has exactly fenceCount fences numbered 1..n, for 6, 7 and 8', () => {
    every((course, _seed, n) => {
      expect(course.fences).toHaveLength(n);
      expect(course.fences.map((f) => f.number)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    });
  });

  it('passes validateCourse', () => {
    every((course) => expect(validateCourse(course)).toEqual({ ok: true }));
  });

  it('is 250–300 m long at 300 m/min', () => {
    every((course) => {
      expect(course.lengthM).toBeGreaterThanOrEqual(250);
      expect(course.lengthM).toBeLessThanOrEqual(300);
      expect(course.speedMPerMin).toBe(300);
    });
  });

  it('spaces consecutive take-off points 30–45 m apart', () => {
    every((course) => {
      const d = course.fences.map((f) => f.distanceM);
      for (let i = 1; i < d.length; i += 1) {
        const gap = d[i]! - d[i - 1]!;
        expect(gap).toBeGreaterThanOrEqual(30);
        expect(gap).toBeLessThanOrEqual(45);
      }
    });
  });

  it('has at least one turn, every turn strictly between two fences', () => {
    every((course) => {
      expect(course.turns.length).toBeGreaterThanOrEqual(1);
      for (const turn of course.turns) {
        const between = course.fences.some((fence, i) => {
          const next = course.fences[i + 1];
          return next !== undefined && fence.distanceM < turn.distanceM && turn.distanceM < next.distanceM;
        });
        expect(between).toBe(true);
      }
    });
  });

  it('embeds the seed in the id and is version 1', () => {
    every((course, seed) => {
      expect(course.id).toContain(String(seed));
      expect(course.version).toBe(1);
    });
  });

  it('rejects a fence count outside 6–8 with a RangeError', () => {
    expect(() => clubCourse('A', 5)).toThrow(RangeError);
    expect(() => clubCourse('A', 9)).toThrow(RangeError);
  });
});
