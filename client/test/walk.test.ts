// The course walk (reconocimiento, plan 1.7): every fence in order with its type as a term, the class height,
// the distance from the previous take-off point (from the start line for fence 1), the turn before it, and the
// time allowed and limit from the shared course rules; the fly-over focuses on one fence after another. K1.1
// step 4: the map of the route — the track, the fences where the arena stands them, the turn arrows, start and
// finish — fitted into a box (walkMap).
import { clubCourse, courseTimes, type CourseSpec } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { buildTrack, fencePose, pointAt } from '../src/scene/track.js';
import { WALK_MAP, walkMap, type MapBox, type MapPoint, type WalkMap } from '../src/walk/walkMap.js';
import { walkFocus, walkModel } from '../src/walk/walkModel.js';

const course: CourseSpec = {
  id: 'walk',
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

describe('walkModel', () => {
  it('is titled with the term in both locales', () => {
    expect(walkModel(course, 70, 'en').title).toBe('reconocimiento');
    expect(walkModel(course, 70, 'es').title).toBe('reconocimiento');
  });

  it('lists the fences in course order', () => {
    expect(walkModel(course, 70, 'en').fences.map((fence) => fence.number)).toEqual([1, 2, 3]);
  });

  it('fence 1: type, the class height, the distance from the start, no turn', () => {
    const [first] = walkModel(course, 70, 'en').fences;
    expect(first).toEqual({
      number: 1,
      typeText: 'vertical',
      heightCm: 70,
      distanceFromPreviousM: 30,
      turnBefore: null,
      text: 'Fence 1: vertical, 70 cm',
      detail: '30 m from the previous',
    });
  });

  it('fence 2: an oxer as a term, the distance from fence 1, the turn that lies between them', () => {
    const [, second] = walkModel(course, 70, 'en').fences;
    expect(second).toEqual({
      number: 2,
      typeText: 'óxer',
      heightCm: 70,
      distanceFromPreviousM: 30,
      turnBefore: 'left',
      text: 'Fence 2: óxer, 70 cm',
      detail: '30 m from the previous · turn left before it',
    });
  });

  it('fence 3: the distance from fence 2, no turn', () => {
    const [, , third] = walkModel(course, 70, 'en').fences;
    expect(third?.distanceFromPreviousM).toBe(40);
    expect(third?.turnBefore).toBeNull();
    expect(third?.text).toBe('Fence 3: vertical, 70 cm');
    expect(third?.detail).toBe('40 m from the previous');
  });

  it('a right turn is named as such', () => {
    const rightTurn: CourseSpec = { ...course, turns: [{ distanceM: 45, direction: 'right' }] };
    const [, second] = walkModel(rightTurn, 70, 'en').fences;
    expect(second?.turnBefore).toBe('right');
    expect(second?.detail).toBe('30 m from the previous · turn right before it');
    expect(walkModel(rightTurn, 70, 'es').fences[1]?.detail).toBe('a 30 m del anterior · gira a la derecha antes');
  });

  it('every fence stands at the class height', () => {
    for (const fence of walkModel(course, 80, 'en').fences) expect(fence.heightCm).toBe(80);
    expect(walkModel(course, 80, 'en').fences[0]?.text).toBe('Fence 1: vertical, 80 cm');
  });

  it('length, time allowed and limit come from the shared course rules', () => {
    const model = walkModel(course, 70, 'en');
    expect(model.lengthM).toBe(120);
    expect(model.allowedSec).toBe(24);
    expect(model.limitSec).toBe(48);
    expect({ allowedSec: model.allowedSec, limitSec: model.limitSec }).toEqual(courseTimes(course));
    expect(model.timeText).toBe('Time allowed 24 s · limit 48 s');
  });

  it('Spanish: the terms stay, the rest is translated', () => {
    const model = walkModel(course, 70, 'es');
    expect(model.fences[1]?.text).toBe('Salto 2: óxer, 70 cm');
    expect(model.fences[1]?.detail).toBe('a 30 m del anterior · gira a la izquierda antes');
    expect(model.fences[0]?.detail).toBe('a 30 m del anterior');
    expect(model.timeText).toBe('Tiempo concedido 24 s · límite 48 s');
  });
});

describe('walkFocus', () => {
  it('gives each fence an equal share of the walk', () => {
    expect(walkFocus(10_000, 3, 0)).toBe(1);
    expect(walkFocus(10_000, 3, 3_400)).toBe(2);
    expect(walkFocus(10_000, 3, 9_999)).toBe(3);
  });

  it('stays on the last fence from the end of the walk onwards', () => {
    expect(walkFocus(10_000, 3, 10_000)).toBe(3);
    expect(walkFocus(10_000, 3, 25_000)).toBe(3);
  });

  it('stays on the first fence before the walk starts', () => {
    expect(walkFocus(10_000, 3, -1)).toBe(1);
  });

  it('a single fence is the focus throughout', () => {
    expect(walkFocus(10_000, 1, 5_000)).toBe(1);
  });
});

// ---- K1.1 step 4: the map of the route ----------------------------------------------------------------------

/** Three fences with a left turn between 1 and 2 and a right turn between 2 and 3. */
const bothWays: CourseSpec = {
  id: 'both-ways',
  version: 1,
  lengthM: 130,
  speedMPerMin: 300,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 64, type: 'oxer' },
    { number: 3, distanceM: 110, type: 'vertical' },
  ],
  turns: [
    { distanceM: 80, direction: 'right' },
    { distanceM: 45, direction: 'left' },
  ],
};

const close = (a: MapPoint, b: MapPoint, eps = 1e-6): boolean => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
const distance = (a: MapPoint, b: MapPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Every point the map draws. */
const drawn = (map: WalkMap): MapPoint[] => [...map.path, ...map.fences.map((f) => f.at), ...map.turns.map((t) => t.at), map.start, map.finish];

/** The path point nearest to a map point (its index). */
function nearestIndex(map: WalkMap, point: MapPoint): number {
  let best = 0;
  map.path.forEach((p, i) => {
    if (distance(p, point) < distance(map.path[best] ?? p, point)) best = i;
  });
  return best;
}

/**
 * How the drawn path turns around a point (the map's y runs downwards): the cross product of the direction before
 * and after it. Seen from above with y down, a left turn is counter-clockwise on the screen — a negative cross.
 */
function turnSense(map: WalkMap, point: MapPoint, spanM = 12): 'left' | 'right' {
  const i = nearestIndex(map, point);
  const step = Math.max(1, Math.round(spanM)); // the path is sampled at least every metre
  const before = map.path[Math.max(0, i - step)];
  const at = map.path[i];
  const after = map.path[Math.min(map.path.length - 1, i + step)];
  if (!before || !at || !after) throw new Error('the path is too short around the point');
  const d1 = { x: at.x - before.x, y: at.y - before.y };
  const d2 = { x: after.x - at.x, y: after.y - at.y };
  return d1.x * d2.y - d1.y * d2.x < 0 ? 'left' : 'right';
}

describe('walkMap (K1.1 step 4)', () => {
  it('one marker per fence, in course order, each where the arena stands the fence: the projection of fencePose', () => {
    const map = walkMap(bothWays);
    const track = buildTrack(bothWays);
    expect(map.fences.map((f) => f.number)).toEqual([1, 2, 3]);
    for (const fence of map.fences) {
      const pose = fencePose(track, bothWays, fence.number);
      expect(close(fence.at, map.project(pose)), `fence ${fence.number}`).toBe(true);
      expect(fence.heading).toBeCloseTo(pose.heading, 9);
    }
  });

  it('negative: a fence marker is not at the take-off point — the 1.5 m to the rail comes from fencePose, not from a copy', () => {
    const map = walkMap(bothWays);
    const track = buildTrack(bothWays);
    const takeoff = map.project(pointAt(track, 30));
    const first = map.fences[0];
    if (!first) throw new Error('no fence on the map');
    expect(distance(first.at, takeoff)).toBeCloseTo(1.5 * map.scale, 6);
  });

  it('one arrow per turn point, in route order, at the turn point, pointing the course\'s way', () => {
    const map = walkMap(bothWays);
    const track = buildTrack(bothWays);
    expect(map.turns.map((t) => [t.distanceM, t.direction])).toEqual([
      [45, 'left'],
      [80, 'right'],
    ]);
    for (const turn of map.turns) expect(close(turn.at, map.project(pointAt(track, turn.distanceM))), String(turn.distanceM)).toBe(true);
  });

  it('the drawn track itself turns the way the arrow says, seen from above (a left turn is a left turn on the map)', () => {
    const map = walkMap(bothWays);
    for (const turn of map.turns) expect(turnSense(map, turn.at), String(turn.distanceM)).toBe(turn.direction);
  });

  it('the path follows the track from start to finish, sampled at most every metre', () => {
    const map = walkMap(bothWays);
    const track = buildTrack(bothWays);
    expect(close(map.path[0] ?? { x: Number.NaN, y: 0 }, map.project(pointAt(track, 0)))).toBe(true);
    expect(close(map.path.at(-1) ?? { x: Number.NaN, y: 0 }, map.project(pointAt(track, bothWays.lengthM)))).toBe(true);
    expect(map.path.length).toBeGreaterThanOrEqual(bothWays.lengthM / WALK_MAP.maxStepM + 1);
    for (let i = 1; i < map.path.length; i += 1) {
      const a = map.path[i - 1];
      const b = map.path[i];
      if (!a || !b) throw new Error('a hole in the path');
      expect(distance(a, b)).toBeLessThanOrEqual(WALK_MAP.maxStepM * map.scale + 1e-9);
    }
  });

  it('the start is the beginning of the path and the finish its end', () => {
    const map = walkMap(bothWays);
    expect(close(map.start, map.path[0] ?? { x: Number.NaN, y: 0 })).toBe(true);
    expect(close(map.finish, map.path.at(-1) ?? { x: Number.NaN, y: 0 })).toBe(true);
    expect(distance(map.start, map.finish)).toBeGreaterThan(0);
  });

  it('one uniform scale: distances on the map are the ground distances times scale, along both axes', () => {
    const map = walkMap(bothWays);
    const a = map.project({ x: 0, z: 0 });
    expect(distance(a, map.project({ x: 10, z: 0 }))).toBeCloseTo(10 * map.scale, 9);
    expect(distance(a, map.project({ x: 0, z: 10 }))).toBeCloseTo(10 * map.scale, 9);
    expect(map.project({ x: 10, z: 0 }).x).toBeGreaterThan(a.x);
    expect(map.project({ x: 0, z: 10 }).y).toBeGreaterThan(a.y);
  });

  it.each([
    { name: 'the default box', box: WALK_MAP.box },
    { name: 'a narrow panel', box: { width: 180, height: 320, margin: 12 } },
    { name: 'a wide strip', box: { width: 600, height: 120, margin: 8 } },
  ] as { name: string; box: MapBox }[])('everything drawn lies inside the margins of $name and fills it along one axis', ({ box }) => {
    const map = walkMap(bothWays, box);
    expect(map.box).toEqual(box);
    const points = drawn(map);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(box.margin - 1e-6);
      expect(p.x).toBeLessThanOrEqual(box.width - box.margin + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(box.margin - 1e-6);
      expect(p.y).toBeLessThanOrEqual(box.height - box.margin + 1e-6);
    }
    const spanX = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
    const spanY = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));
    const fillsX = Math.abs(spanX - (box.width - 2 * box.margin)) <= 1e-6;
    const fillsY = Math.abs(spanY - (box.height - 2 * box.margin)) <= 1e-6;
    expect(fillsX || fillsY).toBe(true);
  });

  it('a generated club course of eight fences: eight markers in order, every turn with its direction, all inside the box', () => {
    const club = clubCourse('walk-map', 8);
    const map = walkMap(club);
    expect(map.fences.map((f) => f.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(map.turns.map((t) => t.direction)).toEqual([...club.turns].sort((a, b) => a.distanceM - b.distanceM).map((t) => t.direction));
    for (const turn of map.turns) expect(turnSense(map, turn.at), String(turn.distanceM)).toBe(turn.direction);
    for (const p of drawn(map)) {
      expect(p.x).toBeGreaterThanOrEqual(WALK_MAP.box.margin - 1e-6);
      expect(p.y).toBeLessThanOrEqual(WALK_MAP.box.height - WALK_MAP.box.margin + 1e-6);
    }
  });

  it('a course without turns has no arrows and a straight path', () => {
    const map = walkMap(course.turns.length === 0 ? course : { ...course, turns: [] });
    expect(map.turns).toEqual([]);
    const first = map.path[0];
    const last = map.path.at(-1);
    if (!first || !last) throw new Error('no path');
    for (const p of map.path) expect(Math.abs((p.x - first.x) * (last.y - first.y) - (p.y - first.y) * (last.x - first.x))).toBeLessThan(1e-6);
  });
});
