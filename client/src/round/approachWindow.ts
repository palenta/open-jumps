// The one source of the own horse's take-off window on the client (K1.1 step 6). The instant hint judges a tap
// with it and the take-off marker is drawn from it, so the two can never disagree about how wide the window is
// (K1 had the approach state only inside the hint). What the client knows of its own approach — its best guess,
// never the truth: the gear in force at a moment (from the state patches and the rider's own pace presses, kept
// with their moments, because the judge reads the gear as of the action time and the marker as of the frame), the
// line from its own last line shift, a hard turn from its own last turn verdict, the class height; spooks and the
// lead-horse bonus are unknown here (false), so the window can only be narrower than the server's, never wider.
import { windowForAttempt, type ApproachState, type Gear, type HeightClass, type RoundRules, type TakeoffWindow } from '@open-jumps/shared';
import { NotImplementedError } from '../errors.js';

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
 * - configure(context): another height or other rules from now on (a new round of the same class).
 * Reading never changes anything.
 */
export class ApproachWindow {
  private context: WindowContext;

  constructor(context: WindowContext) {
    this.context = context;
  }

  configure(context: WindowContext): void {
    void context;
    throw new NotImplementedError('ApproachWindow.configure (K1.1 step 6)');
  }

  setGear(gear: Gear, at: number): void {
    void gear;
    void at;
    throw new NotImplementedError('ApproachWindow.setGear (K1.1 step 6)');
  }

  setLine(line: 'center' | 'angle'): void {
    void line;
    throw new NotImplementedError('ApproachWindow.setLine (K1.1 step 6)');
  }

  setHardTurn(on: boolean): void {
    void on;
    throw new NotImplementedError('ApproachWindow.setHardTurn (K1.1 step 6)');
  }

  /** The fence the hard turn applied to was cleared (a take-off verdict with cleared: true): the flag is spent. */
  clearedFence(): void {
    throw new NotImplementedError('ApproachWindow.clearedFence (K1.1 step 6)');
  }

  stateAt(at: number): ApproachState {
    void at;
    void this.context;
    throw new NotImplementedError('ApproachWindow.stateAt (K1.1 step 6)');
  }

  windowAt(at: number): TakeoffWindow {
    void at;
    throw new NotImplementedError('ApproachWindow.windowAt (K1.1 step 6)');
  }
}
