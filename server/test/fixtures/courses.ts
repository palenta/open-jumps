// Shared course fixtures for the round tests (no describe/it here: importing a test file would register its
// suites again in every importer).
import type { CourseSpec } from '@open-jumps/shared';

/**
 * Collected canter is exactly 5 m/s, so at 50 ms ticks the horse moves 0.25 m per tick and every moment is
 * exact: fence 1 (take-off 30 m) → approach zone at 18 m at t = 3600, t0 = 6000; landing at 33 m at 6600;
 * turn at 45 m → zone at 35 m at t = 7000 ('turn-ahead'), turn moment 9000; fence 2 (60 m) → zone at 48 m at
 * 9600, t0 = 12 000, landing 63 m at 12 600; fence 3 (100 m) → zone at 88 m at 17 600, t0 = 20 000, landing
 * 103 m at 20 600; finish line 120 m at 24 000. Time allowed 24 s (120 m at 300 m/min), limit 48 s.
 */
export const THREE_FENCE_COURSE: CourseSpec = {
  id: 'runner-test',
  version: 1,
  lengthM: 120,
  speedMPerMin: 300,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 60, type: 'oxer' },
    { number: 3, distanceM: 100, type: 'vertical' },
  ],
  turns: [{ distanceM: 45, direction: 'left' }],
};

/** 300 m at a 600 m/min norm: allowed 30 s, limit 60 s; one fence at 290 m; a passive rider reaches the line at 60.1 s. */
export const SLOW_LIMIT_COURSE: CourseSpec = {
  id: 'slow',
  version: 1,
  lengthM: 300,
  speedMPerMin: 600,
  fences: [{ number: 1, distanceM: 290, type: 'vertical' }],
  turns: [],
};

/**
 * 299.75 m at a 600 m/min norm: allowed ceil(29.975) = 30 s, limit 60 s; one fence at 290 m (zone at 278 m at
 * 55 600, t0 = 58 000, deadline 58 700). A take-off decided at 58 600 + d (d ≥ 0) lands at 293 m at that very
 * moment and reaches the line 6.75 m / 5 m/s = 1350 ms later, at 59 950 + d: d = 49 → 1 ms before the limit,
 * d = 50 → exactly at it, d = 51 → 1 ms after it (the limit then strikes first, at 60 000).
 */
export const LIMIT_EDGE_COURSE: CourseSpec = {
  id: 'limit-edge',
  version: 1,
  lengthM: 299.75,
  speedMPerMin: 600,
  fences: [{ number: 1, distanceM: 290, type: 'vertical' }],
  turns: [],
};
