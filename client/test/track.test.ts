// Plan 1.7, 2.3: the one-dimensional course laid out on the ground — straights joined by quarter-circle arcs
// centred on the turn points — so that a position in metres maps to a point and a heading, and the fences
// stand on the straights a landing offset past their take-off points.
import type { CourseSpec } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { buildTrack, fencePose, pointAt, TRACK, type Track, type TrackSegment } from '../src/scene/track.js';

const R = TRACK.turnRadiusM;
/** Arc length of one turn. */
const L = R * TRACK.turnAngleRad;
/** The rail stands this far past the take-off point. */
const LANDING_OFFSET_M = 1.5;

const course = (over: Partial<CourseSpec> = {}): CourseSpec => ({
  id: 'a',
  version: 1,
  lengthM: 120,
  speedMPerMin: 300,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 60, type: 'oxer' },
    { number: 3, distanceM: 100, type: 'vertical' },
  ],
  turns: [],
  ...over,
});

/** Course A: no turns. */
const straightCourse = course();
/** Course B: one left turn at 45 m. */
const leftCourse = course({ id: 'b', turns: [{ distanceM: 45, direction: 'left' }] });
/** Course B mirrored: one right turn at 45 m. */
const rightCourse = course({ id: 'b-right', turns: [{ distanceM: 45, direction: 'right' }] });
/** Course C: left at 45 m, right at 85 m, 150 m long. */
const twoTurnCourse = course({
  id: 'c',
  lengthM: 150,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 65, type: 'oxer' },
    { number: 3, distanceM: 105, type: 'vertical' },
  ],
  turns: [
    { distanceM: 45, direction: 'left' },
    { distanceM: 85, direction: 'right' },
  ],
});

function segment(track: Track, index: number): TrackSegment {
  const found = track.segments[index];
  if (found === undefined) throw new Error(`no segment ${index}`);
  return found;
}

function arcAt(track: Track, index: number): Extract<TrackSegment, { kind: 'arc' }> {
  const found = segment(track, index);
  if (found.kind !== 'arc') throw new Error(`segment ${index} is a ${found.kind}, not an arc`);
  return found;
}

const distance = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

describe('TRACK', () => {
  it('quarter-circle turns of 8 m radius', () => {
    expect(TRACK).toEqual({ turnAngleRad: Math.PI / 2, turnRadiusM: 8 });
  });
});

describe('buildTrack without turns', () => {
  it('is one straight segment from the origin to the finish', () => {
    const track = buildTrack(straightCourse);
    expect(track.lengthM).toBe(120);
    expect(track.segments).toEqual([{ kind: 'straight', fromM: 0, toM: 120, start: { x: 0, z: 0, heading: 0 } }]);
  });
});

describe('pointAt on a straight track', () => {
  it('starts at the origin heading +x', () => {
    const point = pointAt(buildTrack(straightCourse), 0);
    expect(point.x).toBeCloseTo(0, 6);
    expect(point.z).toBeCloseTo(0, 6);
    expect(point.heading).toBeCloseTo(0, 6);
  });

  it('moves along +x with a constant heading', () => {
    const point = pointAt(buildTrack(straightCourse), 30);
    expect(point.x).toBeCloseTo(30, 6);
    expect(point.z).toBeCloseTo(0, 6);
    expect(point.heading).toBeCloseTo(0, 6);
  });

  it('clamps a negative position to the start', () => {
    const point = pointAt(buildTrack(straightCourse), -5);
    expect(point.x).toBeCloseTo(0, 6);
    expect(point.z).toBeCloseTo(0, 6);
  });

  it('clamps a position past the finish to the finish', () => {
    const point = pointAt(buildTrack(straightCourse), 200);
    expect(point.x).toBeCloseTo(120, 6);
    expect(point.z).toBeCloseTo(0, 6);
  });
});

describe('buildTrack with one left turn at 45 m', () => {
  it('splits the track into a straight, the arc [45 − L/2, 45 + L/2] and a straight to the finish', () => {
    const track = buildTrack(leftCourse);
    expect(track.lengthM).toBe(120);
    expect(track.segments).toHaveLength(3);
    const first = segment(track, 0);
    expect(first.kind).toBe('straight');
    expect(first.fromM).toBeCloseTo(0, 6);
    expect(first.toM).toBeCloseTo(45 - L / 2, 6);
    const arc = arcAt(track, 1);
    expect(arc.fromM).toBeCloseTo(45 - L / 2, 6);
    expect(arc.toM).toBeCloseTo(45 + L / 2, 6);
    expect(arc.direction).toBe('left');
    expect(arc.startHeading).toBeCloseTo(0, 6);
    const last = segment(track, 2);
    expect(last.kind).toBe('straight');
    expect(last.fromM).toBeCloseTo(45 + L / 2, 6);
    expect(last.toM).toBeCloseTo(120, 6);
  });

  it('the arc of a left turn is centred at radius R on the left of the entry point: for heading 0 the left side is −z', () => {
    const track = buildTrack(leftCourse);
    const entry = pointAt(track, 45 - L / 2);
    const arc = arcAt(track, 1);
    expect(arc.centre.x).toBeCloseTo(entry.x, 6);
    expect(arc.centre.z).toBeCloseTo(entry.z - R, 6);
  });

  it('the heading is 0 at the entry, −π/4 halfway and −π/2 at the exit: a left turn decreases the heading', () => {
    const track = buildTrack(leftCourse);
    expect(pointAt(track, 45 - L / 2).heading).toBeCloseTo(0, 6);
    expect(pointAt(track, 45).heading).toBeCloseTo(-Math.PI / 4, 6);
    expect(pointAt(track, 45 + L / 2).heading).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('every point of the arc lies at radius R from its centre', () => {
    const track = buildTrack(leftCourse);
    const arc = arcAt(track, 1);
    for (const positionM of [arc.fromM, 42, 45, 48, arc.toM]) {
      expect(distance(pointAt(track, positionM), arc.centre)).toBeCloseTo(R, 6);
    }
  });

  it('the exit of the left turn is R further along x and R towards −z from the entry', () => {
    const track = buildTrack(leftCourse);
    const entry = pointAt(track, 45 - L / 2);
    const exit = pointAt(track, 45 + L / 2);
    expect(exit.x).toBeCloseTo(entry.x + R, 6);
    expect(exit.z).toBeCloseTo(entry.z - R, 6);
  });

  it('after the left turn the track runs towards −z with a constant heading of −π/2 and a constant x', () => {
    const track = buildTrack(leftCourse);
    const exit = pointAt(track, 45 + L / 2);
    const later = pointAt(track, 100);
    const finish = pointAt(track, 120);
    expect(later.heading).toBeCloseTo(-Math.PI / 2, 6);
    expect(finish.heading).toBeCloseTo(-Math.PI / 2, 6);
    expect(later.z).toBeLessThan(exit.z - 10);
    expect(later.x).toBeCloseTo(exit.x, 6);
    expect(finish.z).toBeCloseTo(exit.z - (120 - (45 + L / 2)), 6);
  });

  it('is continuous and keeps arc length: samples 0.5 m apart along the track are at most 0.5 m apart on the ground and never less than the chord of a 0.5 m arc', () => {
    const track = buildTrack(leftCourse);
    // The chord of a 0.5 m arc at R = 8 m is 2R·sin(0.5 / 2R) ≈ 0.49992 m; a straight step is exactly 0.5 m.
    let previous = pointAt(track, 0);
    for (let positionM = 0.5; positionM <= 120; positionM += 0.5) {
      const next = pointAt(track, positionM);
      const step = distance(previous, next);
      expect(step, `step ending at ${positionM} m`).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(step, `step ending at ${positionM} m`).toBeGreaterThanOrEqual(0.4999);
      previous = next;
    }
  });
});

describe('buildTrack with one right turn at 45 m', () => {
  it('mirrors the left turn: heading +π/2 at the exit, the centre at +z of the entry point, the track then runs towards +z', () => {
    const track = buildTrack(rightCourse);
    const entry = pointAt(track, 45 - L / 2);
    const arc = arcAt(track, 1);
    expect(arc.direction).toBe('right');
    expect(arc.centre.x).toBeCloseTo(entry.x, 6);
    expect(arc.centre.z).toBeCloseTo(entry.z + R, 6);
    expect(pointAt(track, 45).heading).toBeCloseTo(Math.PI / 4, 6);
    const exit = pointAt(track, 45 + L / 2);
    expect(exit.heading).toBeCloseTo(Math.PI / 2, 6);
    expect(exit.x).toBeCloseTo(entry.x + R, 6);
    expect(exit.z).toBeCloseTo(entry.z + R, 6);
    const later = pointAt(track, 100);
    expect(later.z).toBeGreaterThan(exit.z + 10);
    expect(later.x).toBeCloseTo(exit.x, 6);
  });
});

describe('buildTrack with a left and a right turn', () => {
  it('has five segments and the net heading is 0 again after both turns', () => {
    const track = buildTrack(twoTurnCourse);
    expect(track.lengthM).toBe(150);
    expect(track.segments.map((s) => s.kind)).toEqual(['straight', 'arc', 'straight', 'arc', 'straight']);
    expect(pointAt(track, 85 + L / 2).heading).toBeCloseTo(0, 6);
    expect(pointAt(track, 150).heading).toBeCloseTo(0, 6);
    expect(pointAt(track, 150).x).toBeGreaterThan(pointAt(track, 85 + L / 2).x + 10);
  });

  it('the second arc is centred on the right of the heading at its entry (heading −π/2: the right side is +x)', () => {
    const track = buildTrack(twoTurnCourse);
    const entry = pointAt(track, 85 - L / 2);
    expect(entry.heading).toBeCloseTo(-Math.PI / 2, 6);
    const arc = arcAt(track, 3);
    expect(arc.direction).toBe('right');
    expect(arc.startHeading).toBeCloseTo(-Math.PI / 2, 6);
    expect(arc.centre.x).toBeCloseTo(entry.x + R, 6);
    expect(arc.centre.z).toBeCloseTo(entry.z, 6);
  });
});

describe('fencePose', () => {
  it('stands the fence on its straight at the take-off distance plus the 1.5 m landing offset, facing along the track', () => {
    const track = buildTrack(leftCourse);
    const pose = fencePose(track, leftCourse, 2);
    const expected = pointAt(track, 60 + LANDING_OFFSET_M);
    expect(pose.x).toBeCloseTo(expected.x, 6);
    expect(pose.z).toBeCloseTo(expected.z, 6);
    expect(pose.heading).toBeCloseTo(expected.heading, 6);
    expect(pose.heading).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('a fence before the turn faces +x', () => {
    const track = buildTrack(leftCourse);
    const pose = fencePose(track, leftCourse, 1);
    expect(pose.x).toBeCloseTo(30 + LANDING_OFFSET_M, 6);
    expect(pose.z).toBeCloseTo(0, 6);
    expect(pose.heading).toBeCloseTo(0, 6);
  });

  it('throws a RangeError for a fence number the course does not have', () => {
    const track = buildTrack(straightCourse);
    expect(() => fencePose(track, straightCourse, 9)).toThrow(RangeError);
  });
});
