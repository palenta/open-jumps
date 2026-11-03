// @vitest-environment happy-dom
// The Three.js arena's housekeeping (audit K1 r1 #9): a new course, a horse that leaves the scene and the scene's
// own disposal free every geometry, every unique material and every texture they created — exactly once — so that
// "again" after "again" on a phone does not pile up GPU buffers. No WebGL here (happy-dom has none): the renderer
// stays null and the scene graph alone is exercised. Every resource is followed by instance: three.js geometries
// set their attributes, materials their values and canvas textures their update flag when they are built, and
// dispose() is counted per instance — so the accounting holds whatever the arena builds (K1.1 step 7 adds the
// take-off markers: a weak mark at every fence and the bright band of the own approach, freed with the course).
// K1.1 steps 6–7 also pin the band itself: its half-lengths from the shared window at the frozen approach speed,
// and its state against t0.
import * as THREE from 'three';
import { RANKED_NO_ASSISTS, type CourseSpec, type TakeoffWindow } from '@open-jumps/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneFrame } from '../src/app/game.js';
import { ApproachWindow } from '../src/round/approachWindow.js';
import { createArenaScene } from '../src/scene/arena.js';
import { markerHalfLengths, markerState, type TakeoffMarker } from '../src/scene/takeoffMarker.js';

const oneFence: CourseSpec = { id: 'a', version: 1, lengthM: 50, speedMPerMin: 250, fences: [{ number: 1, distanceM: 30, type: 'vertical' }], turns: [] };
const twoFences: CourseSpec = {
  id: 'b',
  version: 1,
  lengthM: 80,
  speedMPerMin: 300,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 60, type: 'oxer' },
  ],
  turns: [{ distanceM: 45, direction: 'left' }],
};

const frame = (riders: string[], takeoff: TakeoffMarker | null = null): SceneFrame => ({
  phase: 'riding',
  riders: riders.map((id, index) => ({ id, point: { x: index * 3, z: 0, heading: 0 }, isOwn: index === 0, label: id })),
  camera: { position: { x: -10, y: 5, z: 0 }, target: { x: 0, y: 1, z: 0 } },
  focusFence: null,
  takeoff,
  ownMode: riders.length > 0 ? 'patch' : null,
});

/** The band of fence 1 at 70 cm in collected canter at 5 m/s: 157.5 ms → 0.7875 m, 58.5 ms → 0.2925 m. */
const band = (state: TakeoffMarker['state'], over: Partial<TakeoffMarker> = {}): TakeoffMarker => ({
  fence: 1,
  distanceM: 30,
  state,
  cleanHalfM: 0.7875,
  perfectHalfM: 0.2925,
  ...over,
});

type Resource = THREE.BufferGeometry | THREE.Material | THREE.Texture;

/** What the tests read of a spy: the `this` of every call. */
type Calls = { mock: { contexts: unknown[] } };

let built: Calls[] = [];
let freed: Calls[] = [];

beforeEach(() => {
  built = [
    vi.spyOn(THREE.BufferGeometry.prototype, 'setAttribute'),
    vi.spyOn(THREE.Material.prototype, 'setValues'),
    vi.spyOn(THREE.Texture.prototype, 'needsUpdate', 'set'),
  ];
  freed = [
    vi.spyOn(THREE.BufferGeometry.prototype, 'dispose'),
    vi.spyOn(THREE.Material.prototype, 'dispose'),
    vi.spyOn(THREE.Texture.prototype, 'dispose'),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every resource built so far (each instance once). */
const created = (): Set<Resource> => new Set(built.flatMap((spy) => spy.mock.contexts as Resource[]));

/** How many times each resource was disposed so far. */
function disposals(): Map<Resource, number> {
  const counts = new Map<Resource, number>();
  for (const spy of freed) for (const context of spy.mock.contexts as Resource[]) counts.set(context, (counts.get(context) ?? 0) + 1);
  return counts;
}

/** The resources of `all` not in `before`. */
const since = (before: Set<Resource>, all: Set<Resource> = created()): Resource[] => [...all].filter((resource) => !before.has(resource));

/** Resources built and not freed yet. */
const live = (): number => [...created()].filter((resource) => !disposals().has(resource)).length;

describe('the arena frees what it built (audit K1 r1 #9)', () => {
  it('a new class-course frees every resource the previous course built — its horses and markers included — exactly once, and nothing of the next course', () => {
    const scene = createArenaScene();
    const beforeCourse = created();
    scene.setCourse(oneFence);
    scene.render(frame(['host', 'ana'], band('clean')));
    const first = since(beforeCourse);
    expect(first.length).toBeGreaterThan(0);
    expect([...disposals().keys()]).toEqual([]);
    scene.setCourse(twoFences);
    const counts = disposals();
    for (const resource of first) expect(counts.get(resource), resource.constructor.name).toBe(1);
    const next = since(new Set([...beforeCourse, ...first]));
    expect(next.length).toBeGreaterThan(0);
    for (const resource of next) expect(counts.has(resource), `${resource.constructor.name} of the next course`).toBe(false);
  });

  it('leaving the room (setCourse null) frees the course, its markers and the horses of the heat, exactly once; a second null frees nothing more', () => {
    const scene = createArenaScene();
    const beforeCourse = created();
    scene.setCourse(oneFence);
    scene.render(frame(['host', 'ana'], band('perfect')));
    const sizeAfterOne = created().size;
    scene.render(frame(['host', 'ana'], band('perfect'))); // the same frame again re-uses everything: nothing new is built
    expect(created().size).toBe(sizeAfterOne);
    const course = since(beforeCourse);
    scene.setCourse(null);
    const counts = disposals();
    for (const resource of course) expect(counts.get(resource), resource.constructor.name).toBe(1);
    scene.setCourse(null);
    expect([...disposals().values()].reduce((a, b) => a + b, 0)).toBe([...counts.values()].reduce((a, b) => a + b, 0));
  });

  it('dispose() frees everything it ever built — course, markers, horses and the ground — exactly once', () => {
    const before = created();
    const scene = createArenaScene();
    scene.setCourse(twoFences);
    scene.render(frame(['host'], band('approach')));
    const everything = since(before);
    scene.dispose();
    const counts = disposals();
    for (const resource of everything) expect(counts.get(resource), resource.constructor.name).toBe(1);
  });

  it('a hundred frames with the band changing state and length leave no more live resources than the first one did', () => {
    const scene = createArenaScene();
    scene.setCourse(twoFences);
    scene.render(frame(['host'], band('approach')));
    const steady = live();
    const states: TakeoffMarker['state'][] = ['approach', 'clean', 'perfect', 'clean', 'late'];
    for (let i = 0; i < 100; i += 1) {
      const state = states[i % states.length] ?? 'approach';
      scene.render(frame(['host'], band(state, { cleanHalfM: 0.7875 / (1 + (i % 2)), perfectHalfM: 0.2925 / (1 + (i % 2)) })));
    }
    scene.render(frame(['host'], null));
    scene.render(frame(['host'], band('clean')));
    expect(live()).toBeLessThanOrEqual(steady);
  });
});

describe('the take-off markers in the arena (K1.1 step 7)', () => {
  it('no course: no markers', () => {
    expect(createArenaScene().markers()).toEqual([]);
  });

  it('a weak mark at every fence of the course, always — also before any approach', () => {
    const scene = createArenaScene();
    scene.setCourse(twoFences);
    expect(scene.markers()).toEqual([
      { fence: 1, kind: 'weak', state: null, lengthM: null },
      { fence: 2, kind: 'weak', state: null, lengthM: null },
    ]);
    scene.render(frame(['host']));
    expect(scene.markers()).toHaveLength(2);
  });

  it('the own approach adds the bright band at its fence, in its state, twice the clean half-length long', () => {
    const scene = createArenaScene();
    scene.setCourse(twoFences);
    scene.render(frame(['host'], band('clean')));
    expect(scene.markers()).toEqual([
      { fence: 1, kind: 'weak', state: null, lengthM: null },
      { fence: 2, kind: 'weak', state: null, lengthM: null },
      { fence: 1, kind: 'bright', state: 'clean', lengthM: 2 * 0.7875 },
    ]);
    scene.render(frame(['host'], band('perfect', { fence: 2, distanceM: 60 })));
    expect(scene.markers().filter((m) => m.kind === 'bright')).toEqual([{ fence: 2, kind: 'bright', state: 'perfect', lengthM: 2 * 0.7875 }]);
  });

  it('a band without speed is an outline: state approach, no length', () => {
    const scene = createArenaScene();
    scene.setCourse(oneFence);
    scene.render(frame(['host'], band('approach', { cleanHalfM: null, perfectHalfM: null })));
    expect(scene.markers().filter((m) => m.kind === 'bright')).toEqual([{ fence: 1, kind: 'bright', state: 'approach', lengthM: null }]);
  });

  it('negative: after the verdict (a frame without a takeoff marker) no bright band is left, the weak marks stay', () => {
    const scene = createArenaScene();
    scene.setCourse(oneFence);
    scene.render(frame(['host'], band('late')));
    scene.render(frame(['host'], null));
    expect(scene.markers()).toEqual([{ fence: 1, kind: 'weak', state: null, lengthM: null }]);
  });

  it('a new course replaces the marks with its own; leaving the room removes them all', () => {
    const scene = createArenaScene();
    scene.setCourse(twoFences);
    scene.render(frame(['host'], band('clean')));
    scene.setCourse(oneFence);
    expect(scene.markers()).toEqual([{ fence: 1, kind: 'weak', state: null, lengthM: null }]);
    scene.setCourse(null);
    expect(scene.markers()).toEqual([]);
  });
});

describe('the band\'s length: the shared window at the frozen speed (K1.1 step 7, matrix row 13)', () => {
  /** The rider's approach at 70 cm, opened at 5000 in collected canter: the speed is frozen at 5 m/s from then on. */
  const SPEED = 5;
  const window70 = (): ApproachWindow => new ApproachWindow({ heightClass: 70, rules: RANKED_NO_ASSISTS });

  it('collected at 5 m/s: half-lengths cleanMs / 1000 × 5 = 0.7875 m and perfectMs / 1000 × 5 = 0.2925 m', () => {
    const window = window70();
    const halves = markerHalfLengths(window.windowAt(5_000), SPEED);
    expect(halves?.cleanHalfM).toBeCloseTo(0.7875, 9);
    expect(halves?.perfectHalfM).toBeCloseTo(0.2925, 9);
  });

  it('gallop after the approach opened: cleanMs of gallop (× 0.5) at the SAME 5 m/s — never at the gallop\'s 7 m/s', () => {
    const window = window70();
    window.setGear('gallop', 5_200);
    const halves = markerHalfLengths(window.windowAt(5_300), SPEED);
    expect(halves?.cleanHalfM).toBeCloseTo(0.39375, 9);
    expect(halves?.perfectHalfM).toBeCloseTo(0.14625, 9);
    expect(halves?.cleanHalfM).not.toBeCloseTo((78.75 / 1000) * 7, 3);
  });

  it('back from gallop to collected after the approach opened: the whole band again', () => {
    const window = window70();
    window.setGear('gallop', 5_200);
    window.setGear('collected', 5_600);
    expect(markerHalfLengths(window.windowAt(5_700), SPEED)?.cleanHalfM).toBeCloseTo(0.7875, 9);
    expect(markerHalfLengths(window.windowAt(5_400), SPEED)?.cleanHalfM).toBeCloseTo(0.39375, 9); // the moment still in gallop
  });

  it('a sharp line (× 0.8) and a hard turn (× 0.7) shorten it like the window', () => {
    const window = window70();
    window.setLine('angle');
    expect(markerHalfLengths(window.windowAt(5_000), SPEED)?.cleanHalfM).toBeCloseTo(0.7875 * 0.8, 9);
    window.setHardTurn(true);
    expect(markerHalfLengths(window.windowAt(5_000), SPEED)?.cleanHalfM).toBeCloseTo(0.7875 * 0.8 * 0.7, 9);
    window.setLine('center');
    expect(markerHalfLengths(window.windowAt(5_000), SPEED)?.perfectHalfM).toBeCloseTo(0.2925 * 0.7, 9);
  });

  it('negative: no speed — null, 0, negative, NaN or infinite — no band length at all', () => {
    const tiers: TakeoffWindow = { cleanMs: 157.5, perfectMs: 58.5 };
    for (const speed of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(markerHalfLengths(tiers, speed), String(speed)).toBeNull();
  });
});

describe('the band\'s state against t0 (K1.1 step 7, matrix row 14)', () => {
  const T0 = 10_000;
  /** Whole milliseconds so that the bounds are exact. */
  const tiers: TakeoffWindow = { cleanMs: 150, perfectMs: 60 };
  const at = (serverNow: number | null, speed: number | null = 5) => markerState(serverNow, T0, tiers, speed);

  it("'approach' (an outline) until t0 − cleanMs, 'clean' from it on", () => {
    expect(at(T0 - 2_000)).toBe('approach');
    expect(at(T0 - 150 - 1)).toBe('approach');
    expect(at(T0 - 150)).toBe('clean');
  });

  it("'perfect' inside ±perfectMs, bounds included; 'clean' just outside them", () => {
    expect(at(T0 - 61)).toBe('clean');
    expect(at(T0 - 60)).toBe('perfect');
    expect(at(T0)).toBe('perfect');
    expect(at(T0 + 60)).toBe('perfect');
    expect(at(T0 + 61)).toBe('clean');
  });

  it("'clean' up to t0 + cleanMs, 'late' from the millisecond after it while the approach is undecided", () => {
    expect(at(T0 + 150)).toBe('clean');
    expect(at(T0 + 150 + 1)).toBe('late');
    expect(at(T0 + 700)).toBe('late');
  });

  it('negative: without a measured clock, or without a speed, only the outline — whatever the moment', () => {
    expect(at(null)).toBe('approach');
    for (const now of [T0 - 150, T0, T0 + 151]) {
      expect(at(now, null), String(now)).toBe('approach');
      expect(at(now, 0), String(now)).toBe('approach');
    }
  });
});
