// One rider's progress through a round (plan 1.8, 1.11): fences, attempts, disobediences, falls, time.
import { isTimeEliminated, refusalFaults, timeFaults } from './faults.js';
import type { TakeoffOutcome } from './takeoff.js';

export type RiderStatus = 'riding' | 'finished' | 'eliminated';

export type EliminationReason = 'refusals' | 'time' | 'disconnected';

export interface FaultEntry {
  fence: number;
  attempt: number;
  kind: TakeoffOutcome['kind'] | 'time';
  faults: number;
  label: string;
}

export class RiderRound {
  private readonly fenceCount: number;
  private fence = 1;
  private attempt = 1;
  private disobediences = 0;
  private total = 0;
  private readonly log: FaultEntry[] = [];
  private state: RiderStatus = 'riding';
  private reason: EliminationReason | null = null;

  constructor(fenceCount: number) {
    if (!Number.isInteger(fenceCount) || fenceCount < 1) {
      throw new RangeError('a round needs at least one fence');
    }
    this.fenceCount = fenceCount;
  }

  /** 1-based index of the fence to jump next; fenceCount + 1 means "to the finish line". */
  get currentFence(): number {
    return this.fence;
  }

  /** 1-based attempt number at the current fence (grows after a refusal, run-out or fall). */
  get currentAttempt(): number {
    return this.attempt;
  }

  get status(): RiderStatus {
    return this.state;
  }

  get eliminationReason(): EliminationReason | null {
    return this.reason;
  }

  /** Jumping faults so far (rails, refusals with 4/8 numbering, falls); time faults are added at the finish. */
  get faults(): number {
    return this.total;
  }

  /** A snapshot for display: copies, so no caller can alter the round's own log or desynchronise it from the total. */
  get entries(): readonly FaultEntry[] {
    return this.log.map((entry) => ({ ...entry }));
  }

  /** Apply the outcome of the current attempt; the third disobedience eliminates. */
  recordOutcome(outcome: TakeoffOutcome): void {
    this.assertRiding();
    if (this.fence > this.fenceCount) throw new Error('no fences left: the rider is heading to the finish');

    let faults = outcome.faults;
    if (outcome.kind === 'refusal' || outcome.kind === 'runout') {
      this.disobediences += 1;
      const numbered = refusalFaults(this.disobediences);
      if (numbered === 'eliminated') {
        this.add(outcome.kind, faults, outcome.label);
        this.eliminate('refusals');
        return;
      }
      faults += numbered;
    }
    this.add(outcome.kind, faults, outcome.label);

    if (outcome.cleared) {
      this.fence += 1;
      this.attempt = 1;
    } else {
      this.attempt += 1;
    }
  }

  /** Cross the finish line after the last fence: adds time faults or eliminates at the limit. */
  finish(elapsedSec: number, allowedSec: number): void {
    this.assertRiding();
    if (this.fence <= this.fenceCount) throw new Error('fences left: the course is not complete');
    if (isTimeEliminated(elapsedSec, allowedSec)) {
      this.eliminate('time');
      return;
    }
    const extra = timeFaults(elapsedSec, allowedSec);
    if (extra > 0) this.add('time', extra, 'tiempo');
    this.state = 'finished';
  }

  /** The limit was reached while still on course. */
  timeOut(): void {
    this.assertRiding();
    this.eliminate('time');
  }

  /** The rider is withdrawn while still riding (left the room, or never came back after a disconnection). */
  withdraw(reason: 'disconnected'): void {
    this.assertRiding();
    this.eliminate(reason);
  }

  private add(kind: FaultEntry['kind'], faults: number, label: string): void {
    this.total += faults;
    this.log.push({ fence: this.fence, attempt: this.attempt, kind, faults, label });
  }

  private eliminate(reason: EliminationReason): void {
    this.state = 'eliminated';
    this.reason = reason;
  }

  private assertRiding(): void {
    if (this.state === 'eliminated') throw new Error('the rider is eliminated; the round is over');
    if (this.state === 'finished') throw new Error('the rider has finished; the round is over');
  }
}
