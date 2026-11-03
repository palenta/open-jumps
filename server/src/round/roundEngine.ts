// The authoritative round (plan 2.3): up to four runners on one course, a command queue drained strictly before
// the tick with the same time, chance rolls from the round seed, lead-horse bonuses between riders, the event
// log for the fail reel, and the results. Pure: driven by enqueue() and tick(now).
import {
  RULES_VERSION,
  freezeForRound,
  type AssistSettings,
  type CourseSpec,
  type EliminationReason,
  type FaultEntry,
  type Gear,
  type HeightClass,
  type RiderStatus,
  type RoundMode,
  type TurnChoice,
} from '@open-jumps/shared';
import { CourseRunner, RUN, type Line, type RunnerEvent, type RunnerSnapshot } from './courseRunner.js';

export interface RoundRider {
  riderId: string;
  heightClass: HeightClass;
  /** Settings as they are when the round starts; frozen for the round (plan 1.8). */
  assists: AssistSettings;
}

export interface RoundSetup {
  roundId: string;
  course: CourseSpec;
  riders: RoundRider[];
  mode: RoundMode;
  seed: number | string;
  /** Server time of the start signal. */
  startAt: number;
}

/** A command from a rider's client, stamped with the server receive time; action times are already server time. */
export type RiderCommand = { riderId: string; receiveTime: number } & (
  | { kind: 'tap'; actionTime: number; fence: number; attempt: number }
  | { kind: 'turn'; choice: TurnChoice; actionTime: number }
  | { kind: 'gear'; gear: Gear }
  | { kind: 'line'; line: Line }
);

export type RoundEvent = RunnerEvent & { riderId: string };

export interface RiderView extends RunnerSnapshot {
  riderId: string;
  heightClass: HeightClass;
  faults: number;
  status: RiderStatus;
  eliminationReason: EliminationReason | null;
  elapsedMs: number;
  /** The caption of the last take-off or turn (rider vocabulary), for the HUD. */
  lastLabel: string | null;
}

export interface RoundSnapshot {
  roundId: string;
  elapsedMs: number;
  complete: boolean;
  riders: RiderView[];
}

export interface RoundResult {
  roundId: string;
  riderId: string;
  heightClass: HeightClass;
  faults: number;
  /** Time on course in ms for a finisher; null when eliminated. */
  timeMs: number | null;
  status: RiderStatus;
  eliminationReason: EliminationReason | null;
  /** "con autopiloto": at least one autopilot segment — shown in the round, never in leaderboards (plan 2.3). */
  autopilot: boolean;
  schoolmaster: boolean;
  entries: FaultEntry[];
  rulesVersion: number;
  courseId: string;
  courseVersion: number;
  seed: string;
}

interface Entry {
  riderId: string;
  runner: CourseRunner;
  heightClass: HeightClass;
  schoolmaster: boolean;
  lastLabel: string | null;
}

/**
 * Ordering contract: tick(now) first hands every queued command with receiveTime ≤ now to its runner in
 * receive order (ties by enqueue order), interleaved with the 50 ms sub-steps so that a packet is always
 * submitted before the sub-step whose time it does not exceed (AttemptJudge's contract), then advances all
 * runners to now. A command stamped with the last tick's own millisecond (the room's clock has millisecond
 * precision: a message handled right after tick(T) carries receiveTime = T) keeps its TRUE receive time — the
 * age, future and deadline rules of plan 2.3 must see the time as stamped, never a shifted one: it is handed
 * over before the next sub-step, the judge accepts a packet stamped at its last tick, and the runner applies
 * the decision at the start of that sub-step, dated with the stamp. Commands for unknown riders or riders who
 * are done are dropped. Chance rolls come from createRng(`${seed}|${riderId}|${fence}|${attempt}`), so the
 * same inputs reproduce the same outcomes.
 */
export class RoundEngine {
  private readonly setup: RoundSetup;
  private readonly entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private readonly queue: { command: RiderCommand; seq: number }[] = [];
  private seq = 0;
  private lastTick: number;
  private readonly log: RoundEvent[] = [];
  private pending: RoundEvent[] = [];
  /** Clean jumps on a good line by rider and moment, for the lead-horse bonus of the others (plan 1.11а). */
  private readonly clears: { riderId: string; fence: number; at: number }[] = [];

  constructor(setup: RoundSetup) {
    this.setup = setup;
    this.lastTick = setup.startAt;
    for (const rider of setup.riders) {
      const runner = new CourseRunner({
        riderId: rider.riderId,
        course: setup.course,
        heightClass: rider.heightClass,
        rules: { mode: setup.mode, assists: freezeForRound(rider.assists) },
        seed: setup.seed,
        startAt: setup.startAt,
        leadHorse: (fence, t0) => this.leadHorseFor(rider.riderId, fence, t0),
      });
      const entry: Entry = { riderId: rider.riderId, runner, heightClass: rider.heightClass, schoolmaster: rider.assists.schoolmaster, lastLabel: null };
      this.entries.push(entry);
      this.byId.set(rider.riderId, entry);
    }
  }

  get roundId(): string {
    return this.setup.roundId;
  }

  enqueue(command: RiderCommand): void {
    if (!this.byId.has(command.riderId)) return;
    // The receive time is kept exactly as stamped (a command stamped with the last tick's millisecond is handed
    // over at the next sub-step with that true time); ties in receive time keep the enqueue order via seq.
    this.queue.push({ command, seq: this.seq });
    this.seq += 1;
  }

  /**
   * Advance to `now`; returns the events of this call in time order. `now` must be a COMPLETED millisecond of the
   * caller's clock: no command may be stamped with a receive time ≤ `now` after this call (the live room ticks
   * `clock() − 1`), so a packet received exactly at a deadline is always submitted before the tick that would
   * fix "no tap" there — whichever callback the event loop ran first.
   */
  tick(now: number): RoundEvent[] {
    if (now < this.lastTick) throw new Error(`tick goes backwards: ${now} < ${this.lastTick}`);
    const events: RoundEvent[] = this.pending;
    this.pending = [];
    for (let step = this.lastTick + RUN.tickMs; step < now; step += RUN.tickMs) this.subStep(step, events);
    if (now > this.lastTick) this.subStep(now, events);
    this.lastTick = now;
    this.log.push(...events);
    return events;
  }

  /** All events so far (for the fail reel and awards). */
  get events(): readonly RoundEvent[] {
    return this.log;
  }

  snapshot(): RoundSnapshot {
    return {
      roundId: this.setup.roundId,
      elapsedMs: Math.max(0, this.lastTick - this.setup.startAt),
      complete: this.isComplete(),
      riders: this.entries.map((entry) => ({
        ...entry.runner.snapshot(),
        riderId: entry.riderId,
        heightClass: entry.heightClass,
        faults: entry.runner.round.faults,
        status: entry.runner.round.status,
        eliminationReason: entry.runner.round.eliminationReason,
        elapsedMs: entry.runner.elapsedMs(this.lastTick),
        lastLabel: entry.lastLabel,
      })),
    };
  }

  /** Every rider finished or eliminated. */
  isComplete(): boolean {
    return this.entries.every((entry) => entry.runner.round.status !== 'riding');
  }

  /** Results of all riders; throws while the round is not complete. */
  results(): RoundResult[] {
    if (!this.isComplete()) throw new Error('the round is not complete: results are not final yet');
    return this.entries.map((entry) => {
      const round = entry.runner.round;
      return {
        roundId: this.setup.roundId,
        riderId: entry.riderId,
        heightClass: entry.heightClass,
        faults: round.faults,
        timeMs: round.status === 'finished' ? entry.runner.elapsedMs(this.lastTick) : null,
        status: round.status,
        eliminationReason: round.eliminationReason,
        autopilot: entry.runner.snapshot().usedAutopilot,
        schoolmaster: entry.schoolmaster,
        entries: round.entries.filter((entry) => entry.faults > 0), // the fault log: clean take-offs are not faults
        rulesVersion: RULES_VERSION,
        courseId: this.setup.course.id,
        courseVersion: this.setup.course.version,
        seed: String(this.setup.seed),
      };
    });
  }

  /**
   * A rider's undecided approach (CourseRunner.undecidedApproach, with its frozen speedMps — K1.1 step 5) and the
   * hard-turn flag in force, for a client that takes control back (audit K1 r2 #1); null for a rider who is not in
   * this round.
   */
  approachOf(riderId: string): { approach: { fence: number; attempt: number; t0: number; speedMps: number } | null; hardTurn: boolean } | null {
    const entry = this.byId.get(riderId);
    if (!entry) return null;
    return { approach: entry.runner.undecidedApproach(), hardTurn: entry.runner.snapshot().recentHardTurn };
  }

  riderDisconnected(riderId: string, now: number): void {
    this.byId.get(riderId)?.runner.disconnected(now);
  }

  riderReconnected(riderId: string, now: number): void {
    this.byId.get(riderId)?.runner.reconnected(now);
  }

  /** The rider left the room for good: eliminated 'disconnected' now; the round goes on for the others. */
  riderLeft(riderId: string, now: number): void {
    const entry = this.byId.get(riderId);
    if (!entry || entry.runner.round.status !== 'riding') return;
    entry.runner.withdraw(now);
    this.pending.push({ type: 'eliminated', at: now, reason: 'disconnected', riderId });
  }

  /** Hand over the commands due by `time` (receive order, ties by enqueue order), then tick every runner to `time`. */
  private subStep(time: number, events: RoundEvent[]): void {
    const due = this.queue.filter((item) => item.command.receiveTime <= time).sort((a, b) => a.command.receiveTime - b.command.receiveTime || a.seq - b.seq);
    const touched: string[] = [];
    for (const { command } of due) {
      this.queue.splice(this.queue.indexOf(this.queue.find((item) => item.command === command)!), 1);
      const entry = this.byId.get(command.riderId);
      if (!entry) continue;
      if (!touched.includes(command.riderId)) touched.push(command.riderId);
      this.dispatch(entry, command);
    }
    // Runners that just received a command tick first, in that order, so their decisions keep the receive order.
    const order = [...touched.map((id) => this.byId.get(id)!), ...this.entries.filter((entry) => !touched.includes(entry.riderId))];
    for (const entry of order) {
      for (const event of entry.runner.tick(time)) {
        if (event.type === 'takeoff') {
          entry.lastLabel = event.outcome.label;
          // Plan 1.11а: only a CLEAN jump on a good line leads the others — neither a clear with a rail (chip, long)
          // nor a clean jump off a sharp line counts.
          if (event.outcome.cleared && event.outcome.faults === 0 && !event.approach.angleSharp) {
            this.clears.push({ riderId: entry.riderId, fence: event.fence, at: event.decidedAt });
          }
        } else if (event.type === 'turn') {
          entry.lastLabel = event.outcome.label;
        }
        events.push({ ...event, riderId: entry.riderId });
      }
    }
  }

  private dispatch(entry: Entry, command: RiderCommand): void {
    switch (command.kind) {
      case 'tap':
        entry.runner.tap({ actionTime: command.actionTime, receiveTime: command.receiveTime, fence: command.fence, attempt: command.attempt });
        break;
      case 'turn':
        entry.runner.turn({ choice: command.choice, actionTime: command.actionTime, receiveTime: command.receiveTime });
        break;
      case 'gear':
        entry.runner.setGear(command.gear, command.receiveTime);
        break;
      case 'line':
        entry.runner.setLine(command.line, command.receiveTime);
        break;
    }
  }

  /** Another rider cleared the fence within RUN.leadHorseMs before this rider's t0 (plan 1.11а). */
  private leadHorseFor(riderId: string, fence: number, t0: number): boolean {
    return this.clears.some((clear) => clear.riderId !== riderId && clear.fence === fence && clear.at >= t0 - RUN.leadHorseMs && clear.at <= t0);
  }
}
