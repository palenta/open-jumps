// The composition layer (plan 2.3, 1.8): the window in force for an attempt and its outcome, computed from the
// approach AND the round rules (mode, frozen assist settings). Server and client both call this; there is one judge.
import { effectiveWindow, freezeForRound, type RoundRules } from './assists.js';
import { judgeWithWindow, takeoffWindow, type ApproachState, type TakeoffOutcome, type TakeoffWindow } from './takeoff.js';

/** Version of the judging rules (windows, outcome table); stored with every result so records never mix (plan 2.5). */
export const RULES_VERSION = 1;

/** A ranked round without assists: the plain approach window (what judgeTakeoff uses). */
export const RANKED_NO_ASSISTS: RoundRules = {
  mode: 'ranked',
  assists: freezeForRound({ schoolmaster: false, widerWindow: false }),
};

/** The window actually in force for this attempt: the approach window passed through the round rules. */
export function windowForAttempt(approach: ApproachState, round: RoundRules): TakeoffWindow {
  return effectiveWindow(takeoffWindow(approach), round.assists, round.mode);
}

/** Judge an attempt under the round rules; identical to judgeTakeoff when the round is RANKED_NO_ASSISTS. */
export function judgeAttempt(
  approach: ApproachState,
  offsetMs: number | null,
  roll: () => number,
  round: RoundRules,
): TakeoffOutcome {
  return judgeWithWindow(approach, windowForAttempt(approach, round), offsetMs, roll);
}
