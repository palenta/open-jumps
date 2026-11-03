// Matrix row 5: heats of four, transitions, a rider leaving mid-heat or before their heat.
import type { HeatEntry } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { HeatSchedule } from '../src/rooms/heatSchedule.js';

const riders = (n: number): HeatEntry[] => Array.from({ length: n }, (_, i) => ({ riderId: `r${i + 1}`, heightClass: 70 }));

describe('HeatSchedule', () => {
  it('2–4 riders → one heat; 5 → [4, 1]; 16 → four heats', () => {
    expect(new HeatSchedule(riders(3), 1, 'random').heats.map((h) => h.length)).toEqual([3]);
    expect(new HeatSchedule(riders(5), 1, 'random').heats.map((h) => h.length)).toEqual([4, 1]);
    expect(new HeatSchedule(riders(16), 1, 'random').heats.map((h) => h.length)).toEqual([4, 4, 4, 4]);
  });

  it('starts at heat 0 and advances until complete', () => {
    const schedule = new HeatSchedule(riders(9), 'seed', 'random');
    expect(schedule.current()?.index).toBe(0);
    expect(schedule.isComplete()).toBe(false);
    expect(schedule.advance()?.index).toBe(1);
    expect(schedule.advance()?.index).toBe(2);
    expect(schedule.advance()).toBeNull();
    expect(schedule.isComplete()).toBe(true);
    expect(schedule.current()).toBeNull();
  });

  it('a rider leaving mid-heat is marked withdrawn there; the heat goes on for the others', () => {
    const schedule = new HeatSchedule(riders(8), 'seed', 'random');
    const first = schedule.current()!;
    const leaver = first.riderIds[0]!;
    schedule.riderLeft(leaver);
    const now = schedule.current()!;
    expect(now.index).toBe(0);
    expect(now.riderIds).toEqual(first.riderIds);
    expect(now.withdrawn).toEqual([leaver]);
  });

  it('a rider leaving before their heat is removed from the future heat', () => {
    const schedule = new HeatSchedule(riders(8), 'seed', 'random');
    const second = schedule.heats[1]!;
    const leaver = second[0]!;
    schedule.riderLeft(leaver);
    schedule.advance();
    const now = schedule.current()!;
    expect(now.index).toBe(1);
    expect(now.riderIds).not.toContain(leaver);
    expect(now.riderIds).toHaveLength(3);
    expect(now.withdrawn).toEqual([]);
  });

  it('a future heat emptied by departures is skipped', () => {
    const schedule = new HeatSchedule(riders(5), 'seed', 'random');
    const lone = schedule.heats[1]![0]!;
    schedule.riderLeft(lone);
    expect(schedule.advance()).toBeNull();
    expect(schedule.isComplete()).toBe(true);
  });

  it('is deterministic for a seed and honours lowest-class-first', () => {
    const entries: HeatEntry[] = [
      { riderId: 'ninety', heightClass: 90 },
      { riderId: 'sixty', heightClass: 60 },
      { riderId: 'seventy', heightClass: 70 },
      { riderId: 'eighty', heightClass: 80 },
      { riderId: 'hundred', heightClass: 100 },
    ];
    const a = new HeatSchedule(entries, 'x', 'lowest-class-first');
    const b = new HeatSchedule(entries, 'x', 'lowest-class-first');
    expect(a.heats).toEqual(b.heats);
    expect(a.heats[0]).toEqual(['sixty', 'seventy', 'eighty', 'ninety']);
    expect(a.heats[1]).toEqual(['hundred']);
  });

  it('hasHeatAfter: whether a heat with riders follows a given heat in the plan as it stands — departures included (audit K1 r3 #6)', () => {
    const one = new HeatSchedule(riders(2), 'seed', 'random');
    expect(one.hasHeatAfter(0)).toBe(false);
    const two = new HeatSchedule(riders(5), 'seed', 'random');
    expect(two.hasHeatAfter(0)).toBe(true);
    expect(two.hasHeatAfter(1)).toBe(false);
    two.riderLeft(two.heats[1]![0]!); // the only rider of heat 2 leaves during heat 1
    expect(two.hasHeatAfter(0)).toBe(false);
    expect(two.advance()).toBeNull();
  });
});
