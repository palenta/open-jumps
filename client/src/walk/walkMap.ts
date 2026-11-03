// The course map of the walk (K1.1 step 4): the course seen from above, drawn by the walk screen as an SVG — the
// track as a polyline, every fence where the arena stands it, an arrow at every turn point pointing the way the
// course turns, the start and the finish — so that a rider reads the route at a glance before the round (the K1
// fly-over alone showed one fence at a time and no turns). A pure function of the CourseSpec: the geometry is the
// arena's own (track.ts — buildTrack, pointAt, fencePose), never a second copy of it.
import type { CourseSpec, TurnDirection } from '@open-jumps/shared';
import { NotImplementedError } from '../errors.js';

/** A point of the map in its own units (the SVG user space): x to the right, y downwards. */
export interface MapPoint {
  x: number;
  y: number;
}

/** The rectangle the map is fitted into, with a margin kept free on every side (map units). */
export interface MapBox {
  width: number;
  height: number;
  margin: number;
}

export interface WalkMapFence {
  /** The fence number (1-based), as in the course. */
  number: number;
  /** Where the fence stands: project(fencePose(track, course, number)) — the rail, not the take-off point. */
  at: MapPoint;
  /** The track's heading there, in the map plane (radians; the direction (cos, sin) in map x, y). */
  heading: number;
}

export interface WalkMapTurn {
  /** The way the course turns there (the course's own direction). */
  direction: TurnDirection;
  /** The turn's distance along the track (metres, as in the course). */
  distanceM: number;
  /** The turn point: project(pointAt(track, distanceM)). */
  at: MapPoint;
}

export interface WalkMap {
  box: MapBox;
  /** Map units per metre: one uniform scale for both axes (the course is never stretched). */
  scale: number;
  /**
   * The map's projection of a ground-plane point of the arena (track.ts: x right, z towards the viewer): one uniform
   * scale and an offset, x → offsetX + scale × x, z → offsetY + scale × z (no rotation, no mirror).
   */
  project(point: { x: number; z: number }): MapPoint;
  /** The track from the start (0 m) to the finish (lengthM), sampled along it at most every WALK_MAP.maxStepM metres. */
  path: MapPoint[];
  /** Every fence, in course order. */
  fences: WalkMapFence[];
  /** Every turn point, in route order (by distance). */
  turns: WalkMapTurn[];
  /** The start line (the track at 0 m) and the finish line (the track at lengthM): the first and the last point of the path. */
  start: MapPoint;
  finish: MapPoint;
}

export const WALK_MAP = {
  /** The default box: a landscape panel beside the legend. */
  box: { width: 400, height: 260, margin: 16 },
  /** The longest step between two consecutive points of the path, in metres of track. */
  maxStepM: 1,
} as const;

/**
 * The map of `course` fitted into `box`: the track from buildTrack(course) sampled with pointAt every ≤ maxStepM
 * metres, projected top-down (ground x → map x, ground z → map y, so a left turn reads as a left turn seen from
 * above) with one uniform scale and an offset chosen so that the whole drawing — path, fences, turns, start and
 * finish — lies inside the box's margins and fills it along at least one axis (the larger extent of the course
 * spans the box minus its margins). Fences come from fencePose, the single source of a fence's position (no copy of
 * its 1.5 m landing offset); turns from pointAt at their distance, with the course's direction.
 */
export function walkMap(course: CourseSpec, box: MapBox = WALK_MAP.box): WalkMap {
  void course;
  void box;
  throw new NotImplementedError('walkMap (K1.1 step 4)');
}
