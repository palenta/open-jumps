// Heats (mangas) for rooms of 5–16 riders (plan 1.7): up to 4 on the arena at once, the rest in the stands.
import type { HeightClass } from './heightClasses.js';
import { createRng } from './rng.js';

export const HEAT_SIZE = 4;

export interface HeatEntry {
  riderId: string;
  heightClass: HeightClass;
}

export type HeatOrder = 'random' | 'lowest-class-first';

/**
 * Split riders into heats of at most HEAT_SIZE, deterministically for a seed.
 * 'random' shuffles riders by the seed; 'lowest-class-first' orders by height class ascending (ties by seed).
 * Every rider appears exactly once; only the last heat may be smaller.
 */
export function partitionHeats(
  riders: readonly HeatEntry[],
  seed: number | string,
  order: HeatOrder,
): string[][] {
  if (riders.length === 0) return [];
  const rng = createRng(`heats|${String(seed)}`);
  const shuffled = [...riders];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  if (order === 'lowest-class-first') {
    shuffled.sort((a, b) => a.heightClass - b.heightClass); // stable: ties keep the seeded order
  }
  const heats: string[][] = [];
  for (let start = 0; start < shuffled.length; start += HEAT_SIZE) {
    heats.push(shuffled.slice(start, start + HEAT_SIZE).map((entry) => entry.riderId));
  }
  return heats;
}
