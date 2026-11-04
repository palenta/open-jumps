// The one source of the own horse's take-off window on the client (K1.1 step 6). The instant hint judges a tap
// with it and the take-off marker is drawn from it, so the two can never disagree about how wide the window is
// (K1 had the approach state only inside the hint). What the client knows of its own approach — its best guess,
// never the truth: the gear in force at a moment (from the state patches and the rider's own pace presses, kept
// with their moments, because the judge reads the gear as of the action time and the marker as of the frame), the
// line from its own last line shift, a hard turn from its own last turn verdict, the class height; spooks and the
// lead-horse bonus are unknown here (false), so the window can only be narrower than the server's, never wider.
//
// A pace press reaches the judge at a moment the client never learns (the server dates a gear change at its own
// receive time), so from the moment it went out until a patch shows it, both the gear before it and the gear it
// asked for may be the judge's: the window is the narrower of them (K1.1 code audit r1, finding 1).
import { PACKET, windowForAttempt, type ApproachState, type Gear, type HeightClass, type RoundRules, type TakeoffWindow } from '@open-jumps/shared';

export interface WindowContext {
  heightClass: HeightClass;
  /** Mode and the rider's own assist settings as frozen for this round. */
  rules: RoundRules;
}

/** A pace press that went out: its gear may be the judge's from `at` until `until`. */
interface GearRequest {
  gear: Gear;
  /** Device time the message went out: the judge cannot have it before. */
  at: number;
  /** Device time of the patch that settled it; Infinity while it waits for one. */
  until: number;
  /** Sent before the rider took control back: the next patch settles it whatever it shows (controlRegained). */
  orphan: boolean;
}

/**
 * - setGear(gear, at): the gear a state patch shows, in force from device time `at` on (the clock of every
 *   clientTime); gears set at earlier moments stay in force before `at`, so stateAt(at) of a moment before a change
 *   still reads the old gear. The gear before the first setGear is 'collected'. The same patch settles the pace
 *   presses it confirms (requestGear, below).
 * - requestGear(gear, at): the rider's own pace press went out at device time `at` (K1.1 code audit r1, finding 1).
 *   The server dates the change at its receipt, which the client never learns, so from `at` on the requested gear
 *   and the gear before it are both the judge's possible gears: stateAt reads the one whose window is the NARROWER
 *   (ties: the patches' gear) — the marker and the hint never promise a wider window than the judge may use. A patch
 *   settles requests in the order they went out: the gear it shows settles every request up to the newest one that
 *   asked for that gear, when it is news — another gear than the patches showed before — or that request went out at
 *   least PACKET.maxAgeMs before the patch (a gear the patches already showed is otherwise a stale patch, or a cycle
 *   of presses back to it, and settles nothing). A settled request stays a possible gear up to the patch that settled
 *   it (a tap stamped in that span is still judged by the narrower); a stale patch, or one showing a gear nobody
 *   asked for (a forced collected canter), never undoes a request, and the band does not flicker back and forth.
 * - Forced collected wins over every gear, set or requested, exactly as the server's approach state: the round's
 *   frozen schoolmaster assist (rules), the own autopilot as the server last told (setAutopilot), and a wide turn
 *   from its verdict until the fence is cleared (wideTurn / clearedFence, the server's forcedCollected). The requests
 *   stay and count again once the forcing ends.
 * - setLine(line) / setHardTurn(on): the line and the hard-turn flag in force from now on (the K1 hint's own rules: the
 *   line of the last shift that went out; the hard turn from the own 'turn' verdict, kept until the fence it applies
 *   to is cleared — clearedFence() — exactly as the server keeps recentHardTurn).
 * - controlRegained(): the rider took control back ('approach-sync'): the requests that went out before it were
 *   applied or lost with the old connection, so the next patch settles them whatever it shows; the sync names no wide
 *   turn, so none is assumed any more (the patches still show the collected canter while the server keeps it).
 * - stateAt(at): the ApproachState the shared judge gets for a moment `at`: { gear (above), heightClass, angleSharp:
 *   line === 'angle', recentHardTurn, spooked: false, leadHorseBonus: false }.
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
  /** The pace presses that went out, in the order they did. */
  private requests: GearRequest[] = [];
  private line: 'center' | 'angle' = 'center';
  private hardTurn = false;
  private autopilot = false;
  private wide = false;

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
    this.settle(gear, at);
    // From `at` on this gear is in force: whatever was set for a later moment is superseded.
    this.gears = this.gears.filter((entry) => entry.at < at);
    if (this.gearAt(at) !== gear) this.gears.push({ gear, at });
  }

  requestGear(gear: Gear, at: number): void {
    this.requests.push({ gear, at, until: Number.POSITIVE_INFINITY, orphan: false });
  }

  setLine(line: 'center' | 'angle'): void {
    this.line = line;
  }

  setHardTurn(on: boolean): void {
    this.hardTurn = on;
  }

  /** The own autopilot as the server last told it (its 'autopilot' event or the state): collected while it is on. */
  setAutopilot(on: boolean): void {
    this.autopilot = on;
  }

  /** The own turn verdict was 'wide': the server collects the canter until the fence is cleared. */
  wideTurn(): void {
    this.wide = true;
  }

  /** The fence the hard turn applied to was cleared (a take-off verdict with cleared: true): the flag is spent, and so is a wide turn's collected canter. */
  clearedFence(): void {
    this.hardTurn = false;
    this.wide = false;
  }

  controlRegained(): void {
    this.wide = false;
    for (const request of this.requests) {
      if (request.until === Number.POSITIVE_INFINITY) request.orphan = true;
    }
  }

  stateAt(at: number): ApproachState {
    const rules = this.context.rules;
    let state: ApproachState = {
      gear: this.forcedCollected() ? 'collected' : this.gearAt(at),
      heightClass: this.context.heightClass,
      angleSharp: this.line === 'angle',
      recentHardTurn: this.hardTurn,
      spooked: false,
      leadHorseBonus: false,
    };
    if (this.forcedCollected()) return state;
    // Every gear the judge may use at `at`: the patches' gear, then each request in its span — the narrowest wins.
    let narrowest = windowForAttempt(state, rules).cleanMs;
    for (const request of this.requests) {
      if (at < request.at || at >= request.until) continue;
      const candidate: ApproachState = { ...state, gear: request.gear };
      const cleanMs = windowForAttempt(candidate, rules).cleanMs;
      if (cleanMs < narrowest) {
        state = candidate;
        narrowest = cleanMs;
      }
    }
    return state;
  }

  windowAt(at: number): TakeoffWindow {
    return windowForAttempt(this.stateAt(at), this.context.rules);
  }

  /** The schoolmaster, the autopilot or a wide turn collects the canter whatever the gear (the server's approach state). */
  private forcedCollected(): boolean {
    return this.context.rules.assists.schoolmaster || this.autopilot || this.wide;
  }

  /** A patch showing `gear` arrived at `at`: the requests it confirms are settled there (see the contract above). */
  private settle(gear: Gear, at: number): void {
    const waiting: GearRequest[] = [];
    for (const request of this.requests) {
      if (request.until !== Number.POSITIVE_INFINITY) continue;
      if (request.orphan) request.until = at;
      else waiting.push(request);
    }
    let newest = -1;
    waiting.forEach((request, index) => {
      if (request.gear === gear) newest = index;
    });
    const confirmed = waiting[newest];
    if (confirmed === undefined) return;
    const news = gear !== this.gearAt(at);
    if (!news && at - confirmed.at < PACKET.maxAgeMs) return;
    for (const request of waiting.slice(0, newest + 1)) request.until = at;
  }

  /** The gear the patches showed in force at `at`: the last one set at or before it, 'collected' before the first. */
  private gearAt(at: number): Gear {
    let gear: Gear = 'collected';
    for (const entry of this.gears) {
      if (entry.at > at) break;
      gear = entry.gear;
    }
    return gear;
  }
}
