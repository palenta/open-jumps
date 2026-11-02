// Assists as rider settings (plan 1.8): schoolmaster is allowed in ranked rounds; the wider window only in training.
import { takeoffWindow, type ApproachState, type Gear, type TakeoffWindow } from './takeoff.js';

export type RoundMode = 'ranked' | 'training';

export interface AssistSettings {
  schoolmaster: boolean;
  widerWindow: boolean;
}

/** What a round knows about assists: its mode and the settings frozen when it started. */
export interface RoundRules {
  mode: RoundMode;
  assists: Readonly<AssistSettings>;
}

export const WIDER_WINDOW_FACTOR = 1.5;

/** Schoolmaster never aims closer to the perfect tier than this. */
const PERFECT_MARGIN_MS = 1;

const NO_ASSISTS: Readonly<AssistSettings> = Object.freeze({ schoolmaster: false, widerWindow: false });
const RANKED_DEFAULT: RoundRules = { mode: 'ranked', assists: NO_ASSISTS };

/** The window actually used: wider only when the setting is on AND the round is training. */
export function effectiveWindow(
  window: TakeoffWindow,
  settings: Readonly<AssistSettings>,
  mode: RoundMode,
): TakeoffWindow {
  if (mode === 'training' && settings.widerWindow) {
    return { cleanMs: window.cleanMs * WIDER_WINDOW_FACTOR, perfectMs: window.perfectMs * WIDER_WINDOW_FACTOR };
  }
  return { ...window };
}

/** Schoolmaster collects the canter before a fence whatever the rider chose. */
export function schoolmasterGear(requested: Gear, approachingFence: boolean): Gear {
  return approachingFence ? 'collected' : requested;
}

/**
 * The window schoolmaster aims at: the window of an IDEAL approach at the same height class
 * (collected, straight, no hard turn, no spook, no lead-horse bonus), passed through the same round rules
 * as the real attempt. It is deliberately not the actual narrowed window, so a sharp angle or a spook can
 * still turn the auto-tap into a rail (plan 1.8); and because it is widened exactly like the real window in
 * training, the auto-tap stays outside the perfect tier there too.
 */
export function schoolmasterReferenceWindow(approach: ApproachState, round: RoundRules = RANKED_DEFAULT): TakeoffWindow {
  const ideal = takeoffWindow({
    gear: 'collected',
    heightClass: approach.heightClass,
    angleSharp: false,
    recentHardTurn: false,
    spooked: false,
    leadHorseBonus: false,
  });
  return effectiveWindow(ideal, round.assists, round.mode);
}

/**
 * Schoolmaster's own take-off offset relative to the reference window: |offset| strictly greater than
 * perfectMs (roll 0 → perfectMs + 1 ms) and at most cleanMs (roll → 1 → cleanMs); sign by a second roll.
 * Because no approach modifier ever widens the perfect tier (see takeoffWindow) and the round rules widen
 * the reference exactly like the real window, an offset outside the reference perfect tier is outside the
 * actual perfect tier too: schoolmaster never scores "perfect".
 */
export function schoolmasterTapOffset(referenceWindow: TakeoffWindow, roll: () => number): number {
  const lowest = referenceWindow.perfectMs + PERFECT_MARGIN_MS;
  const span = Math.max(0, referenceWindow.cleanMs - lowest);
  const magnitude = lowest + roll() * span;
  const sign = roll() < 0.5 ? -1 : 1;
  return sign * magnitude;
}

/** Settings are frozen for a round when it starts; later changes apply to the next round only. */
export function freezeForRound(settings: AssistSettings): Readonly<AssistSettings> {
  return Object.freeze({ schoolmaster: settings.schoolmaster, widerWindow: settings.widerWindow });
}
