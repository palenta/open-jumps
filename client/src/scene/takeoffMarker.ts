// The take-off marker of the own horse (K1.1 step 7): a band on the track around the take-off point of the open
// approach, as long as the clean tier of the window is in metres at the frozen approach speed, lit by where the
// synchronised clock stands against t0 — so that a rider sees WHEN to tap before the take-off, not only that an
// approach is open. Pure: the game computes the marker of every frame from the shared window source
// (ApproachWindow) and the approach the server announced; the arena draws it. No three.js here.
import type { TakeoffWindow } from '@open-jumps/shared';

/**
 * Where the clock stands against the take-off moment, by the window of the moment (d = toServer(now) − t0):
 * - 'approach': d < −cleanMs — on the way, the marker an outline;
 * - 'clean': cleanMs ≥ |d| > perfectMs — inside the clean tier, bright;
 * - 'perfect': |d| ≤ perfectMs — inside the perfect tier, brighter;
 * - 'late': d > cleanMs while the approach is still undecided — the marker goes dark ("late").
 * The bounds are inclusive exactly as the judge's tiers are (a distance equal to the half-width is inside it).
 * Without a measured clock or without a speed the state is 'approach' (an outline only).
 */
export type MarkerState = 'approach' | 'clean' | 'perfect' | 'late';

/** The own horse's take-off marker in one frame (SceneFrame.takeoff). */
export interface TakeoffMarker {
  /** The fence of the open approach (1-based). */
  fence: number;
  /** The take-off point along the track, metres: the fence's distanceM (pointAt(track, distanceM) places it). */
  distanceM: number;
  state: MarkerState;
  /**
   * Half-lengths of the band along the track, metres: cleanMs(at) / 1000 × speedMps and perfectMs(at) / 1000 ×
   * speedMps, with the window of the moment (a gear change after the approach opened changes cleanMs) and the speed
   * frozen when it opened (it never changes, as on the server). The band is twice as long. Null without a speed.
   */
  cleanHalfM: number | null;
  perfectHalfM: number | null;
}

/** A speed the band can be measured with: a finite number above 0. */
const hasSpeed = (speedMps: number | null): speedMps is number => speedMps !== null && Number.isFinite(speedMps) && speedMps > 0;

/** The band's half-lengths in metres for a window and the frozen approach speed; null when there is no speed (null, not finite, ≤ 0). */
export function markerHalfLengths(window: TakeoffWindow, speedMps: number | null): { cleanHalfM: number; perfectHalfM: number } | null {
  if (!hasSpeed(speedMps)) return null;
  return { cleanHalfM: (window.cleanMs / 1000) * speedMps, perfectHalfM: (window.perfectMs / 1000) * speedMps };
}

/**
 * The state of the marker at server time `serverNow` (toServer of the frame's device time; null while the clock is
 * not measured) for an approach with take-off moment t0, the window of the moment and the frozen speed (null: none).
 */
export function markerState(serverNow: number | null, t0: number, window: TakeoffWindow, speedMps: number | null): MarkerState {
  if (serverNow === null || !hasSpeed(speedMps)) return 'approach';
  const d = serverNow - t0;
  if (d < -window.cleanMs) return 'approach';
  if (Math.abs(d) <= window.perfectMs) return 'perfect';
  if (d <= window.cleanMs) return 'clean';
  return 'late';
}
