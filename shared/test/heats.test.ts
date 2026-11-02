// Matrix row 5 (plan 1.7): heats of at most four, deterministic by seed, every rider exactly once.
import { describe, expect, it } from 'vitest';
import { HEAT_SIZE, partitionHeats, type HeatEntry } from '../src/rules/heats.js';

const riders = (n: number): HeatEntry[] =>
  Array.from({ length: n }, (_, i) => ({ riderId: `r${i + 1}`, heightClass: 70 }));

describe('partitionHeats', () => {
  it('heat size is four', () => {
    expect(HEAT_SIZE).toBe(4);
  });

  it('2–4 riders form a single heat', () => {
    expect(partitionHeats(riders(2), 1, 'random')).toHaveLength(1);
    expect(partitionHeats(riders(4), 1, 'random')).toHaveLength(1);
    expect(partitionHeats(riders(4), 1, 'random')[0]).toHaveLength(4);
  });

  it('5 riders → heats of 4 and 1; 9 → 4, 4, 1; 16 → four heats of 4', () => {
    expect(partitionHeats(riders(5), 1, 'random').map((h) => h.length)).toEqual([4, 1]);
    expect(partitionHeats(riders(9), 1, 'random').map((h) => h.length)).toEqual([4, 4, 1]);
    expect(partitionHeats(riders(16), 1, 'random').map((h) => h.length)).toEqual([4, 4, 4, 4]);
  });

  it('no riders → no heats', () => {
    expect(partitionHeats([], 1, 'random')).toEqual([]);
  });

  it('every rider appears exactly once', () => {
    const all = partitionHeats(riders(16), 'seed', 'random').flat();
    expect(all).toHaveLength(16);
    expect(new Set(all).size).toBe(16);
    expect(new Set(all)).toEqual(new Set(riders(16).map((r) => r.riderId)));
  });

  it('is deterministic for a seed and shuffles differently for another seed', () => {
    const a = partitionHeats(riders(16), 'A', 'random');
    const b = partitionHeats(riders(16), 'A', 'random');
    const c = partitionHeats(riders(16), 'B', 'random');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('"lowest-class-first" puts the lowest height classes in the first heat, ascending', () => {
    const entries: HeatEntry[] = [
      { riderId: 'ninety', heightClass: 90 },
      { riderId: 'sixty-a', heightClass: 60 },
      { riderId: 'seventy', heightClass: 70 },
      { riderId: 'eighty', heightClass: 80 },
      { riderId: 'sixty-b', heightClass: 60 },
    ];
    const heats = partitionHeats(entries, 7, 'lowest-class-first');
    expect(heats).toHaveLength(2);
    expect(new Set(heats[0])).toEqual(new Set(['sixty-a', 'sixty-b', 'seventy', 'eighty']));
    expect(heats[0]!.slice(0, 2).sort()).toEqual(['sixty-a', 'sixty-b']);
    expect(heats[0]![2]).toBe('seventy');
    expect(heats[0]![3]).toBe('eighty');
    expect(heats[1]).toEqual(['ninety']);
  });
});
