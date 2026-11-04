// The course map of the walk (K1.1 step 4): the course seen from above, drawn by the walk screen as an SVG — the
// track as a polyline, every fence where the arena stands it, an arrow at every turn point pointing the way the
// course turns, the start and the finish — so that a rider reads the route at a glance before the round (the K1
// fly-over alone showed one fence at a time and no turns). A pure function of the CourseSpec: the geometry is the
// arena's own (track.ts — buildTrack, pointAt, fencePose), never a second copy of it.
import type { CourseSpec, TurnDirection } from '@open-jumps/shared';
import { buildTrack, fencePose, pointAt, type TrackPoint } from '../scene/track.js';

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
  const track = buildTrack(course);
  const steps = Math.max(1, Math.ceil(track.lengthM / WALK_MAP.maxStepM));
  const ground: TrackPoint[] = [];
  for (let i = 0; i <= steps; i += 1) ground.push(pointAt(track, (i / steps) * track.lengthM));
  const poses = course.fences.map((fence) => ({ number: fence.number, pose: fencePose(track, course, fence.number) }));
  const turns = [...course.turns].sort((a, b) => a.distanceM - b.distanceM).map((turn) => ({ turn, point: pointAt(track, turn.distanceM) }));

  // The extent of everything drawn, on the ground; the larger ratio of it to the box decides the one scale.
  const all = [...ground, ...poses.map((p) => p.pose), ...turns.map((t) => t.point)];
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minZ = Math.min(...all.map((p) => p.z));
  const maxZ = Math.max(...all.map((p) => p.z));
  const innerW = box.width - 2 * box.margin;
  const innerH = box.height - 2 * box.margin;
  const fits = [maxX - minX > 0 ? innerW / (maxX - minX) : Infinity, maxZ - minZ > 0 ? innerH / (maxZ - minZ) : Infinity];
  const fitted = Math.min(...fits);
  const scale = Number.isFinite(fitted) ? fitted : 1;
  // Centred in the box along the axis it does not fill.
  const offsetX = box.margin + (innerW - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetY = box.margin + (innerH - (maxZ - minZ) * scale) / 2 - minZ * scale;
  const project = (point: { x: number; z: number }): MapPoint => ({ x: offsetX + scale * point.x, y: offsetY + scale * point.z });

  const path = ground.map(project);
  return {
    box,
    scale,
    project,
    path,
    fences: poses.map(({ number, pose }) => ({ number, at: project(pose), heading: pose.heading })),
    turns: turns.map(({ turn, point }) => ({ direction: turn.direction, distanceM: turn.distanceM, at: project(point) })),
    start: path[0] ?? project(pointAt(track, 0)),
    finish: path[path.length - 1] ?? project(pointAt(track, track.lengthM)),
  };
}
