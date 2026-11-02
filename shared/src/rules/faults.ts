// Faults and time rules (plan 1.7, 1.8): Pony Club-style scoring with the game's own 150 s cap.

/** Fault values. A third disobedience is an elimination, not a number (see refusalFaults). */
export const FAULTS = {
  rail: 4,
  firstRefusal: 4,
  secondRefusal: 8,
  fall: 8,
  timePerStartedSecond: 1,
} as const;

/** The game's deviation from Pony Club: the limit is 2 × time allowed, but never more than this. */
export const TIME_LIMIT_CAP_SEC = 150;

/** Guards against floating-point noise such as 60.000000001 when the exact result is 60. */
const EPSILON = 1e-9;

/** Time allowed for a course, in whole seconds, rounded up (length in metres, speed in metres per minute). */
export function timeAllowedSec(courseLengthM: number, speedMPerMin: number): number {
  if (!(courseLengthM > 0) || !(speedMPerMin > 0)) {
    throw new RangeError('course length and speed must be positive');
  }
  return Math.ceil((courseLengthM / speedMPerMin) * 60 - EPSILON);
}

/** Time limit = min(2 × allowed, 150). */
export function timeLimitSec(allowedSec: number): number {
  return Math.min(2 * allowedSec, TIME_LIMIT_CAP_SEC);
}

/** One fault per started second over the time allowed; zero at or under it. */
export function timeFaults(elapsedSec: number, allowedSec: number): number {
  if (elapsedSec < 0) throw new RangeError('elapsed time cannot be negative');
  const over = elapsedSec - allowedSec;
  return over <= 0 ? 0 : Math.ceil(over - EPSILON) * FAULTS.timePerStartedSecond;
}

/** A rider still on course at the limit (elapsed ≥ limit) is eliminated; a finish strictly before it counts. */
export function isTimeEliminated(elapsedSec: number, allowedSec: number): boolean {
  return elapsedSec >= timeLimitSec(allowedSec);
}

/** Faults for the n-th disobedience (refusal or run-out) in a round: 4, then 8, then elimination. */
export function refusalFaults(refusalNumber: number): number | 'eliminated' {
  if (!Number.isInteger(refusalNumber) || refusalNumber < 1) {
    throw new RangeError('refusal number starts at 1');
  }
  if (refusalNumber === 1) return FAULTS.firstRefusal;
  if (refusalNumber === 2) return FAULTS.secondRefusal;
  return 'eliminated';
}
