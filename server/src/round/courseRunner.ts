// One horse on the course (plan 1.7, 1.8, 2.3): a one-dimensional run at 20 Hz with fixed take-off moments,
// a change log of gear and line for judging "as of the action time", turns with timing, refusals and falls
// with restarts, the finish and the time limit, schoolmaster auto-take-off, and the autopilot while the
// rider's connection is gone. Pure: driven by tick(now) and commands; no I/O, no wall clock.
import {
  AttemptJudge,
  RiderRound,
  courseTimes,
  createRng,
  decisionDeadline,
  gearSpeedMPerS,
  judgeAttempt,
  judgeTurn,
  PACKET,
  schoolmasterReferenceWindow,
  schoolmasterTapOffset,
  TURN,
  type ApproachState,
  type AttemptDecision,
  type CourseSpec,
  type FenceSpec,
  type Gear,
  type HeightClass,
  type PacketVerdict,
  type RoundRules,
  type TakeoffOutcome,
  type TapPacket,
  type TurnChoice,
  type TurnOutcome,
  type TurnSpec,
} from '@open-jumps/shared';

export const RUN = {
  /** Simulation step (20 Hz). */
  tickMs: 50,
  /** Entering this distance before a take-off point fixes t0 and freezes the speed until the decision. */
  approachZoneM: 12,
  /** Where the horse lands relative to the take-off point. */
  landingAdvanceM: 3,
  flightMs: 600,
  /** The horse stops this far before the take-off point after a refusal, run-out or fall, and restarts from there. */
  restartBackM: 2,
  refusalDelayMs: 3000,
  fallDelayMs: 8000,
  /** Entering this distance before a turn point fixes the turn moment. */
  turnZoneM: 10,
  /** Autopilot drives for at most this long after a disconnection, then the horse waits before the next fence. */
  autopilotMaxMs: 10_000,
  /** How long a change log is kept for rewinds (plan 2.3: the last second). */
  historyMs: 1000,
  /** Another rider's clear within this time before t0 counts as a lead horse (plan 1.11а). */
  leadHorseMs: 2000,
} as const;

export type RunnerPhase =
  | 'running' // between fences, moving at the effective gear speed
  | 'approach' // inside the approach zone: t0 fixed, speed frozen, judge open
  | 'flight' // over the fence
  | 'stopped' // standing after a refusal, fall, missed or wrong turn; resumes at stoppedUntil
  | 'waiting' // disconnected past the autopilot budget: standing before the next fence until the rider returns
  | 'done'; // finished or eliminated

export type Line = 'center' | 'angle';

export interface RunnerSnapshot {
  positionM: number;
  /** The gear in force (schoolmaster/autopilot may collect regardless of the request). */
  gear: Gear;
  requestedGear: Gear;
  line: Line;
  nextFence: number;
  attempt: number;
  phase: RunnerPhase;
  /** The fixed take-off moment of the current approach, else null. */
  t0: number | null;
  autopilot: boolean;
  /** True once any autopilot segment happened in this round ("con autopiloto"). */
  usedAutopilot: boolean;
  recentHardTurn: boolean;
}

export type RunnerEvent =
  /**
   * The approach zone entered: t0 fixed. speedMps (K1.1 step 5) is the approach speed frozen at that moment
   * (Approach.speed, m/s — the speed t0 was computed with, also for an approach collected by a wide turn, schoolmaster
   * or the autopilot), so a client can place the take-off marker and its own horse without a second model of the run.
   */
  | { type: 'approach'; fence: number; attempt: number; t0: number; speedMps: number }
  | { type: 'takeoff'; fence: number; attempt: number; decidedAt: number; offsetMs: number | null; outcome: TakeoffOutcome; approach: ApproachState }
  /** Entering the turn zone: the moment the turn must be taken (clients and tests know when to press). */
  | { type: 'turn-ahead'; distanceM: number; at: number }
  | { type: 'turn'; distanceM: number; decidedAt: number; outcome: TurnOutcome }
  | { type: 'restart'; fence: number; attempt: number; at: number }
  | { type: 'finish'; at: number; elapsedMs: number }
  | { type: 'eliminated'; at: number; reason: 'refusals' | 'time' | 'disconnected' }
  | { type: 'autopilot'; at: number; on: boolean }
  | { type: 'waiting'; at: number };

export interface RunnerDeps {
  riderId: string;
  course: CourseSpec;
  heightClass: HeightClass;
  /** Mode and the assist settings frozen at the start of the round. */
  rules: RoundRules;
  seed: number | string;
  /** Server time of the start signal; the horse starts moving at the first tick after it. */
  startAt: number;
  /** Whether another rider cleared `fence` within RUN.leadHorseMs before `t0` (the engine knows the others). */
  leadHorse?: (fence: number, t0: number) => boolean;
}

export type TapResult =
  | { kind: 'judged'; verdict: PacketVerdict; decision: AttemptDecision }
  | { kind: 'ignored'; reason: 'no-approach' | 'schoolmaster' | 'autopilot' | 'done' };

export type TurnPacket = { choice: TurnChoice; actionTime: number; receiveTime: number };

export type TurnResult =
  | { kind: 'judged'; outcome: TurnOutcome }
  | { kind: 'ignored'; reason: 'no-turn' | 'too-old' | 'future' | 'duplicate' | 'autopilot' | 'done' };

/** A gear or line change at a moment (the change log used for rewinds). */
interface ControlEntry {
  at: number;
  gear: Gear;
  line: Line;
}

/** The open approach of the current attempt. */
interface Approach {
  fence: FenceSpec;
  attempt: number;
  openedAt: number;
  t0: number;
  /** Speed frozen at zone entry, m/s. */
  speed: number;
  recentHardTurn: boolean;
  judge: AttemptJudge;
  roll: () => number;
  /** Automatic take-off moment (schoolmaster / autopilot); fires only if the assist is still in force then. */
  autoTapAt: number | null;
  applied: boolean;
}

/** The open turn point. */
interface OpenTurn {
  spec: TurnSpec;
  moment: number;
  decision: { outcome: TurnOutcome; decidedAt: number } | null;
}

const MS = 1000;

/**
 * Timing model (all times in server ms):
 * - Running: position += speed(gear) × dt per tick. Entering the approach zone (position ≥ fence − 12 m) fixes
 *   t0 = now + (fence − position) / speed and opens the attempt judge; the speed stays frozen until the decision,
 *   and the horse is at fence − speed × (t0 − now) from the zone entry to t0 (also for the rest of the tick that
 *   entered the zone).
 * - Judging: taps go to the judge in receive order (plan 2.3); the first accepted tap decides at once, "no tap"
 *   is fixed at t0 + 700. The approach state used is the state AT THE ACTION TIME (gear/line change log), with
 *   recentHardTurn from the last turn and the lead-horse bonus from the engine; "no tap" uses the state at t0.
 * - At t0 the horse is at the take-off point and stays there until it lands or stops. Cleared outcomes land at
 *   fence + 3 m at t0 + 600 ms, or at the decision moment when that comes later (a late tap or "no tap" costs
 *   the wait); then next fence, attempt 1. Refusal / run-out / fall → the horse stands at fence − 2 m from the
 *   decision for 3 s / 8 s, then re-approaches in collected canter (new attempt, t0 = resume + 2 m / 5 m/s).
 *   The third disobedience eliminates. recentHardTurn lasts until the fence it applies to is cleared.
 * - Turns: entering the turn zone (10 m) fixes the turn moment and emits 'turn-ahead'; the first press whose packet is admissible
 *   (age ≤ 300 ms, not from the future) decides at receipt; no press by moment + 900 ms + 300 ms margin is
 *   'missed'. While a turn is undecided the horse keeps running straight but no approach zone opens; 'missed'
 *   and 'wrong' put the horse back at the turn point and stop it for 4 s / 6 s; 'wide' drops the gear to
 *   collected (the requested gear is kept for later); wide/missed/wrong set recentHardTurn for the next fence.
 * - Finish: crossing lengthM after the last fence calls RiderRound.finish with the exact crossing time; reaching
 *   the time limit while on course eliminates ('time'), or 'disconnected' when waiting for a rider who never came back.
 * - Falls: a fall (gallop + miss) restarts the fence like a refusal (8 s) but is NOT a disobedience: after three
 *   falls the rider is still riding at attempt 4 and a manual tap for attempt 4 is judged normally.
 * - Schoolmaster (frozen assist): collected canter in every approach and an automatic tap at
 *   t0 + schoolmasterTapOffset(reference window); the rider's own taps are ignored.
 * - Autopilot: from disconnected(now) the horse behaves like schoolmaster (turns taken tight) for at most 10 s;
 *   then it stops at the next approach-zone entry ('waiting') until reconnected(now). usedAutopilot stays true.
 *   Taking over an open approach whose planned auto-tap moment has passed, it takes off at the disconnection
 *   moment (judged by that offset); the synthetic packet is never dated before the last tick.
 *
 * Inside one tick the scheduled moments (stop ends, landing, decisions, auto taps, deadlines, the limit) are
 * handled in time order, with the motion between them, so events carry exact times whatever the tick length.
 */
export class CourseRunner {
  private readonly deps: RunnerDeps;
  private readonly riderRound: RiderRound;
  private readonly limitMs: number;
  private readonly allowedSec: number;

  private pos = 0;
  private phase: RunnerPhase = 'running';
  private lastTick: number;
  private finishedAt: number | null = null;

  private requestedGear: Gear = 'collected';
  private line: Line = 'center';
  private readonly controls: ControlEntry[];

  private fenceIdx = 0;
  private approach: Approach | null = null;
  /** The judge of the latest attempt, kept after its decision so late packets get a named verdict. */
  private lastJudge: AttemptJudge | null = null;
  private flightUntil: number | null = null;
  private stoppedUntil: number | null = null;
  /** After a refusal/fall stop the approach reopens on resume; after a turn stop the horse just runs on. */
  private restartOnResume = false;
  private recentHardTurn = false;
  /** A wide turn collects the canter until the next fence is cleared. */
  private forcedCollected = false;

  private turnIdx = 0;
  private openTurn: OpenTurn | null = null;

  private autopilot = false;
  private usedAutopilot = false;
  private autopilotUntil = 0;

  private pending: RunnerEvent[] = [];

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.riderRound = new RiderRound(deps.course.fences.length);
    const times = courseTimes(deps.course);
    this.allowedSec = times.allowedSec;
    this.limitMs = times.limitSec * MS;
    this.lastTick = deps.startAt;
    this.controls = [{ at: Number.NEGATIVE_INFINITY, gear: 'collected', line: 'center' }];
  }

  get riderId(): string {
    return this.deps.riderId;
  }

  /** Faults, status and the fault log live in the shared RiderRound (read-only for callers). */
  get round(): RiderRound {
    return this.riderRound;
  }

  snapshot(): RunnerSnapshot {
    return {
      positionM: this.pos,
      gear: this.gearInForceAt(this.lastTick),
      requestedGear: this.requestedGear,
      line: this.line,
      nextFence: this.fenceIdx + 1,
      attempt: this.riderRound.currentAttempt,
      phase: this.phase,
      t0: this.approach?.t0 ?? null,
      autopilot: this.autopilot,
      usedAutopilot: this.usedAutopilot,
      recentHardTurn: this.recentHardTurn,
    };
  }

  /**
   * The approach open right now whose take-off is still undecided — what a client taking control back must arm its
   * tap for (audit K1 r2 #1) — or null: between fences, in flight (the decision is taken), stopped, waiting or done.
   * speedMps is its frozen speed, as in its 'approach' event (K1.1 step 5).
   */
  undecidedApproach(): { fence: number; attempt: number; t0: number; speedMps: number } | null {
    const approach = this.approach;
    if (!approach || approach.applied || approach.judge.decision.decided) return null;
    return { fence: approach.fence.number, attempt: approach.attempt, t0: approach.t0, speedMps: approach.speed };
  }

  /** The approach state as of `time` (change log rewind), or null when no approach is open at that time. */
  approachAt(time: number): ApproachState | null {
    const approach = this.approach;
    if (!approach || approach.applied || time < approach.openedAt) return null;
    return this.approachState(approach, time);
  }

  /** Time on course so far (0 before the start; frozen at the finish or elimination). */
  elapsedMs(now: number): number {
    if (this.finishedAt !== null) return this.finishedAt - this.deps.startAt;
    return Math.max(0, now - this.deps.startAt);
  }

  setGear(gear: Gear, at: number): void {
    this.requestedGear = gear;
    this.controls.push({ at, gear, line: this.line });
    this.pruneControls(at);
  }

  setLine(line: Line, at: number): void {
    this.line = line;
    this.controls.push({ at, gear: this.requestedGear, line });
    this.pruneControls(at);
  }

  /** A tap packet for the current approach (fence/attempt are checked by the judge). */
  tap(packet: TapPacket): TapResult {
    if (this.phase === 'done') return { kind: 'ignored', reason: 'done' };
    if (this.autopilot) return { kind: 'ignored', reason: 'autopilot' };
    if (this.deps.rules.assists.schoolmaster) return { kind: 'ignored', reason: 'schoolmaster' };
    // After the decision the judge of the last attempt still answers (duplicate / after-deadline / wrong-attempt).
    const judge = this.approach && !this.approach.applied ? this.approach.judge : this.lastJudge;
    if (!judge) return { kind: 'ignored', reason: 'no-approach' };
    const result = judge.submit(packet);
    return { kind: 'judged', verdict: result.verdict, decision: result.decision };
  }

  /** A turn press for the current turn point. */
  turn(packet: TurnPacket): TurnResult {
    if (this.phase === 'done') return { kind: 'ignored', reason: 'done' };
    if (this.autopilot) return { kind: 'ignored', reason: 'autopilot' };
    const turn = this.openTurn;
    if (!turn) return { kind: 'ignored', reason: 'no-turn' };
    if (turn.decision) return { kind: 'ignored', reason: 'duplicate' };
    if (packet.receiveTime - packet.actionTime > PACKET.maxAgeMs) return { kind: 'ignored', reason: 'too-old' };
    if (packet.actionTime - packet.receiveTime > PACKET.maxFutureMs) return { kind: 'ignored', reason: 'future' };
    const outcome = judgeTurn(turn.spec.direction, packet.choice, packet.actionTime - turn.moment, this.gearInForceAt(packet.actionTime));
    turn.decision = { outcome, decidedAt: packet.receiveTime };
    return { kind: 'judged', outcome };
  }

  disconnected(now: number): void {
    if (this.phase === 'done') return;
    this.autopilot = true;
    this.usedAutopilot = true;
    this.autopilotUntil = now + RUN.autopilotMaxMs;
    this.pending.push({ type: 'autopilot', at: now, on: true });
    // Taking over an open, undecided approach whose planned auto-tap moment has already passed, the autopilot
    // takes off now instead (so that moment is the next transition) — never at a moment the simulation has left
    // behind: the auto tap is a scheduled transition of the time-ordered loop, which only takes moments strictly
    // after the last tick (a packet dated before it would be out of order for the judge, too). A `now` in the
    // same millisecond as the last tick counts as 1 ms after it, the first moment not yet simulated.
    const approach = this.approach;
    if (approach && !approach.applied && !approach.judge.decision.decided && approach.autoTapAt !== null) {
      const soonest = Math.max(now, this.lastTick + 1);
      if (approach.autoTapAt < soonest) approach.autoTapAt = soonest;
    }
  }

  reconnected(now: number): void {
    if (this.phase === 'done' || !this.autopilot) return;
    this.autopilot = false;
    this.pending.push({ type: 'autopilot', at: now, on: false });
    if (this.phase === 'waiting') {
      this.phase = 'running';
      this.openApproach(now, this.pending);
    }
  }

  /** The rider left for good: eliminated 'disconnected' at once (if still riding). */
  withdraw(now: number): void {
    if (this.phase === 'done') return;
    this.riderRound.withdraw('disconnected');
    this.finish(now);
  }

  /**
   * Advance to `now` (must be ≥ the previous tick; the engine calls it every 50 ms and submits every packet
   * with receiveTime ≤ now before it). Returns the events produced by this step, in order.
   */
  tick(now: number): RunnerEvent[] {
    if (now < this.lastTick) throw new Error(`tick goes backwards: ${now} < ${this.lastTick}`);
    const events = this.pending;
    this.pending = [];
    if (this.phase === 'done') {
      this.lastTick = now;
      return events;
    }

    let time = this.lastTick;
    // A packet stamped with the last tick's own millisecond and submitted after that tick (the judge accepts it
    // with its true times) decides AT the last tick — a moment the time-ordered loop below never revisits, since
    // it only takes moments strictly after `time`. Such a decision is applied first, before time moves on, and
    // keeps its true time in the event.
    if (this.hasOverdueDecision()) this.transitionsAt(time, events);
    while (!this.isDone()) {
      const next = this.nextTransition(time, now);
      if (next === null) {
        this.move(time, now, events);
        break;
      }
      this.move(time, next, events);
      // The motion itself can end the round (the line crossed: finished, or eliminated by time when the crossing
      // is at the limit). A done rider takes no further transition — not even the limit at that same moment —
      // so the terminal event (finish or eliminated) is emitted exactly once.
      if (this.isDone()) break;
      time = next;
      this.transitionsAt(time, events);
    }
    this.approach?.judge.tick(now);
    this.lastTick = now;
    return events;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Time-ordered transitions

  /** An attempt or turn decision dated at (or, defensively, before) the last tick that is not applied yet. */
  private hasOverdueDecision(): boolean {
    const approach = this.approach;
    if (approach && !approach.applied) {
      const decision = approach.judge.decision;
      if (decision.decided && decision.decidedAt <= this.lastTick) return true;
    }
    const turn = this.openTurn;
    return turn !== null && turn.decision !== null && turn.decision.decidedAt <= this.lastTick;
  }

  /** The earliest scheduled moment in (after, until], or null. */
  private nextTransition(after: number, until: number): number | null {
    const candidates: number[] = [this.deps.startAt + this.limitMs];
    if (this.phase === 'stopped' && this.stoppedUntil !== null) candidates.push(this.stoppedUntil);
    if (this.phase === 'flight' && this.flightUntil !== null) candidates.push(this.flightUntil);
    const approach = this.approach;
    if (approach && !approach.applied) {
      const decision = approach.judge.decision;
      if (decision.decided) candidates.push(decision.decidedAt);
      else {
        candidates.push(decisionDeadline(approach.t0));
        if (approach.autoTapAt !== null && this.assistDrives()) candidates.push(approach.autoTapAt);
      }
    }
    const turn = this.openTurn;
    if (turn) {
      if (turn.decision) candidates.push(turn.decision.decidedAt);
      else {
        candidates.push(turn.moment + TURN.lateMs + PACKET.marginMs);
        if (this.autopilot) candidates.push(turn.moment);
      }
    }
    const due = candidates.filter((t) => t > after && t <= until);
    return due.length === 0 ? null : Math.min(...due);
  }

  /** Apply every transition scheduled at or before `time` (several may coincide). */
  private transitionsAt(time: number, events: RunnerEvent[]): void {
    if (time >= this.deps.startAt + this.limitMs) {
      const reason = this.phase === 'waiting' ? 'disconnected' : 'time';
      if (reason === 'disconnected') this.riderRound.withdraw('disconnected');
      else this.riderRound.timeOut();
      events.push({ type: 'eliminated', at: time, reason });
      this.finish(time);
      return;
    }
    if (this.phase === 'stopped' && this.stoppedUntil !== null && time >= this.stoppedUntil) {
      this.stoppedUntil = null;
      this.phase = 'running';
      if (this.restartOnResume) {
        this.restartOnResume = false;
        events.push({ type: 'restart', fence: this.fenceIdx + 1, attempt: this.riderRound.currentAttempt, at: time });
        this.openApproach(time, events);
      }
    }
    if (this.phase === 'flight' && this.flightUntil !== null && time >= this.flightUntil) this.land();

    const approach = this.approach;
    if (approach && !approach.applied) {
      if (approach.autoTapAt !== null && time >= approach.autoTapAt && this.assistDrives() && !approach.judge.decision.decided) {
        // `time` is the auto-tap moment itself (it is the transition being processed); should a stale planned
        // moment ever slip through, the packet is dated at this transition — never before the last tick.
        approach.judge.submit({ actionTime: time, receiveTime: time, fence: approach.fence.number, attempt: approach.attempt });
      }
      const decision = approach.judge.tick(time);
      if (decision.decided && decision.decidedAt <= time) this.applyTakeoff(approach, decision.offsetMs, decision.decidedAt, events);
      if (this.phase === 'flight' && this.flightUntil !== null && time >= this.flightUntil) this.land();
    }

    const turn = this.openTurn;
    if (turn) {
      if (!turn.decision && this.autopilot && time >= turn.moment) {
        turn.decision = { outcome: judgeTurn(turn.spec.direction, turn.spec.direction, 0, 'collected'), decidedAt: turn.moment };
      }
      if (!turn.decision && time >= turn.moment + TURN.lateMs + PACKET.marginMs) {
        turn.decision = { outcome: judgeTurn(turn.spec.direction, null, null, this.gearInForceAt(turn.moment)), decidedAt: turn.moment + TURN.lateMs + PACKET.marginMs };
      }
      if (turn.decision && time >= turn.decision.decidedAt) this.applyTurn(turn, events);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Motion

  /** Move from `from` to `to` without any scheduled transition in between (running may hit course boundaries). */
  private move(from: number, to: number, events: RunnerEvent[]): void {
    if (to <= from) return;
    if (this.phase === 'approach' && this.approach) {
      const approach = this.approach;
      this.pos = to >= approach.t0 ? approach.fence.distanceM : approach.fence.distanceM - (approach.speed * (approach.t0 - to)) / MS;
      return;
    }
    if (this.phase !== 'running') return;
    let time = from;
    while (time < to && this.phase === 'running') {
      const speed = gearSpeedMPerS(this.gearInForceAt(time));
      const boundary = this.nextBoundary();
      if (boundary && boundary.distanceM <= this.pos) {
        this.atBoundary(boundary.kind, time, events);
        continue;
      }
      if (boundary) {
        const arrival = time + ((boundary.distanceM - this.pos) / speed) * MS;
        if (arrival <= to) {
          this.pos = boundary.distanceM;
          time = arrival;
          this.atBoundary(boundary.kind, time, events);
          continue;
        }
      }
      this.pos += (speed * (to - time)) / MS;
      time = to;
    }
    // An approach that opened inside this stretch is ridden on at its frozen speed for the rest of it, as every later
    // moment of the approach is: the position at `to` is fence − speed × (t0 − to), never the zone entry held back.
    // (The phase is read afresh: atBoundary above may have opened the approach.)
    if ((this.phase as RunnerPhase) === 'approach' && time < to) this.move(time, to, events);
  }

  /** The next course boundary ahead while running: a turn zone, an approach zone (unless a turn is open) or the finish line. */
  private nextBoundary(): { kind: 'turn' | 'fence' | 'finish'; distanceM: number } | null {
    const candidates: { kind: 'turn' | 'fence' | 'finish'; distanceM: number }[] = [];
    const turn = this.deps.course.turns[this.turnIdx];
    if (turn && !this.openTurn) candidates.push({ kind: 'turn', distanceM: turn.distanceM - RUN.turnZoneM });
    const fence = this.deps.course.fences[this.fenceIdx];
    if (fence && !this.openTurn) candidates.push({ kind: 'fence', distanceM: fence.distanceM - RUN.approachZoneM });
    if (!fence) candidates.push({ kind: 'finish', distanceM: this.deps.course.lengthM });
    candidates.sort((a, b) => a.distanceM - b.distanceM);
    return candidates[0] ?? null;
  }

  private atBoundary(kind: 'turn' | 'fence' | 'finish', time: number, events: RunnerEvent[]): void {
    if (kind === 'turn') {
      const spec = this.deps.course.turns[this.turnIdx]!;
      const speed = gearSpeedMPerS(this.gearInForceAt(time));
      const moment = time + ((spec.distanceM - this.pos) / speed) * MS;
      this.openTurn = { spec, moment, decision: null };
      events.push({ type: 'turn-ahead', distanceM: spec.distanceM, at: moment });
      return;
    }
    if (kind === 'fence') {
      if (this.autopilot && time >= this.autopilotUntil) {
        this.phase = 'waiting';
        events.push({ type: 'waiting', at: time });
        return;
      }
      this.openApproach(time, events);
      return;
    }
    // finish
    this.pos = this.deps.course.lengthM;
    const elapsed = time - this.deps.startAt;
    this.riderRound.finish(elapsed / MS, this.allowedSec);
    if (this.riderRound.status === 'eliminated') events.push({ type: 'eliminated', at: time, reason: 'time' });
    else events.push({ type: 'finish', at: time, elapsedMs: elapsed });
    this.finish(time);
  }

  /** Open the approach of the next fence from the current position at `time` (the speed is frozen from here). */
  private openApproach(time: number, events: RunnerEvent[]): void {
    const fence = this.deps.course.fences[this.fenceIdx];
    if (!fence) return;
    const speed = gearSpeedMPerS(this.approachGear(time));
    const t0 = time + ((fence.distanceM - this.pos) / speed) * MS;
    const attempt = this.riderRound.currentAttempt;
    const roll = createRng(`${String(this.deps.seed)}|${this.deps.riderId}|${fence.number}|${attempt}`);
    const approach: Approach = {
      fence,
      attempt,
      openedAt: time,
      t0,
      speed,
      recentHardTurn: this.recentHardTurn,
      judge: new AttemptJudge(t0, fence.number, attempt),
      roll,
      autoTapAt: null,
      applied: false,
    };
    const reference = schoolmasterReferenceWindow(this.approachState(approach, t0), this.deps.rules);
    approach.autoTapAt = t0 + schoolmasterTapOffset(reference, roll);
    this.approach = approach;
    this.lastJudge = approach.judge;
    this.phase = 'approach';
    events.push({ type: 'approach', fence: fence.number, attempt, t0, speedMps: approach.speed });
  }

  private applyTakeoff(approach: Approach, offsetMs: number | null, decidedAt: number, events: RunnerEvent[]): void {
    const actionTime = offsetMs === null ? approach.t0 : approach.t0 + offsetMs;
    const state = this.approachState(approach, Math.max(actionTime, approach.openedAt));
    const outcome = judgeAttempt(state, offsetMs, approach.roll, this.deps.rules);
    approach.applied = true;
    events.push({ type: 'takeoff', fence: approach.fence.number, attempt: approach.attempt, decidedAt, offsetMs, outcome, approach: state });
    this.riderRound.recordOutcome(outcome);
    if (this.riderRound.status === 'eliminated') {
      events.push({ type: 'eliminated', at: decidedAt, reason: 'refusals' });
      this.finish(decidedAt);
      return;
    }
    this.pos = approach.fence.distanceM;
    if (outcome.cleared) {
      // The fence is cleared from the decision on (next fence, attempt 1); the horse itself lands later.
      this.fenceIdx += 1;
      this.phase = 'flight';
      this.flightUntil = Math.max(approach.t0 + RUN.flightMs, decidedAt);
      return;
    }
    this.approach = null;
    this.pos = approach.fence.distanceM - RUN.restartBackM;
    this.phase = 'stopped';
    this.stoppedUntil = decidedAt + (outcome.kind === 'fall' ? RUN.fallDelayMs : RUN.refusalDelayMs);
    this.restartOnResume = true;
  }

  private land(): void {
    const approach = this.approach;
    if (!approach) return;
    this.pos = approach.fence.distanceM + RUN.landingAdvanceM;
    this.approach = null;
    this.flightUntil = null;
    this.recentHardTurn = false;
    this.forcedCollected = false;
    this.phase = 'running';
  }

  private applyTurn(turn: OpenTurn, events: RunnerEvent[]): void {
    const decision = turn.decision!;
    const { outcome } = decision;
    events.push({ type: 'turn', distanceM: turn.spec.distanceM, decidedAt: decision.decidedAt, outcome });
    this.openTurn = null;
    this.turnIdx += 1;
    if (outcome.hardTurn) this.recentHardTurn = true;
    if (outcome.quality === 'wide') this.forcedCollected = true;
    if (outcome.stopSec > 0) {
      this.pos = turn.spec.distanceM;
      this.phase = 'stopped';
      this.stoppedUntil = decision.decidedAt + outcome.stopSec * MS;
      this.restartOnResume = false;
      return;
    }
    // A tight or wide turn decided after the horse already passed the approach zone opens the approach now.
    const fence = this.deps.course.fences[this.fenceIdx];
    if (fence && this.pos >= fence.distanceM - RUN.approachZoneM && this.phase === 'running') this.openApproach(decision.decidedAt, events);
  }

  private finish(at: number): void {
    this.phase = 'done';
    this.finishedAt = at;
    this.approach = null;
    this.openTurn = null;
    this.flightUntil = null;
    this.stoppedUntil = null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Gear, line and the approach state

  private isDone(): boolean {
    return this.phase === 'done';
  }

  private assistDrives(): boolean {
    return this.autopilot || this.deps.rules.assists.schoolmaster;
  }

  /** The gear a new approach freezes: collected for schoolmaster/autopilot or after a wide turn, else the gear in force. */
  private approachGear(time: number): Gear {
    return this.assistDrives() || this.forcedCollected ? 'collected' : this.controlAt(time).gear;
  }

  /** The gear actually in force at `time`: assists and a wide turn collect the canter regardless of the request. */
  private gearInForceAt(time: number): Gear {
    if (this.autopilot || this.forcedCollected) return 'collected';
    if (this.deps.rules.assists.schoolmaster && (this.phase === 'approach' || this.phase === 'flight')) return 'collected';
    return this.controlAt(time).gear;
  }

  private controlAt(time: number): ControlEntry {
    let current = this.controls[0]!;
    for (const entry of this.controls) {
      if (entry.at <= time) current = entry;
      else break;
    }
    return current;
  }

  private pruneControls(now: number): void {
    // Keep one entry before the history window so rewinds inside the window always find a state.
    while (this.controls.length > 2 && this.controls[1]!.at < now - RUN.historyMs) this.controls.shift();
  }

  private approachState(approach: Approach, time: number): ApproachState {
    const control = this.controlAt(time);
    const gear: Gear = this.assistDrives() || this.forcedCollected ? 'collected' : control.gear;
    return {
      gear,
      heightClass: this.deps.heightClass,
      angleSharp: control.line === 'angle',
      recentHardTurn: approach.recentHardTurn,
      spooked: false,
      leadHorseBonus: this.deps.leadHorse?.(approach.fence.number, approach.t0) ?? false,
    };
  }
}
