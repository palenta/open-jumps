// Pony categories and height classes (plan 1.6, 1.7): category limits the classes; class narrows the window.

export type PonyCategory = 'A' | 'B' | 'C' | 'D';
export type HeightClass = 50 | 60 | 70 | 80 | 90 | 100;

export const HEIGHT_CLASSES: readonly HeightClass[] = [50, 60, 70, 80, 90, 100];

/** Height classes a pony category may enter (plan 1.6; limits to be confirmed with a native speaker). */
const CLASSES_BY_CATEGORY: Record<PonyCategory, HeightClass[]> = {
  A: [50, 60, 70],
  B: [60, 70, 80],
  C: [70, 80, 90],
  D: [80, 90, 100],
};

/** Window multiplier per class: 1.0 at 60 cm, narrower with every 10 cm, wider at 50 cm; never below 0.5. */
const WINDOW_SCALE: Record<HeightClass, number> = {
  50: 1.1,
  60: 1.0,
  70: 0.9,
  80: 0.8,
  90: 0.7,
  100: 0.6,
};

/** Chance that a clean-tier tap on a gallop approach still drops the back rail; about 1 in 2 at 60 cm. */
const GALLOP_RAIL_PROBABILITY: Record<HeightClass, number> = {
  50: 0.45,
  60: 0.5,
  70: 0.56,
  80: 0.62,
  90: 0.68,
  100: 0.74,
};

export function allowedHeightClasses(category: PonyCategory): HeightClass[] {
  return [...CLASSES_BY_CATEGORY[category]];
}

export function windowScaleForHeight(heightClass: HeightClass): number {
  return WINDOW_SCALE[heightClass];
}

export function gallopRailProbability(heightClass: HeightClass): number {
  return GALLOP_RAIL_PROBABILITY[heightClass];
}
