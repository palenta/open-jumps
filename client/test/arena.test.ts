// @vitest-environment happy-dom
// The Three.js arena's housekeeping (audit K1 r1 #9): a new course, a horse that leaves the scene and the scene's
// own disposal free every geometry, every unique material and every texture they created — exactly once — so that
// "again" after "again" on a phone does not pile up GPU buffers. No WebGL here (happy-dom has none): the renderer
// stays null and the scene graph alone is exercised; the dispose() calls are counted on the three.js prototypes.
import * as THREE from 'three';
import type { CourseSpec } from '@open-jumps/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneFrame } from '../src/app/game.js';
import { createArenaScene } from '../src/scene/arena.js';

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

/**
 * What the placeholder art creates for a course: one ground tile per metre (lengthM + 1) and two lines on one shared
 * ribbon material plus two line materials; per fence two poles (one shared material), two rails (a material each)
 * and the number sign (its own material with a canvas texture).
 */
const courseResources = (course: CourseSpec) => ({
  geometries: course.lengthM + 1 + 2 + 5 * course.fences.length,
  materials: 3 + 4 * course.fences.length,
  textures: course.fences.length,
});

/** A horse: body, neck, head, four legs on one material, the rider on another. */
const HORSE = { geometries: 8, materials: 2 };

const frame = (riders: string[]): SceneFrame => ({
  phase: 'riding',
  riders: riders.map((id, index) => ({ id, point: { x: index * 3, z: 0, heading: 0 }, isOwn: index === 0, label: id })),
  camera: { position: { x: -10, y: 5, z: 0 }, target: { x: 0, y: 1, z: 0 } },
  focusFence: null,
});

let geometryDispose: ReturnType<typeof vi.spyOn>;
let materialDispose: ReturnType<typeof vi.spyOn>;
let textureDispose: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
  materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose');
  textureDispose = vi.spyOn(THREE.Texture.prototype, 'dispose');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const disposed = () => ({ geometries: geometryDispose.mock.calls.length, materials: materialDispose.mock.calls.length, textures: textureDispose.mock.calls.length });

describe('the arena frees what it built (audit K1 r1 #9)', () => {
  it('a new class-course disposes every geometry, unique material and texture of the previous course, exactly once, before building the next', () => {
    const scene = createArenaScene();
    scene.setCourse(oneFence);
    expect(disposed()).toEqual({ geometries: 0, materials: 0, textures: 0 });
    scene.setCourse(twoFences);
    expect(disposed()).toEqual(courseResources(oneFence));
    scene.setCourse(oneFence);
    const both = courseResources(oneFence);
    const second = courseResources(twoFences);
    expect(disposed()).toEqual({ geometries: both.geometries + second.geometries, materials: both.materials + second.materials, textures: both.textures + second.textures });
  });

  it('leaving the room (setCourse null) frees the course and the horses of the heat', () => {
    const scene = createArenaScene();
    scene.setCourse(oneFence);
    scene.render(frame(['host', 'ana']));
    scene.render(frame(['host', 'ana'])); // a second frame re-uses the horses: nothing new is built
    scene.setCourse(null);
    const course = courseResources(oneFence);
    expect(disposed()).toEqual({ geometries: course.geometries + 2 * HORSE.geometries, materials: course.materials + 2 * HORSE.materials, textures: course.textures });
    scene.setCourse(null); // nothing left to free
    expect(disposed()).toEqual({ geometries: course.geometries + 2 * HORSE.geometries, materials: course.materials + 2 * HORSE.materials, textures: course.textures });
  });

  it('dispose() frees the course, the horses and the ground; a course set again after a round of "again" is freed too', () => {
    const scene = createArenaScene();
    scene.setCourse(twoFences);
    scene.render(frame(['host']));
    scene.dispose();
    const course = courseResources(twoFences);
    // The ground: one plane, one material.
    expect(disposed()).toEqual({ geometries: course.geometries + HORSE.geometries + 1, materials: course.materials + HORSE.materials + 1, textures: course.textures });
  });
});
