// Heat schedule for a class of 2–16 riders (plan 1.7): built on shared partitionHeats, advanced heat by heat.
import { partitionHeats, type HeatEntry, type HeatOrder } from '@open-jumps/shared';

export interface HeatView {
  index: number;
  riderIds: readonly string[];
  /** Riders who left this heat while it was running (they count as eliminated, the heat goes on). */
  withdrawn: readonly string[];
}

export class HeatSchedule {
  /** Heat indices never shift: an emptied future heat stays in the plan and is skipped on advance. */
  private readonly plan: string[][];
  private index = 0;
  private withdrawnNow: string[] = [];

  constructor(riders: readonly HeatEntry[], seed: number | string, order: HeatOrder) {
    this.plan = partitionHeats(riders, seed, order);
  }

  get heats(): readonly (readonly string[])[] {
    return this.plan;
  }

  /** The running heat, or null when the class is complete. */
  current(): HeatView | null {
    const heat = this.plan[this.index];
    if (heat === undefined) return null;
    return { index: this.index, riderIds: [...heat], withdrawn: [...this.withdrawnNow] };
  }

  /** Finish the running heat and move to the next; returns the new current heat or null when done. */
  advance(): HeatView | null {
    if (this.isComplete()) return null;
    this.withdrawnNow = [];
    this.index += 1;
    while (this.index < this.plan.length && this.plan[this.index]?.length === 0) this.index += 1;
    return this.current();
  }

  /**
   * A rider left the room: removed from every future heat; if in the running heat, marked withdrawn there
   * (the heat continues for the others; the result is the round's business).
   */
  riderLeft(riderId: string): void {
    const running = this.plan[this.index];
    if (running?.includes(riderId) && !this.withdrawnNow.includes(riderId)) this.withdrawnNow.push(riderId);
    for (let i = this.index + 1; i < this.plan.length; i += 1) {
      const heat = this.plan[i];
      if (heat !== undefined) this.plan[i] = heat.filter((id) => id !== riderId);
    }
  }

  isComplete(): boolean {
    return this.index >= this.plan.length;
  }
}
