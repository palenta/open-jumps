// Take-off window and outcomes (plan 1.8 outcome table, 2.3): one pure judge shared by server and client.
import { FAULTS } from './faults.js';
import { gallopRailProbability, windowScaleForHeight, type HeightClass } from './heightClasses.js';

export type Gear = 'collected' | 'extended' | 'gallop';

export interface ApproachState {
  gear: Gear;
  heightClass: HeightClass;
  /** Cutting the corner into the fence (shorter path, narrower window; a miss becomes a run-out). */
  angleSharp: boolean;
  /** A hard turn in the last strides narrows the window. */
  recentHardTurn: boolean;
  /** The horse was spooked on this approach. */
  spooked: boolean;
  /** Another rider cleared this fence within ~2 s on a good line (plan 1.11а "lead horse"). */
  leadHorseBonus: boolean;
}

/** Half-widths in milliseconds around the ideal take-off moment t0. */
export interface TakeoffWindow {
  cleanMs: number;
  perfectMs: number;
}

/** Starting values from the research (±150–200 clean, ±50–80 perfect); to be tuned after probe 2.6 №1. */
export const BASE_WINDOW: TakeoffWindow = { cleanMs: 175, perfectMs: 65 };

/** Beyond this offset (either side) a tap is treated as "no tap". */
export const NO_TAP_LIMIT_MS = 400;

/** Window modifiers (plan 1.8); narrowing ones scale both tiers, the lead-horse bonus only the clean tier. */
export const WINDOW_MODIFIERS = {
  hardTurn: 0.7,
  spooked: 0.7,
  sharpAngle: 0.8,
  gallop: 0.5,
  leadHorseClean: 1.25,
} as const;

export type TakeoffKind =
  | 'perfect'
  | 'clean'
  | 'chip' // late: extra half stride, front rail
  | 'long' // early: flat arc, back rail
  | 'refusal'
  | 'runout'
  | 'fall';

export interface TakeoffOutcome {
  kind: TakeoffKind;
  /** Faults added by this attempt (rails, fall); disobedience numbering (4/8/elimination) is applied by the round. */
  faults: number;
  /** Whether the fence counts as jumped (the rider moves on) or must be re-attempted. */
  cleared: boolean;
  /** Rider-vocabulary label key for the caption (Spanish terms, plan 1.5). */
  label: string;
  /** Whether the horse jumped at all (a fall still means the horse went over; a refusal does not). */
  horseJumped: boolean;
}

const OUTCOMES = {
  perfect: (): TakeoffOutcome => ({ kind: 'perfect', faults: 0, cleared: true, label: 'perfecta', horseJumped: true }),
  clean: (): TakeoffOutcome => ({ kind: 'clean', faults: 0, cleared: true, label: 'cero_faltas', horseJumped: true }),
  chip: (): TakeoffOutcome => ({ kind: 'chip', faults: FAULTS.rail, cleared: true, label: 'batida_corta', horseJumped: true }),
  long: (): TakeoffOutcome => ({ kind: 'long', faults: FAULTS.rail, cleared: true, label: 'batida_larga', horseJumped: true }),
  refusal: (fallFaults = 0): TakeoffOutcome => ({ kind: 'refusal', faults: fallFaults, cleared: false, label: 'rehuse', horseJumped: false }),
  runout: (): TakeoffOutcome => ({ kind: 'runout', faults: 0, cleared: false, label: 'desvio', horseJumped: false }),
  fall: (): TakeoffOutcome => ({ kind: 'fall', faults: FAULTS.fall, cleared: false, label: 'caida', horseJumped: true }),
};

/**
 * The window for this approach: base × height scale × approach modifiers.
 * Narrowing modifiers (height, hard turn, spook, sharp angle, gallop) scale both tiers;
 * the lead-horse bonus widens the CLEAN tier only — "perfect" stays a skill and never gets easier,
 * so no assist aiming outside the ideal perfect tier can land inside the actual one.
 */
export function takeoffWindow(approach: ApproachState): TakeoffWindow {
  let scale = windowScaleForHeight(approach.heightClass);
  if (approach.recentHardTurn) scale *= WINDOW_MODIFIERS.hardTurn;
  if (approach.spooked) scale *= WINDOW_MODIFIERS.spooked;
  if (approach.angleSharp) scale *= WINDOW_MODIFIERS.sharpAngle;
  if (approach.gear === 'gallop') scale *= WINDOW_MODIFIERS.gallop;
  const cleanScale = approach.leadHorseBonus ? scale * WINDOW_MODIFIERS.leadHorseClean : scale;
  return { cleanMs: BASE_WINDOW.cleanMs * cleanScale, perfectMs: BASE_WINDOW.perfectMs * scale };
}

/** An approach is "bad" when something narrowed it beyond the height alone; without a tap the horse then refuses. */
function isBadApproach(approach: ApproachState): boolean {
  return approach.recentHardTurn || approach.spooked || approach.angleSharp;
}

/**
 * The one judge. `window` is the window actually in force for this attempt (the approach window, possibly
 * passed through the round rules — see judging.ts); `offsetMs` is action time − t0 (negative = early), or null
 * for "no tap"; `roll` supplies the chance value in [0, 1) for outcomes that depend on luck (gallop + clean tier).
 */
export function judgeWithWindow(
  approach: ApproachState,
  window: TakeoffWindow,
  offsetMs: number | null,
  roll: () => number,
): TakeoffOutcome {
  const gallop = approach.gear === 'gallop';

  // No tap, or a tap too far from t0 to count as one (the ±400 ms limit never depends on the window).
  if (offsetMs === null || Math.abs(offsetMs) > NO_TAP_LIMIT_MS) {
    if (gallop) return OUTCOMES.refusal(FAULTS.fall);
    if (isBadApproach(approach)) return OUTCOMES.refusal();
    return OUTCOMES.chip();
  }

  const distance = Math.abs(offsetMs);

  if (distance <= window.perfectMs) {
    return gallop ? OUTCOMES.clean() : OUTCOMES.perfect();
  }
  if (distance <= window.cleanMs) {
    if (gallop && roll() < gallopRailProbability(approach.heightClass)) return OUTCOMES.long();
    return OUTCOMES.clean();
  }

  // A miss inside ±400 ms.
  if (approach.angleSharp) return OUTCOMES.runout();
  if (gallop) return OUTCOMES.fall();
  return offsetMs < 0 ? OUTCOMES.long() : OUTCOMES.chip();
}

/** Judge a take-off with the plain approach window (ranked rounds without assists; see judging.ts for rounds). */
export function judgeTakeoff(
  approach: ApproachState,
  offsetMs: number | null,
  roll: () => number,
): TakeoffOutcome {
  return judgeWithWindow(approach, takeoffWindow(approach), offsetMs, roll);
}
