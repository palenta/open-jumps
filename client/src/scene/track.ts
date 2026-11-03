// The arena track (plan 1.7, 2.3): the server's course is one-dimensional (a position in metres along the
// track); the scene lays it out on the ground as straights joined by 90° arcs at the turn points, so a
// position maps to a point and a heading. Placeholder geometry until the real arenas (phase 7).
import type { CourseSpec } from '@open-jumps/shared';

export const TRACK = {
  /** Every turn point is a quarter-circle arc centred on the turn's distance. */
  turnAngleRad: Math.PI / 2,
  turnRadiusM: 8,
} as const;

/** Ground-plane coordinates (Three.js: x right, z towards the viewer, y up); heading in radians, direction = (cos, sin) in (x, z). */
export interface TrackPoint {
  x: number;
  z: number;
  heading: number;
}

export type TrackSegment =
  | { kind: 'straight'; fromM: number; toM: number; start: TrackPoint }
  | { kind: 'arc'; fromM: number; toM: number; centre: { x: number; z: number }; direction: 'left' | 'right'; startHeading: number };

export interface Track {
  lengthM: number;
  segments: TrackSegment[];
}

/** The rail stands this far past the take-off point. */
const LANDING_OFFSET_M = 1.5;

/** Straights shorter than this (two arcs meeting, a turn at the start) are not worth a segment. */
const EPSILON_M = 1e-9;

/** A heading's left-hand side in the (x, z) plane: for heading 0 (+x) the left is −z. */
const leftOf = (heading: number): { x: number; z: number } => ({ x: Math.sin(heading), z: -Math.cos(heading) });

/** The point on an arc at heading `heading`, radius R from the centre, on the side the turn keeps it. */
function arcPoint(centre: { x: number; z: number }, direction: 'left' | 'right', heading: number): TrackPoint {
  const R = TRACK.turnRadiusM;
  const left = leftOf(heading);
  // A left turn keeps the centre on its left, so the point sits to the right of the centre, and vice versa.
  const sign = direction === 'left' ? -1 : 1;
  return { x: centre.x + sign * R * left.x, z: centre.z + sign * R * left.z, heading };
}

/**
 * The track starts at the origin heading +x. A turn at distance d occupies the arc [d − L/2, d + L/2] with
 * L = radius × angle; a left turn decreases the heading (counter-clockwise seen from above), a right turn
 * increases it. Straights fill the rest; the finish is at lengthM.
 */
export function buildTrack(course: CourseSpec): Track {
  const R = TRACK.turnRadiusM;
  const arcLength = R * TRACK.turnAngleRad;
  const segments: TrackSegment[] = [];

  let cursor: TrackPoint = { x: 0, z: 0, heading: 0 };
  let cursorM = 0;

  const straightTo = (toM: number): void => {
    if (toM - cursorM <= EPSILON_M) return;
    segments.push({ kind: 'straight', fromM: cursorM, toM, start: { ...cursor } });
    const run = toM - cursorM;
    cursor = { x: cursor.x + run * Math.cos(cursor.heading), z: cursor.z + run * Math.sin(cursor.heading), heading: cursor.heading };
    cursorM = toM;
  };

  const turns = [...course.turns].sort((a, b) => a.distanceM - b.distanceM);
  for (const turn of turns) {
    const fromM = turn.distanceM - arcLength / 2;
    const toM = turn.distanceM + arcLength / 2;
    straightTo(fromM);
    const left = leftOf(cursor.heading);
    const sign = turn.direction === 'left' ? 1 : -1;
    const centre = { x: cursor.x + sign * R * left.x, z: cursor.z + sign * R * left.z };
    segments.push({ kind: 'arc', fromM, toM, centre, direction: turn.direction, startHeading: cursor.heading });
    const exitHeading = cursor.heading + (turn.direction === 'left' ? -1 : 1) * TRACK.turnAngleRad;
    cursor = arcPoint(centre, turn.direction, exitHeading);
    cursorM = toM;
  }
  straightTo(course.lengthM);

  return { lengthM: course.lengthM, segments };
}

/** The point and heading at positionM (clamped to [0, lengthM]). */
export function pointAt(track: Track, positionM: number): TrackPoint {
  const pos = Math.min(Math.max(positionM, 0), track.lengthM);
  const segment = track.segments.find((s) => pos <= s.toM) ?? track.segments[track.segments.length - 1];
  if (segment === undefined) return { x: 0, z: 0, heading: 0 };

  const along = Math.max(0, pos - segment.fromM);
  if (segment.kind === 'straight') {
    const { start } = segment;
    return { x: start.x + along * Math.cos(start.heading), z: start.z + along * Math.sin(start.heading), heading: start.heading };
  }
  const turned = along / TRACK.turnRadiusM;
  const heading = segment.startHeading + (segment.direction === 'left' ? -turned : turned);
  return arcPoint(segment.centre, segment.direction, heading);
}

/** Where fence `number` stands: at its take-off distance plus the landing offset (the rail is ~1.5 m past the take-off point). */
export function fencePose(track: Track, course: CourseSpec, fenceNumber: number): TrackPoint {
  const fence = course.fences.find((f) => f.number === fenceNumber);
  if (fence === undefined) throw new RangeError(`course ${course.id} has no fence ${fenceNumber}`);
  return pointAt(track, fence.distanceM + LANDING_OFFSET_M);
}
