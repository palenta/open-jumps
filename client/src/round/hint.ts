// The instant hint (plan 2.3, matrix row 3): the SAME judge as the server (judgeAttempt from shared/), run on
// the client the moment the rider taps, so the caption appears at once; the server's verdict (the 'takeoff'
// event, ≤150 ms later on a normal network) replaces it when they differ — the server always wins. K1.1 step 6:
// the approach state and the window come from the one shared source, ApproachWindow (approachWindow.ts), which
// the take-off marker reads too; the hint keeps no copy of its own.
import { judgeAttempt, NO_TAP_LIMIT_MS, type Gear, type HeightClass, type RoundRules, type TakeoffOutcome } from '@open-jumps/shared';
import type { ClientClock } from '../net/clientClock.js';
import { ApproachWindow } from './approachWindow.js';

export interface HintContext {
  heightClass: HeightClass;
  /** Mode and the rider's own assist settings as frozen for this round. */
  rules: RoundRules;
}

export interface Hint {
  fence: number;
  attempt: number;
  /** Tap time minus t0, in server ms (via the clock estimate). */
  offsetMs: number;
  outcome: TakeoffOutcome;
  /** True when the real outcome depends on the round's random roll (a gallop take-off in the clean tier). */
  provisional: boolean;
}

export interface Reconciliation {
  hint: Hint | null;
  verdict: TakeoffOutcome;
  /** null when there was no hint for this attempt; otherwise whether the kinds match. */
  agreed: boolean | null;
}

interface OpenApproach {
  fence: number;
  attempt: number;
  /** Server time of the ideal take-off moment. */
  t0: number;
  /** The first tap decides, as on the server. */
  tapped: boolean;
}

/** The hint never gets the lucky roll: a gallop tap in the clean tier is shown as clean and marked provisional. */
const favourableRoll = (): number => 1;

/**
 * What the client knows about its own approach — its best guess, never the truth: gear from the state, the
 * line from its own command, a hard turn from its own last turn outcome; spooks and the lead-horse bonus are
 * unknown here (false), so the hint can only be stricter than the server, never more generous.
 *
 * K1.1 step 6 — the shared source: the hint is built over an ApproachWindow (the one given, or its own for the
 * context) and exposes it as approachWindow, so the game draws the take-off marker from the very object the hint
 * judges with. tap(clientTime) judges with approachWindow.stateAt(clientTime) and approachWindow.windowAt(clientTime);
 * setGear (at the clock's now), setLine, setHardTurn and configure forward to it, and a cleared verdict spends its
 * hard turn (clearedFence). assumedApproach moves into ApproachWindow — no second copy stays here.
 */
export class InstantHint {
  private readonly clock: ClientClock;
  private readonly source: ApproachWindow;
  private open: OpenApproach | null = null;
  private shown: Hint | null = null;

  constructor(clock: ClientClock, context: HintContext, approachWindow: ApproachWindow = new ApproachWindow(context)) {
    this.clock = clock;
    this.source = approachWindow;
  }

  /** The shared source of the approach state and the window (K1.1 step 6): what the hint judges with and the marker reads. */
  get approachWindow(): ApproachWindow {
    return this.source;
  }

  configure(context: HintContext): void {
    this.source.configure(context);
  }

  /** The server opened an approach for this rider: t0 is server time. Resets any earlier tap. */
  approach(event: { fence: number; attempt: number; t0: number }): void {
    this.open = { fence: event.fence, attempt: event.attempt, t0: event.t0, tapped: false };
    this.shown = null;
  }

  /**
   * The server's 'approach-sync' on taking control back (audit K1 r2 #1): its hard-turn flag, and the approach open
   * now — the same approach keeps its tap and hint; another one opens afresh; null closes the one whose verdict was
   * missed.
   */
  sync(sync: { hardTurn: boolean; approach: { fence: number; attempt: number; t0: number } | null }): void {
    this.source.setHardTurn(sync.hardTurn);
    const next = sync.approach;
    if (next === null) {
      this.open = null;
      this.shown = null;
      return;
    }
    const open = this.open;
    if (open !== null && open.fence === next.fence && open.attempt === next.attempt) return;
    this.approach(next);
  }

  /** The gear the state reports, in force from the clock's now on (a tap stamped before it still reads the gear before). */
  setGear(gear: Gear): void {
    this.source.setGear(gear, this.clock.now());
  }

  setLine(line: 'center' | 'angle'): void {
    this.source.setLine(line);
  }

  /** The last turn's outcome said hardTurn (narrower window at the next fence); spent by the take-off that clears that fence. */
  setHardTurn(on: boolean): void {
    this.source.setHardTurn(on);
  }

  /**
   * The rider tapped at clientTime: the hint for the open approach, or null when there is no open approach, the
   * clock is not ready, or this attempt was already tapped (the first tap decides, as on the server).
   */
  tap(clientTime: number): Hint | null {
    const open = this.open;
    if (open === null || open.tapped) return null;
    const serverTime = this.clock.toServer(clientTime);
    if (serverTime === null) return null;
    open.tapped = true;

    const offsetMs = serverTime - open.t0;
    const approach = this.source.stateAt(clientTime);
    const outcome = judgeAttempt(approach, offsetMs, favourableRoll, this.source.rules);
    const window = this.source.windowAt(clientTime);
    const counted = Math.abs(offsetMs) <= NO_TAP_LIMIT_MS;
    const provisional = approach.gear === 'gallop' && counted && Math.abs(offsetMs) <= window.cleanMs;

    this.shown = { fence: open.fence, attempt: open.attempt, offsetMs, outcome, provisional };
    return this.shown;
  }

  /** The server's 'takeoff' for this rider: closes the approach; compares with the hint of the same fence+attempt. */
  verdict(event: { fence: number; attempt: number; outcome: TakeoffOutcome; offsetMs: number | null }): Reconciliation {
    const shown = this.shown;
    this.open = null;
    this.shown = null;
    // The hard turn lasts until the fence it applies to is cleared, exactly as the server keeps recentHardTurn: a
    // refusal, run-out or fall leaves it in force for the next attempt of the same fence (audit K1 r1 #8).
    if (event.outcome.cleared) this.source.clearedFence();
    if (shown === null || shown.fence !== event.fence || shown.attempt !== event.attempt) {
      return { hint: null, verdict: event.outcome, agreed: null };
    }
    return { hint: shown, verdict: event.outcome, agreed: shown.outcome.kind === event.outcome.kind };
  }

  /** The hint shown right now (null once the server's verdict replaced it or no tap happened). */
  current(): Hint | null {
    return this.shown;
  }
}
