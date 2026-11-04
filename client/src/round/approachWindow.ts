// The one source of the own horse's take-off window on the client (K1.1 step 6). The instant hint judges a tap
// with it and the take-off marker is drawn from it, so the two can never disagree about how wide the window is
// (K1 had the approach state only inside the hint). What the client knows of its own approach — its best guess,
// never the truth: the gear in force at a moment (from the state patches and the rider's own pace presses, kept
// with their moments, because the judge reads the gear as of the action time and the marker as of the frame), the
// line from its own last line shift, a hard turn from its own last turn verdict, the class height; spooks and the
// lead-horse bonus are unknown here (false), so the window can only be narrower than the server's, never wider.
import { windowForAttempt, type ApproachState, type Gear, type HeightClass, type RoundRules, type TakeoffWindow } from '@open-jumps/shared';

export interface WindowContext {
  heightClass: HeightClass;
  /** Mode and the rider's own assist settings as frozen for this round. */
  rules: RoundRules;
}

/**
 * - setGear(gear, at): the gear in force from device time `at` on (the clock of every clientTime); gears set at
 *   earlier moments stay in force before `at`, so stateAt(at) of a moment before a change still reads the old gear.
 *   The gear before the first setGear is 'collected'.
 * - setLine(line) / setHardTurn(on): the line and the hard-turn flag in force from now on (the K1 hint's own rules: the
 *   line of the last shift that went out; the hard turn from the own 'turn' verdict, kept until the fence it applies
 *   to is cleared — clearedFence() — exactly as the server keeps recentHardTurn).
 * - stateAt(at): the ApproachState the shared judge gets for a moment `at`: { gear in force at `at`, heightClass,
 *   angleSharp: line === 'angle', recentHardTurn, spooked: false, leadHorseBonus: false }.
 * - windowAt(at): windowForAttempt(stateAt(at), rules) from shared — the window in force for the round's rules (a
 *   wider window only in training with the assist on).
 * - configure(context): another height or other rules from now on (a new round of the same class); rules: the
 *   round's rules in force, which the judge applies together with the window.
 * Reading never changes anything.
 */
export class ApproachWindow {
  private context: WindowContext;
  /** The gears set with their moments, in time order: the gear in force at a moment is the last one set at or before it. */
  private gears: { gear: Gear; at: number }[] = [];
  private line: 'center' | 'angle' = 'center';
  private hardTurn = false;

  constructor(context: WindowContext) {
    this.context = context;
  }

  configure(context: WindowContext): void {
    this.context = context;
  }

  /** The round's rules in force: what the judge applies together with the window. */
  get rules(): RoundRules {
    return this.context.rules;
  }

  setGear(gear: Gear, at: number): void {
    // From `at` on this gear is in force: whatever was set for a later moment is superseded.
    this.gears = this.gears.filter((entry) => entry.at < at);
    if (this.gearAt(at) !== gear) this.gears.push({ gear, at });
  }

  setLine(line: 'center' | 'angle'): void {
    this.line = line;
  }

  setHardTurn(on: boolean): void {
    this.hardTurn = on;
  }

  /** The fence the hard turn applied to was cleared (a take-off verdict with cleared: true): the flag is spent. */
  clearedFence(): void {
    this.hardTurn = false;
  }

  stateAt(at: number): ApproachState {
    return {
      gear: this.gearAt(at),
      heightClass: this.context.heightClass,
      angleSharp: this.line === 'angle',
      recentHardTurn: this.hardTurn,
      spooked: false,
      leadHorseBonus: false,
    };
  }

  windowAt(at: number): TakeoffWindow {
    return windowForAttempt(this.stateAt(at), this.context.rules);
  }

  /** The gear in force at `at`: the last one set at or before it, 'collected' before the first. */
  private gearAt(at: number): Gear {
    let gear: Gear = 'collected';
    for (const entry of this.gears) {
      if (entry.at > at) break;
      gear = entry.gear;
    }
    return gear;
  }
}
