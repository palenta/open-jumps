// A class (plan 1.7): heats of up to four over one course — course walk, round, results — until every heat has
// ridden, then one class table grouped by height class. Pure: driven by tick(now).
import type { AssistSettings, CourseSpec, EliminationReason, HeatOrder, HeightClass, RiderStatus, RoundMode } from '@open-jumps/shared';
import { HeatSchedule } from '../rooms/heatSchedule.js';
import { RoundEngine, type RiderCommand, type RoundEvent, type RoundResult, type RoundSnapshot } from './roundEngine.js';

export const CLASS_TIMING = {
  /** Course walk (reconocimiento): club tier 10 s, upper tiers 20 s. */
  walkMs: 10_000,
  /** Results and fail reel between heats. */
  resultsMs: 15_000,
} as const;

export type ClassPhase = 'walk' | 'riding' | 'results' | 'done';

export interface ClassRider {
  riderId: string;
  heightClass: HeightClass;
  assists: AssistSettings;
}

export interface ClassSetup {
  classId: string;
  course: CourseSpec;
  riders: ClassRider[];
  order: HeatOrder;
  mode: RoundMode;
  seed: number | string;
  /** Shorter phases for tests; defaults to CLASS_TIMING. */
  timing?: { walkMs: number; resultsMs: number };
}

export interface ClassTableRow {
  /** 1-based place within the height class; null for eliminated riders (they are listed after the placed ones). */
  place: number | null;
  riderId: string;
  faults: number;
  timeMs: number | null;
  status: RiderStatus;
  eliminationReason: EliminationReason | null;
  autopilot: boolean;
}

/** One table per height class, each sorted by faults then time; equal (faults, time) share a place, the next place skips. */
export type ClassTable = Partial<Record<HeightClass, ClassTableRow[]>>;

export type ClassEvent =
  /** A phase began at `at`; `endsAt` is when its timer ends (walk, results) — null for riding (the heat decides) and done. */
  | { type: 'phase'; phase: ClassPhase; heatIndex: number; at: number; endsAt: number | null }
  | (RoundEvent & { type: RoundEvent['type']; heatIndex: number });

/**
 * One table per height class from a set of results: finishers first by (faults asc, time asc), equal pairs share
 * a place and the next place skips (1, 1, 3); eliminated riders follow with place null, ordered by faults then
 * rider id. Riders of a heat that has not finished are absent.
 */
export function buildClassTable(results: readonly RoundResult[]): ClassTable {
  const table: ClassTable = {};
  const classes = [...new Set(results.map((r) => r.heightClass))].sort((a, b) => a - b);
  for (const heightClass of classes) {
    const ofClass = results.filter((r) => r.heightClass === heightClass);
    const finishers = ofClass
      .filter((r) => r.status === 'finished')
      .sort((a, b) => a.faults - b.faults || (a.timeMs ?? 0) - (b.timeMs ?? 0));
    const rows: ClassTableRow[] = [];
    finishers.forEach((result, index) => {
      const previous = finishers[index - 1];
      const tied = previous !== undefined && previous.faults === result.faults && previous.timeMs === result.timeMs;
      const place = tied ? rows[index - 1]!.place : index + 1;
      rows.push(row(result, place));
    });
    const eliminated = ofClass.filter((r) => r.status !== 'finished').sort((a, b) => a.faults - b.faults || a.riderId.localeCompare(b.riderId));
    for (const result of eliminated) rows.push(row(result, null));
    table[heightClass] = rows;
  }
  return table;
}

function row(result: RoundResult, place: number | null): ClassTableRow {
  return {
    place,
    riderId: result.riderId,
    faults: result.faults,
    timeMs: result.timeMs,
    status: result.status,
    eliminationReason: result.eliminationReason,
    autopilot: result.autopilot,
  };
}

/** Round ids are `${classId}#${heatIndex}`; a withdrawn rider's result is recorded like any elimination. */
export class ClassFlow {
  private readonly setup: ClassSetup;
  private readonly timing: { walkMs: number; resultsMs: number };
  private readonly heats: HeatSchedule;
  private readonly riderById = new Map<string, ClassRider>();
  private currentPhase: ClassPhase = 'walk';
  /** When the current phase began (server ms); null before start(). */
  private phaseAt: number | null = null;
  private running: RoundEngine | null = null;
  private readonly finished: RoundResult[] = [];
  /** The last snapshot of every finished heat, by heat index (the riders as the heat ended). */
  private readonly finals = new Map<number, RoundSnapshot>();
  private pending: ClassEvent[] = [];

  constructor(setup: ClassSetup) {
    this.setup = setup;
    this.timing = setup.timing ?? CLASS_TIMING;
    this.heats = new HeatSchedule(setup.riders.map((r) => ({ riderId: r.riderId, heightClass: r.heightClass })), setup.seed, setup.order);
    for (const rider of setup.riders) this.riderById.set(rider.riderId, rider);
    if (this.heats.isComplete()) this.currentPhase = 'done';
  }

  get phase(): ClassPhase {
    return this.currentPhase;
  }

  /** Index of the running (or last) heat in the schedule. */
  get heatIndex(): number {
    const current = this.heats.current();
    return current ? current.index : Math.max(0, this.heats.heats.length - 1);
  }

  get schedule(): HeatSchedule {
    return this.heats;
  }

  /** The engine of the running heat; null outside 'riding'. */
  engine(): RoundEngine | null {
    return this.currentPhase === 'riding' ? this.running : null;
  }

  /**
   * The final snapshot of a finished heat — every rider finished or eliminated, with the faults and status of the
   * heat's results — or null while it has not ended. The tick that ends a heat also switches to 'results', so from
   * that tick on engine() is null: this is where the heat's last values are read (audit K1 r2 #2).
   */
  finalSnapshot(heatIndex: number): RoundSnapshot | null {
    return this.finals.get(heatIndex) ?? null;
  }

  /** When the current phase began (server ms); null before start(). A late joiner is told this with the phase. */
  get phaseStartedAt(): number | null {
    return this.phaseAt;
  }

  /** When the current phase's timer ends (server ms): walk and results have one; riding and done do not (null). */
  phaseEndsAt(): number | null {
    if (this.phaseAt === null) return null;
    return this.timerEnd(this.currentPhase, this.phaseAt);
  }

  /** Begin the first course walk at `now`. */
  start(now: number): void {
    if (this.phaseAt !== null || this.currentPhase === 'done') return;
    this.phaseAt = now;
    this.pending.push(this.phaseEvent('walk', this.heatIndex, now));
  }

  /** Advance phases and the running heat to `now`; returns this call's events. */
  tick(now: number): ClassEvent[] {
    const events = this.pending;
    this.pending = [];
    if (this.phaseAt === null || this.currentPhase === 'done') return events;
    for (;;) {
      const phaseAt: number = this.phaseAt;
      if (this.currentPhase === 'walk') {
        const startAt = phaseAt + this.timing.walkMs;
        if (now < startAt) break;
        this.startHeat(startAt, events);
        continue;
      }
      if (this.currentPhase === 'riding' && this.running) {
        const heatIndex = this.heatIndex;
        const roundEvents = this.running.tick(now);
        for (const event of roundEvents) events.push({ ...event, heatIndex });
        if (!this.running.isComplete()) break;
        this.finished.push(...this.running.results());
        this.finals.set(heatIndex, this.running.snapshot());
        const endedAt = roundEvents.reduce((latest, e) => ('at' in e ? Math.max(latest, e.at) : 'decidedAt' in e ? Math.max(latest, e.decidedAt) : latest), phaseAt);
        this.currentPhase = 'results';
        this.phaseAt = Math.min(endedAt, now);
        events.push(this.phaseEvent('results', heatIndex, this.phaseAt));
        continue;
      }
      if (this.currentPhase === 'results') {
        const nextAt: number = phaseAt + this.timing.resultsMs;
        if (now < nextAt) break;
        const next = this.heats.advance();
        this.running = null;
        this.phaseAt = nextAt;
        if (!next) {
          this.currentPhase = 'done';
          events.push(this.phaseEvent('done', this.heatIndex, nextAt));
          break;
        }
        this.currentPhase = 'walk';
        events.push(this.phaseEvent('walk', next.index, nextAt));
        continue;
      }
      break;
    }
    return events;
  }

  /** Whether another heat will be ridden after heat `heatIndex`, by the schedule as it stands now (riders who left are out of it). */
  hasHeatAfter(heatIndex: number): boolean {
    return this.heats.hasHeatAfter(heatIndex);
  }

  /** Commands reach the running heat only; others are dropped. */
  enqueue(command: RiderCommand): void {
    this.engine()?.enqueue(command);
  }

  riderDisconnected(riderId: string, now: number): void {
    this.engine()?.riderDisconnected(riderId, now);
  }

  riderReconnected(riderId: string, now: number): void {
    this.engine()?.riderReconnected(riderId, now);
  }

  /** Left the room: out of future heats; eliminated in the running heat, which continues. */
  riderLeft(riderId: string, now: number): void {
    this.heats.riderLeft(riderId);
    this.engine()?.riderLeft(riderId, now);
  }

  /** Results of every finished heat so far. */
  results(): RoundResult[] {
    return [...this.finished];
  }

  /** The class table from the results so far (complete once phase is 'done'). */
  table(): ClassTable {
    return buildClassTable(this.finished);
  }

  private startHeat(startAt: number, events: ClassEvent[]): void {
    const heat = this.heats.current();
    if (!heat) {
      this.currentPhase = 'done';
      this.phaseAt = startAt;
      events.push(this.phaseEvent('done', this.heatIndex, startAt));
      return;
    }
    const riders = heat.riderIds.map((id) => this.riderById.get(id)).filter((r): r is ClassRider => r !== undefined);
    this.running = new RoundEngine({
      roundId: `${this.setup.classId}#${heat.index}`,
      course: this.setup.course,
      riders,
      mode: this.setup.mode,
      seed: `${String(this.setup.seed)}|${heat.index}`,
      startAt,
    });
    this.currentPhase = 'riding';
    this.phaseAt = startAt;
    events.push(this.phaseEvent('riding', heat.index, startAt));
  }

  private phaseEvent(phase: ClassPhase, heatIndex: number, at: number): ClassEvent {
    return { type: 'phase', phase, heatIndex, at, endsAt: this.timerEnd(phase, at) };
  }

  /** The end of a timed phase that began at `at`: the walk and the results run on timers, riding and done do not. */
  private timerEnd(phase: ClassPhase, at: number): number | null {
    if (phase === 'walk') return at + this.timing.walkMs;
    if (phase === 'results') return at + this.timing.resultsMs;
    return null;
  }
}
