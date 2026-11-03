// Turns with timing (plan 1.8 item 0): left / right / straight buttons judged against the turn moment.
import type { TurnDirection } from './course.js';
import type { Gear } from './takeoff.js';

export const TURN = {
  /** ±window around the turn moment for a tight turn. */
  windowMs: 400,
  /** A press later than this (after the turn moment) counts as no press. */
  lateMs: 900,
  /** The horse runs straight at the rail, brakes and turns back ("¡Recto!"). */
  missedStopSec: 4,
  /** Heading for the wrong fence: "recorrido equivocado", come back. */
  wrongStopSec: 6,
} as const;

export type TurnChoice = TurnDirection | 'straight';

export type TurnQuality = 'tight' | 'wide' | 'missed' | 'wrong';

export interface TurnOutcome {
  quality: TurnQuality;
  /** Seconds the horse stands still (0 for tight and wide). */
  stopSec: number;
  /** The next fence is approached after a hard turn (narrower take-off window). */
  hardTurn: boolean;
  /** Caption key in rider vocabulary (Spanish terms). */
  label: string;
}

/**
 * Judge one turn point. `expected` is the course's direction; `pressed` the rider's button (null = nothing,
 * 'straight' = explicitly nothing); `offsetMs` = action time − turn moment (negative = early), null when
 * there was no press in time.
 * - the other direction → 'wrong' whatever the offset (stop 6 s, hard turn, label 'recorrido_equivocado');
 * - no press, 'straight', or a press later than +lateMs → 'missed' (stop 4 s, hard turn, label 'recto');
 * - |offset| ≤ windowMs → 'tight' (no stop; hard turn only when the gear is gallop — a turn at gallop costs
 *   confidence, label 'giro_cerrado');
 * - otherwise (early beyond the window, or late up to lateMs) → 'wide' (no stop, hard turn, label 'giro_abierto').
 */
export function judgeTurn(
  expected: TurnDirection,
  pressed: TurnChoice | null,
  offsetMs: number | null,
  gear: Gear,
): TurnOutcome {
  if (pressed !== null && pressed !== 'straight' && pressed !== expected) {
    return { quality: 'wrong', stopSec: TURN.wrongStopSec, hardTurn: true, label: 'recorrido_equivocado' };
  }
  if (pressed === null || pressed === 'straight' || offsetMs === null || offsetMs > TURN.lateMs) {
    return { quality: 'missed', stopSec: TURN.missedStopSec, hardTurn: true, label: 'recto' };
  }
  if (Math.abs(offsetMs) <= TURN.windowMs) {
    return { quality: 'tight', stopSec: 0, hardTurn: gear === 'gallop', label: 'giro_cerrado' };
  }
  return { quality: 'wide', stopSec: 0, hardTurn: true, label: 'giro_abierto' };
}
