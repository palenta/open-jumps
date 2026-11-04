// The one source of the own horse's take-off window on the client (K1.1 step 6). The instant hint judges a tap
// with it and the take-off marker is drawn from it, so the two can never disagree about how wide the window is
// (K1 had the approach state only inside the hint).
//
// K1.1 code audit r2: the server is the source of the controls it judges with. The client no longer guesses which
// gear and line the judge reads from the state patches, a matching gear or a timeout; it keeps what the server told:
// - the server's controls log (the course runner's change log): every gear and line command the server applied comes
//   back as 'control-applied' { seq, at, requestedGear, line } — the rider's controls from the server moment `at` on —
//   and an 'approach-sync' says them as of its own moment when control is handed back;
// - the commands that went out and are not answered yet: each may be the server's from its send moment on, and the
//   server applies them in order — after 0, 1, … or all of them;
// - the rules the server froze for the round ('class-rules': configure), never the lobby's;
// - what forces the collected canter, by the shared rule gearInForce (the course runner's own): the frozen schoolmaster,
//   the own autopilot as the server last told, a wide turn until the fence is cleared.
// The window at a moment is the NARROWEST over every state the server may be in then, so the band and the hint never
// promise a wider window than the judge uses. Spooks and the lead-horse bonus are unknown here (false): the window can
// only be narrower than the server's, never wider.
import { gearInForce, windowForAttempt, type ApproachState, type Gear, type HeightClass, type RoundRules, type TakeoffWindow } from '@open-jumps/shared';
import type { ControlState, Line } from '../net/types.js';

export interface WindowContext {
  heightClass: HeightClass;
  /** Mode and the rider's own assist settings as frozen for this round. */
  rules: RoundRules;
}

/** How the window reads a device moment on the server's game clock: the clock's own translation (ClientClock.toServer). */
export interface WindowClock {
  toServer(clientTime: number): number | null;
}

/** One command's change of the controls: a gear or a line, as the rider sent it. */
export type ControlChange = { gear: Gear } | { line: Line };

/** The server's answer to a command it applied ('control-applied'): its controls from the server moment `at` on. */
export interface ControlApplied extends ControlState {
  /** The command's seq; null for a command sent without one. */
  seq: number | null;
  /** Server ms: the receive time the command is applied at. */
  at: number;
}

/** The server's controls as of a moment ('approach-sync'): `at` in server ms. */
export type ControlsAt = ControlState & { at: number };

/** Without a clock the device moments are the server's (a unit test, the server's own clock). */
const SAME_CLOCK: WindowClock = { toServer: (clientTime) => clientTime };

/** How long the log keeps entries that ended before its newest moment: the judge looks back a second (RUN.historyMs). */
const KEEP_MS = 5_000;

/** The controls of a heat before any command: the course runner's first entry. */
const FIRST: ControlState = { requestedGear: 'collected', line: 'center' };

/** An entry of the server's controls log: the controls in force from `at` (server ms) until the next entry. */
interface LogEntry {
  at: number;
  state: ControlState;
}

/** A command that went out and is not answered yet. */
interface Pending {
  seq: number | null;
  change: ControlChange;
  /** Device time it went out: the server cannot have it before. */
  sentAt: number;
  /** The connection it went out on (connectionLost counts them). */
  connection: number;
}

/** A state an unanswered command may have put the server in between its send moment and the server moment `until`. */
interface Possible {
  state: ControlState;
  /** Device time the command went out. */
  from: number;
  /** Server ms from which the server's word rules it out. */
  until: number;
}

function apply(state: ControlState, change: ControlChange): ControlState {
  return 'gear' in change ? { ...state, requestedGear: change.gear } : { ...state, line: change.line };
}

/**
 * The window source of one class:
 * - sent(seq, change, at): a numbered command went out at device time `at` on the current connection; until the server
 *   answers it, it may be applied from `at` on.
 * - applied(answer): the server applied a command at server moment answer.at, the controls from then on being the
 *   answer's: a new entry of the log, and its command is no longer pending. Commands sent before it and still
 *   unanswered (an answer the client never got) were applied before answer.at or never: until then they stay possible.
 * - refused(seq): the server never applied that command: it is dropped, as if it had never gone out.
 * - connectionLost(): the connection the pending commands went out on is gone; what it carried was applied or lost.
 * - synced(controls): control handed back ('approach-sync'): the own autopilot is off and no wide turn is assumed (the
 *   sync names none: assuming none can only narrow the window); with the server's controls as of controls.at, every
 *   command of an earlier connection still pending was applied before that moment or never — possible until it, ruled
 *   out from it — and the log takes the server's controls from that moment on. Commands of the current connection stay
 *   pending on top (the server hears them after the sync). Without controls nothing pending is ruled out.
 * - setGear(gear, at) / setLine(line, at?): an exact entry of the log from device time `at` on, the other control as
 *   it was (unit tests and tools: the game learns the log from the server's answers). setLine without a moment sets the
 *   line of every entry of the log. A later entry is superseded.
 * - setHardTurn(on): the hard-turn flag from the own 'turn' verdict or the sync, kept until the fence it applies to is
 *   cleared (clearedFence), exactly as the server keeps recentHardTurn.
 * - setAutopilot(on) / wideTurn() / clearedFence(): the own autopilot as the server last told it; a wide turn's
 *   collected canter until the fence is cleared (the server's forcedCollected), which also spends the hard turn.
 * - stateAt(at): the ApproachState the shared judge gets for device moment `at`, the narrowest window of every state
 *   the server may be in then: the log's entry at toServer(at); if `at` is not before the log's newest moment, also
 *   the state after each prefix of the pending commands sent by `at` (the server applies them in order); every
 *   still-possible state of an unanswered command (from its send moment until the server's word). While the clock
 *   cannot translate `at`, every state of the log counts. The gear is gearInForce(requested gear, the frozen
 *   schoolmaster, the autopilot, a wide turn) — shared with the course runner; ties keep the log's state.
 * - windowAt(at): windowForAttempt(stateAt(at), rules) from shared — the window in force for the round's rules.
 * - configure(context): another height or other rules from now on (the server's frozen rules of the class).
 * Reading never changes anything. No timeout is proof of anything: a command stays possible until the server's word.
 */
export class ApproachWindow {
  private context: WindowContext;
  private readonly clock: WindowClock;
  private log: LogEntry[] = [{ at: Number.NEGATIVE_INFINITY, state: FIRST }];
  private pending: Pending[] = [];
  private possible: Possible[] = [];
  private connection = 0;
  private hardTurn = false;
  private autopilot = false;
  private wide = false;

  constructor(context: WindowContext, clock: WindowClock = SAME_CLOCK) {
    this.context = context;
    this.clock = clock;
  }

  configure(context: WindowContext): void {
    this.context = context;
  }

  /** The round's rules in force: what the judge applies together with the window. */
  get rules(): RoundRules {
    return this.context.rules;
  }

  sent(seq: number | null, change: ControlChange, at: number): void {
    this.pending.push({ seq, change, sentAt: at, connection: this.connection });
  }

  applied(answer: ControlApplied): void {
    const index = answer.seq === null ? -1 : this.pending.findIndex((command) => command.seq === answer.seq);
    if (index >= 0) {
      this.rule(this.pending.slice(0, index), answer.at);
      this.pending.splice(0, index + 1);
    }
    this.enter(answer.at, { requestedGear: answer.requestedGear, line: answer.line });
  }

  refused(seq: number): void {
    this.pending = this.pending.filter((command) => command.seq !== seq);
  }

  connectionLost(): void {
    this.connection += 1;
  }

  synced(controls: ControlsAt | null): void {
    this.autopilot = false;
    this.wide = false;
    if (controls === null) return;
    const earlier = this.pending.filter((command) => command.connection < this.connection);
    this.rule(earlier, controls.at);
    this.pending = this.pending.filter((command) => command.connection >= this.connection);
    this.enter(controls.at, { requestedGear: controls.requestedGear, line: controls.line });
  }

  setGear(gear: Gear, at: number): void {
    this.supersede(this.serverMoment(at), { gear });
  }

  setLine(line: Line, at?: number): void {
    if (at === undefined) {
      this.log = this.log.map((entry) => ({ at: entry.at, state: { ...entry.state, line } }));
      return;
    }
    this.supersede(this.serverMoment(at), { line });
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

  stateAt(at: number): ApproachState {
    const rules = this.context.rules;
    const forcing = { schoolmaster: rules.assists.schoolmaster, autopilot: this.autopilot, wideTurn: this.wide };
    let narrowest: ApproachState | null = null;
    let narrowestMs = Number.POSITIVE_INFINITY;
    for (const controls of this.possibleAt(at)) {
      const state: ApproachState = {
        gear: gearInForce(controls.requestedGear, forcing),
        heightClass: this.context.heightClass,
        angleSharp: controls.line === 'angle',
        recentHardTurn: this.hardTurn,
        spooked: false,
        leadHorseBonus: false,
      };
      const cleanMs = windowForAttempt(state, rules).cleanMs;
      if (narrowest === null || cleanMs < narrowestMs) {
        narrowest = state;
        narrowestMs = cleanMs;
      }
    }
    // possibleAt always yields the log's own state first.
    return narrowest as ApproachState;
  }

  windowAt(at: number): TakeoffWindow {
    return windowForAttempt(this.stateAt(at), this.context.rules);
  }

  /** Every controls state the server may hold at device moment `at`, the log's own first (see the contract). */
  private possibleAt(at: number): ControlState[] {
    const server = this.clock.toServer(at);
    const states: ControlState[] = server === null ? this.log.map((entry) => entry.state) : [this.logAt(server)];
    for (const entry of this.possible) {
      if (at >= entry.from && (server === null || server < entry.until)) states.push(entry.state);
    }
    const newest = this.log[this.log.length - 1] ?? { at: Number.NEGATIVE_INFINITY, state: FIRST };
    if (server === null || server >= newest.at) {
      let state = newest.state;
      for (const command of this.pending) {
        if (at < command.sentAt) break;
        state = apply(state, command.change);
        states.push(state);
      }
    }
    return states;
  }

  /**
   * Unanswered commands the server's word at server moment `until` settles: each prefix of them may have been applied
   * from its send moment until then (on top of the log's newest state), never after.
   */
  private rule(commands: Pending[], until: number): void {
    let state = this.newestState();
    for (const command of commands) {
      state = apply(state, command.change);
      this.possible.push({ state, from: command.sentAt, until });
    }
  }

  /** The server's controls from server moment `at` on: a log entry, in time order (an entry of the same moment after the ones already there). */
  private enter(at: number, state: ControlState): void {
    let index = this.log.length;
    while (index > 0 && (this.log[index - 1]?.at ?? Number.NEGATIVE_INFINITY) > at) index -= 1;
    this.log.splice(index, 0, { at, state });
    this.prune();
  }

  /** setGear / setLine: from `at` on the changed controls, whatever was set for a later moment superseded. */
  private supersede(at: number, change: ControlChange): void {
    const before = this.logAt(at);
    this.log = this.log.filter((entry) => entry.at < at);
    this.enter(at, apply(before, change));
  }

  /** Entries and possible states long ended before the newest moment of the log are dropped (one entry before it stays). */
  private prune(): void {
    const horizon = (this.log[this.log.length - 1]?.at ?? Number.NEGATIVE_INFINITY) - KEEP_MS;
    while (this.log.length > 1 && (this.log[1]?.at ?? Number.POSITIVE_INFINITY) < horizon) this.log.shift();
    this.possible = this.possible.filter((entry) => entry.until >= horizon);
  }

  /** The log's controls at server moment `at`: the last entry at or before it. */
  private logAt(at: number): ControlState {
    let state = this.log[0]?.state ?? FIRST;
    for (const entry of this.log) {
      if (entry.at > at) break;
      state = entry.state;
    }
    return state;
  }

  private newestState(): ControlState {
    return this.log[this.log.length - 1]?.state ?? FIRST;
  }

  /** A device moment on the server's clock; while the clock cannot translate it, the moment as given. */
  private serverMoment(at: number): number {
    return this.clock.toServer(at) ?? at;
  }
}
