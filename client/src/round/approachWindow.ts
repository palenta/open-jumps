// The one source of the own horse's take-off window on the client (K1.1 step 6). The instant hint judges a tap
// with it and the take-off marker is drawn from it, so the two can never disagree about how wide the window is
// (K1 had the approach state only inside the hint).
//
// K1.1 code audit r2: the server is the source of the controls it judges with. The client no longer guesses which
// gear and line the judge reads from the state patches, a matching gear or a timeout; it keeps what the server told:
// - the server's controls log (the course runner's change log): every gear and line command the server applied comes
//   back as 'control-applied' { seq, at, requestedGear, line } — the rider's controls from the server moment `at` on —
//   and an 'approach-sync' says them as of its own moment when control is handed back;
// - the commands that went out and are not answered yet: each may be the server's from its send moment on. The server
//   applies the commands of ONE connection in order — after 0, 1, … or all of them; between connections no order is
//   known (K1.1 code audit r3: a lost tail of the old connection, the new one's commands): only an 'approach-sync'
//   says where the old connection ended;
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
  /**
   * The connection the server's word came on (the answered command's, a sync's, the current one for setGear /
   * setLine): its later commands reach the server after `at`, in order. Another connection's need not.
   */
  connection: number;
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

/** A state unanswered commands may have put the server in between their send moment and the server moment `until`. */
interface Possible {
  state: ControlState;
  /** Device time its commands went out. */
  from: number;
  /** Server ms from which the server's word rules it out. */
  until: number;
}

/** A state the server may reach on top of a base, and the device moment from which it may (its commands went out). */
interface Reach {
  state: ControlState;
  from: number;
}

function apply(state: ControlState, change: ControlChange): ControlState {
  return 'gear' in change ? { ...state, requestedGear: change.gear } : { ...state, line: change.line };
}

const isGear = (command: Pending): boolean => 'gear' in command.change;

/** One command of a connection's run: its connection and its place in that run. */
interface Pick {
  connection: number;
  index: number;
  command: Pending;
}

/**
 * Every controls state the server may hold on top of `base` once it has applied some of `commands` — `base` itself
 * first — each with the device moment from which it may (the latest send moment of the commands that make it). The
 * server applies the commands of one connection in the order they went out, and nothing orders two connections: their
 * commands interleave any way.
 * - The connection `ordered` reaches the server after the base, in order: a PREFIX of its commands is applied (none,
 *   some or all).
 * - Of every other connection where the server stands is unknown — some of its commands may be in the base already, its
 *   lost tail never comes — so ANY CONSECUTIVE RUN of its commands may be applied on top (a superset of its prefixes:
 *   the window can only be narrower for it).
 * The gear of a result is the last gear command applied (the base's when none is), its line the last line command
 * applied: a gear command and a line command are a result exactly when some prefix or run makes both the last of their
 * kind — always for two connections (each run ends at its own); within one connection when nothing of the earlier one's
 * kind comes between them; one of them alone, in the ordered connection, when nothing of the other kind comes before it.
 */
function reachable(base: ControlState, commands: readonly Pending[], ordered: number | null): Reach[] {
  const runs = new Map<number, Pending[]>();
  for (const command of commands) {
    const run = runs.get(command.connection);
    if (run === undefined) runs.set(command.connection, [command]);
    else run.push(command);
  }
  const gears: (Pick | null)[] = [null];
  const lines: (Pick | null)[] = [null];
  for (const [connection, run] of runs) {
    run.forEach((command, index) => (isGear(command) ? gears : lines).push({ connection, index, command }));
  }
  const runOf = (pick: Pick): readonly Pending[] => runs.get(pick.connection) ?? [];
  const possible = (gear: Pick | null, line: Pick | null): boolean => {
    if (gear !== null && line !== null) {
      if (gear.connection !== line.connection) return true;
      const [first, last] = gear.index < line.index ? [gear, line] : [line, gear];
      const kind = isGear(first.command);
      return runOf(first).slice(first.index + 1, last.index).every((command) => isGear(command) !== kind);
    }
    const only = gear ?? line;
    if (only === null || only.connection !== ordered) return true;
    const kind = isGear(only.command);
    return runOf(only).slice(0, only.index).every((command) => isGear(command) === kind);
  };
  const reaches: Reach[] = [];
  for (const gear of gears) {
    for (const line of lines) {
      if (!possible(gear, line)) continue;
      reaches.push({
        state: {
          requestedGear: gear !== null && 'gear' in gear.command.change ? gear.command.change.gear : base.requestedGear,
          line: line !== null && 'line' in line.command.change ? line.command.change.line : base.line,
        },
        from: Math.max(gear?.command.sentAt ?? Number.NEGATIVE_INFINITY, line?.command.sentAt ?? Number.NEGATIVE_INFINITY),
      });
    }
  }
  return reaches;
}

/** The commands that went out by device moment `at`: of each connection, its run up to the first one sent later. */
function sentBy(pending: readonly Pending[], at: number): Pending[] {
  const stopped = new Set<number>();
  const sent: Pending[] = [];
  for (const command of pending) {
    if (stopped.has(command.connection)) continue;
    if (at < command.sentAt) stopped.add(command.connection);
    else sent.push(command);
  }
  return sent;
}

const sameControls = (a: ControlState, b: ControlState): boolean => a.requestedGear === b.requestedGear && a.line === b.line;

/**
 * The window source of one class:
 * - sent(seq, change, at): a numbered command went out at device time `at` on the current connection; until the server
 *   answers it, it may be applied from `at` on.
 * - applied(answer): the server applied a command at server moment answer.at, the controls from then on being the
 *   answer's: a new entry of the log (of that command's connection), and its command is no longer pending. Commands
 *   sent before it on the SAME connection and still unanswered (an answer the client never got) were applied before
 *   answer.at or never: until then they stay possible. Commands of another connection are no part of its order (K1.1
 *   code audit r3): they stay pending.
 * - refused(seq): the server never applied that command: it is dropped, as if it had never gone out.
 * - connectionLost(): the connection the pending commands went out on is gone; what it carried was applied or lost, and
 *   nothing orders it against the next connection's commands.
 * - synced(controls): control handed back ('approach-sync'): the own autopilot is off and no wide turn is assumed (the
 *   sync names none: assuming none can only narrow the window); with the server's controls as of controls.at, every
 *   command of an earlier connection still pending was applied before that moment or never — possible until it, ruled
 *   out from it — and the log takes the server's controls from that moment on (an entry of the current connection).
 *   Commands of the current connection stay pending on top (the server hears them after the sync). Without controls
 *   nothing pending is ruled out — and nothing else orders two connections: without a sync the old connection's
 *   commands stay possible on top of every later state.
 * - setGear(gear, at) / setLine(line, at?): an exact entry of the log from device time `at` on, the other control as
 *   it was (unit tests and tools: the game learns the log from the server's answers), of the current connection.
 *   setLine without a moment sets the line of every entry of the log. A later entry is superseded.
 * - setHardTurn(on): the hard-turn flag from the own 'turn' verdict or the sync, kept until the fence it applies to is
 *   cleared (clearedFence), exactly as the server keeps recentHardTurn.
 * - setAutopilot(on) / wideTurn() / clearedFence(): the own autopilot as the server last told it; a wide turn's
 *   collected canter until the fence is cleared (the server's forcedCollected), which also spends the hard turn.
 * - stateAt(at): the ApproachState the shared judge gets for device moment `at`, the narrowest window of every state
 *   the server may be in then. Of the pending commands only those sent by `at` count (of each connection, its run up to
 *   the first one sent later). The states (see reachable):
 *   · the log's entry at toServer(at) — while the clock cannot translate `at`, every state of the log — and every
 *     still-possible state of a ruled command (from its send moment until the server's word); on top of each, any
 *     consecutive run of the pending commands of every connection other than the newest entry's (they may have reached
 *     the server at any time, in any order against the others);
 *   · if `at` is not before the log's newest moment, the newest entry with a prefix of its own connection's pending
 *     commands (they reach the server after it, in order), interleaved with such a run of every other connection's.
 *   The gear is gearInForce(requested gear, the frozen schoolmaster, the autopilot, a wide turn) — shared with the
 *   course runner; ties keep the log's state.
 * - windowAt(at): windowForAttempt(stateAt(at), rules) from shared — the window in force for the round's rules.
 * - configure(context): another height or other rules from now on (the server's frozen rules of the class).
 * Reading never changes anything. No timeout is proof of anything: a command stays possible until the server's word.
 */
export class ApproachWindow {
  private context: WindowContext;
  private readonly clock: WindowClock;
  private log: LogEntry[] = [{ at: Number.NEGATIVE_INFINITY, state: FIRST, connection: 0 }];
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
    const answered = this.pending[index];
    // The answer comes on the connection its command went out on: the current one when the command is unknown here.
    const connection = answered?.connection ?? this.connection;
    if (answered !== undefined) {
      const ours = (command: Pending): boolean => command.connection === connection;
      this.rule(this.pending.slice(0, index).filter(ours), answer.at);
      this.pending = this.pending.filter((command, place) => place > index || !ours(command));
    }
    this.enter(answer.at, { requestedGear: answer.requestedGear, line: answer.line }, connection);
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
    this.enter(controls.at, { requestedGear: controls.requestedGear, line: controls.line }, this.connection);
  }

  setGear(gear: Gear, at: number): void {
    this.supersede(this.serverMoment(at), { gear });
  }

  setLine(line: Line, at?: number): void {
    if (at === undefined) {
      this.log = this.log.map((entry) => ({ ...entry, state: { ...entry.state, line } }));
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
    const sent = sentBy(this.pending, at);
    const newest = this.newest();
    const others = sent.filter((command) => command.connection !== newest.connection);
    const bases: ControlState[] = server === null ? this.log.map((entry) => entry.state) : [this.logAt(server)];
    for (const entry of this.possible) {
      if (at >= entry.from && (server === null || server < entry.until)) bases.push(entry.state);
    }
    const states: ControlState[] = [];
    for (const base of bases) for (const reach of reachable(base, others, null)) states.push(reach.state);
    if (server === null || server >= newest.at) {
      for (const reach of reachable(newest.state, sent, newest.connection)) states.push(reach.state);
    }
    return states;
  }

  /**
   * Unanswered commands the server's word at server moment `until` settles: every state they may have put the server in
   * stays possible from the moment its commands went out until then, never after — on top of the log's newest state a
   * prefix of its own connection's commands interleaved with a run of every other's; on top of every other state of the
   * log and every state still possible, a run of the other connections' commands (they may have come at any time).
   */
  private rule(commands: Pending[], until: number): void {
    if (commands.length === 0) return;
    const newest = this.newest();
    const others = commands.filter((command) => command.connection !== newest.connection);
    const bases = [
      { state: newest.state, from: Number.NEGATIVE_INFINITY, commands, ordered: newest.connection as number | null },
      ...this.log.slice(0, -1).map((entry) => ({ state: entry.state, from: Number.NEGATIVE_INFINITY, commands: others, ordered: null })),
      ...this.possible.map((entry) => ({ state: entry.state, from: entry.from, commands: others, ordered: null })),
    ];
    for (const base of bases) {
      // The base itself is known already (an entry of the log, or possible): only what the commands add.
      for (const reach of reachable(base.state, base.commands, base.ordered).slice(1)) this.allow(reach.state, Math.max(base.from, reach.from), until);
    }
  }

  /**
   * A state possible from device moment `from` until server moment `until`. One record per state: a second span widens
   * the first (the earlier start, the later end) — a superset, so the window can only be narrower.
   */
  private allow(state: ControlState, from: number, until: number): void {
    const known = this.possible.find((entry) => sameControls(entry.state, state));
    if (known === undefined) {
      this.possible.push({ state, from, until });
      return;
    }
    known.from = Math.min(known.from, from);
    known.until = Math.max(known.until, until);
  }

  /** The server's controls from server moment `at` on: a log entry, in time order (an entry of the same moment after the ones already there). */
  private enter(at: number, state: ControlState, connection: number): void {
    let index = this.log.length;
    while (index > 0 && (this.log[index - 1]?.at ?? Number.NEGATIVE_INFINITY) > at) index -= 1;
    this.log.splice(index, 0, { at, state, connection });
    this.prune();
  }

  /** setGear / setLine: from `at` on the changed controls, whatever was set for a later moment superseded. */
  private supersede(at: number, change: ControlChange): void {
    const before = this.logAt(at);
    this.log = this.log.filter((entry) => entry.at < at);
    this.enter(at, apply(before, change), this.connection);
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

  /** The log's newest entry (the log is never empty: prune keeps one). */
  private newest(): LogEntry {
    return this.log[this.log.length - 1] ?? { at: Number.NEGATIVE_INFINITY, state: FIRST, connection: 0 };
  }

  /** A device moment on the server's clock; while the clock cannot translate it, the moment as given. */
  private serverMoment(at: number): number {
    return this.clock.toServer(at) ?? at;
  }
}
