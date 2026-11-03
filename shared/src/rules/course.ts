// Course model (plan 1.7, 2.5): a one-dimensional track with fences and turn points at distances in metres,
// a speed norm, and the time allowed / limit derived from them. Shared by server simulation and client HUD.
import { timeAllowedSec, timeLimitSec } from './faults.js';
import { createRng } from './rng.js';
import type { Gear } from './takeoff.js';

export type FenceType = 'vertical' | 'oxer';

export interface FenceSpec {
  /** 1-based number in course order. */
  number: number;
  /** Distance along the track of the take-off point. */
  distanceM: number;
  type: FenceType;
}

export type TurnDirection = 'left' | 'right';

export interface TurnSpec {
  /** Distance along the track where the turn must be taken. */
  distanceM: number;
  direction: TurnDirection;
}

export interface CourseSpec {
  id: string;
  /** Bumped whenever fences or turns change, so results of different layouts never mix (plan 2.5). */
  version: number;
  /** Track length in metres; the finish line is at lengthM. */
  lengthM: number;
  /** Speed norm in metres per minute (300 club, 325 upper tiers). */
  speedMPerMin: number;
  fences: FenceSpec[];
  turns: TurnSpec[];
}

export const COURSE_LIMITS = {
  minFences: 6,
  maxFences: 12,
  /** Minimum distance between consecutive take-off points and from the start to the first fence. */
  minGapM: 8,
  /** Minimum run-in after the last fence before the finish line. */
  minRunInM: 10,
} as const;

/** A turn point may not lie closer than this before a take-off point (exactly this far is allowed). */
const MIN_TURN_BEFORE_TAKEOFF_M = 12;

/** Effective speed per gear, metres per minute (collected keeps the club norm; 5, 6 and 7 m/s). */
export const GEAR_SPEED_M_PER_MIN: Readonly<Record<Gear, number>> = { collected: 300, extended: 360, gallop: 420 };

export function gearSpeedMPerS(gear: Gear): number {
  return GEAR_SPEED_M_PER_MIN[gear] / 60;
}

export type CourseProblem =
  | 'fence-count'
  | 'fence-numbering'
  | 'fence-order'
  | 'fence-gap'
  | 'fence-beyond-finish'
  | 'turn-position'
  | 'length'
  | 'speed';

export type CourseCheck = { ok: true } | { ok: false; problem: CourseProblem };

const fail = (problem: CourseProblem): CourseCheck => ({ ok: false, problem });

/**
 * Structural validity: 6–12 fences numbered 1..n in order of strictly increasing distance, gaps ≥ minGapM
 * (also from the start), the last take-off ≥ minRunInM before the finish, turns strictly between two
 * consecutive fences (never before fence 1, never after the last fence, never two turns at the same spot,
 * never closer than 12 m before a take-off point — exactly 12 m is allowed), positive length and speed.
 * Checks run in this order: fence-count, fence-numbering, fence-order, length, speed, fence-gap,
 * fence-beyond-finish, turn-position; the first problem found is reported.
 */
export function validateCourse(course: CourseSpec): CourseCheck {
  const { fences, turns } = course;

  if (fences.length < COURSE_LIMITS.minFences || fences.length > COURSE_LIMITS.maxFences) return fail('fence-count');

  if (fences.some((fence, i) => fence.number !== i + 1)) return fail('fence-numbering');

  let previous: FenceSpec | undefined;
  for (const fence of fences) {
    if (previous !== undefined && !(fence.distanceM > previous.distanceM)) return fail('fence-order');
    previous = fence;
  }

  if (!(course.lengthM > 0)) return fail('length');
  if (!(course.speedMPerMin > 0)) return fail('speed');

  let previousTakeoffM = 0;
  for (const fence of fences) {
    if (!(fence.distanceM - previousTakeoffM >= COURSE_LIMITS.minGapM)) return fail('fence-gap');
    previousTakeoffM = fence.distanceM;
  }

  if (!(course.lengthM - previousTakeoffM >= COURSE_LIMITS.minRunInM)) return fail('fence-beyond-finish');

  const first = fences[0];
  const seen = new Set<number>();
  for (const turn of turns) {
    if (seen.has(turn.distanceM)) return fail('turn-position');
    seen.add(turn.distanceM);
    // The first take-off at or beyond the turn: none → the turn is after the last fence; fence 1 → the turn
    // is before (or on) fence 1; otherwise it must be at least 12 m further on (0 m = a turn on a take-off point).
    const next = fences.find((fence) => fence.distanceM >= turn.distanceM);
    if (next === undefined || next === first) return fail('turn-position');
    if (!(next.distanceM - turn.distanceM >= MIN_TURN_BEFORE_TAKEOFF_M)) return fail('turn-position');
  }

  return { ok: true };
}

export interface CourseTimes {
  allowedSec: number;
  limitSec: number;
}

/** Time allowed (whole seconds, from length and speed) and the limit min(2 × allowed, 150). */
export function courseTimes(course: CourseSpec): CourseTimes {
  const allowedSec = timeAllowedSec(course.lengthM, course.speedMPerMin);
  return { allowedSec, limitSec: timeLimitSec(allowedSec) };
}

/** Shape of a generated club-tier course (metres). */
const CLUB_COURSE = {
  minFences: 6,
  maxFences: 8,
  speedMPerMin: 300,
  minLengthM: 250,
  maxLengthM: 300,
  /** Distance between consecutive take-off points. */
  minGapM: 30,
  maxGapM: 45,
  /** Longest start gap (the shortest is COURSE_LIMITS.minGapM). */
  maxStartM: 20,
  /** Run-in after the last take-off (the course is then stretched to minLengthM if still shorter). */
  minRunInM: 10,
  maxRunInM: 30,
  /** A turn is placed no closer than this after the previous take-off, so the horse has landed first. */
  minTurnAfterTakeoffM: 8,
} as const;

/**
 * A deterministic club-tier course for a seed: `fenceCount` fences (6–8) spaced 30–45 m apart, a turn between
 * roughly every second pair of fences, total length 250–300 m, speed 300 m/min. The same seed always gives the
 * same course; the id embeds the seed and the version is 1.
 */
export function clubCourse(seed: number | string, fenceCount: number): CourseSpec {
  if (!Number.isInteger(fenceCount) || fenceCount < CLUB_COURSE.minFences || fenceCount > CLUB_COURSE.maxFences) {
    throw new RangeError(`a club course has ${CLUB_COURSE.minFences}–${CLUB_COURSE.maxFences} fences, not ${fenceCount}`);
  }

  const rng = createRng(`course|${String(seed)}|${fenceCount}`);
  /** A uniform integer in [min, max]. */
  const draw = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

  // Gaps between take-off points. The upper bound shrinks so that eight fences still fit in maxLengthM
  // with the shortest start gap and run-in (7 × 45 m would not).
  const gapCount = fenceCount - 1;
  const gapBudgetM = CLUB_COURSE.maxLengthM - COURSE_LIMITS.minGapM - COURSE_LIMITS.minRunInM;
  const maxGapM = Math.min(CLUB_COURSE.maxGapM, Math.floor(gapBudgetM / gapCount));
  const gaps = Array.from({ length: gapCount }, () => draw(CLUB_COURSE.minGapM, maxGapM));
  const gapsTotalM = gaps.reduce((sum, gap) => sum + gap, 0);

  // Start gap: never so long that the run-in no longer fits before maxLengthM.
  const maxStartM = Math.min(CLUB_COURSE.maxStartM, CLUB_COURSE.maxLengthM - CLUB_COURSE.minRunInM - gapsTotalM);
  const takeoffs: number[] = [draw(COURSE_LIMITS.minGapM, maxStartM)];
  for (const gap of gaps) takeoffs.push((takeoffs[takeoffs.length - 1] ?? 0) + gap);
  const lastTakeoffM = takeoffs[takeoffs.length - 1] ?? 0;

  // Fence 1 is always a vertical (an inviting first fence); the rest are drawn.
  const fences = takeoffs.map(
    (distanceM, i): FenceSpec => ({ number: i + 1, distanceM, type: i === 0 || draw(0, 1) === 0 ? 'vertical' : 'oxer' }),
  );

  const runInM = draw(CLUB_COURSE.minRunInM, CLUB_COURSE.maxRunInM);
  const lengthM = Math.max(CLUB_COURSE.minLengthM, Math.min(CLUB_COURSE.maxLengthM, lastTakeoffM + runInM));

  // A turn in every second gap, starting with the first or the second gap; placed after the landing of the
  // previous fence and at least 12 m before the next take-off.
  const turns: TurnSpec[] = [];
  for (let i = draw(0, 1); i < gapCount; i += 2) {
    const from = takeoffs[i];
    const to = takeoffs[i + 1];
    if (from === undefined || to === undefined) break;
    turns.push({
      distanceM: draw(from + CLUB_COURSE.minTurnAfterTakeoffM, to - MIN_TURN_BEFORE_TAKEOFF_M),
      direction: draw(0, 1) === 0 ? 'left' : 'right',
    });
  }

  return {
    id: `club|${String(seed)}|${fenceCount}`,
    version: 1,
    lengthM,
    speedMPerMin: CLUB_COURSE.speedMPerMin,
    fences,
    turns,
  };
}
