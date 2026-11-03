// The arena in Three.js — PLACEHOLDER ART (plan 1.14 says the real horses, fences and manège come from the Blender
// pipeline after probe №3): primitives with flat colours, deliberately provisional in look, so that nobody mistakes
// this for the game's art. What is real here: the track geometry from the course (track.ts), the fence positions,
// the horses moving along the track from the server's positions, the chase camera and the course-walk fly-over —
// and the housekeeping: every object this file builds is freed (geometry, materials, textures) when a new course
// replaces it, when the room is left and when the scene is disposed (audit K1 r1 #9), so "again" after "again"
// on a phone does not pile up GPU buffers. K1.1 step 7 adds the take-off markers: a weak mark at the take-off point
// of every fence of the course, always, and the bright band of the own open approach (SceneFrame.takeoff) drawn in
// its state; both are part of the course and are freed with it.
import * as THREE from 'three';
import type { CourseSpec } from '@open-jumps/shared';
import type { SceneFrame, SceneLike } from '../app/game.js';
import { NotImplementedError } from '../errors.js';
import type { MarkerState } from './takeoffMarker.js';
import { buildTrack, fencePose, pointAt, type Track } from './track.js';

/** One take-off marker as the arena shows it (for the tests: no WebGL is needed to read it). */
export interface MarkerView {
  fence: number;
  /** 'weak': the mark every fence of the course carries; 'bright': the band of the own open approach. */
  kind: 'weak' | 'bright';
  /** The band's state (SceneFrame.takeoff.state); null for a weak mark. */
  state: MarkerState | null;
  /** The band's full length along the track, metres (twice cleanHalfM); null for a weak mark or a band without speed (an outline). */
  lengthM: number | null;
}

/**
 * The arena scene (SceneLike) with a read-out of its take-off markers:
 * - markers(): what the arena shows right now — one weak mark per fence of the current course, in course order, and,
 *   when the last rendered frame carried a takeoff marker, the bright band at that fence in its state with its length
 *   (2 × cleanHalfM). No course: []. A frame without a takeoff marker leaves the weak marks only. Rendering the same
 *   marker again builds nothing new; setCourse() and dispose() free every marker resource with the course.
 */
export interface ArenaScene extends SceneLike {
  markers(): MarkerView[];
}

const COLOURS = {
  sky: 0x9fc5e8,
  sand: 0xd9c38a,
  rail: 0xf4f1e8,
  pole: 0xffffff,
  stripe: 0xc0392b,
  own: 0x2e86de,
  others: [0xe17055, 0x6c5ce7, 0x00b894, 0xfdcb6e],
  track: 0xcbb57a,
} as const;

/** The horse placeholder: a box body, a smaller box head, four thin legs, a sprite with the name above. */
function makeHorse(colour: number): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ color: colour });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 0.8), material);
  body.position.y = 1.25;
  group.add(body);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.4), material);
  neck.position.set(1.0, 1.9, 0);
  neck.rotation.z = -0.5;
  group.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.35), material);
  head.position.set(1.45, 2.2, 0);
  group.add(head);
  for (const [x, z] of [
    [0.7, 0.25],
    [0.7, -0.25],
    [-0.7, 0.25],
    [-0.7, -0.25],
  ] as const) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.9, 0.18), material);
    leg.position.set(x, 0.45, z);
    group.add(leg);
  }
  const rider = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.6, 4, 8), new THREE.MeshLambertMaterial({ color: 0x2d3436 }));
  rider.position.set(0, 2.2, 0);
  group.add(rider);
  return group;
}

function makeFence(number: number): THREE.Group {
  const group = new THREE.Group();
  const poleMaterial = new THREE.MeshLambertMaterial({ color: COLOURS.pole });
  for (const z of [-2, 2]) {
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.6, 0.15), poleMaterial);
    pole.position.set(0, 0.8, z);
    group.add(pole);
  }
  for (const [y, colour] of [
    [0.9, COLOURS.stripe],
    [0.55, COLOURS.pole],
  ] as const) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 4), new THREE.MeshLambertMaterial({ color: colour }));
    rail.position.set(0, y, 0);
    group.add(rail);
  }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ map: numberTexture(number), side: THREE.DoubleSide }));
  sign.position.set(0, 1.4, 2.4);
  group.add(sign);
  return group;
}

function numberTexture(number: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(number), 32, 34);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Free the GPU resources of an object tree: every geometry, every material (shared ones once) and the textures
 * those materials hold. Removing an object from the scene alone keeps all of that alive in the renderer.
 */
function disposeTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  const textures = new Set<THREE.Texture>();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

/** A flat ribbon along the track: sampled every metre, drawn as a line strip and small ground tiles. */
function makeTrackRibbon(track: Track): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ color: COLOURS.track });
  for (let m = 0; m <= track.lengthM; m += 1) {
    const point = pointAt(track, m);
    const tile = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 3), material);
    tile.rotation.x = -Math.PI / 2;
    tile.rotation.z = -point.heading;
    tile.position.set(point.x, 0.01, point.z);
    group.add(tile);
  }
  const start = pointAt(track, 0);
  const finish = pointAt(track, track.lengthM);
  for (const [point, colour] of [
    [start, 0x27ae60],
    [finish, 0xc0392b],
  ] as const) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 4), new THREE.MeshBasicMaterial({ color: colour }));
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = -point.heading;
    line.position.set(point.x, 0.02, point.z);
    group.add(line);
  }
  return group;
}

export function createArenaScene(): ArenaScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLOURS.sky);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(-20, 12, 30);
  camera.lookAt(30, 0, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a4a, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(40, 60, 20);
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ color: COLOURS.sand }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  let renderer: THREE.WebGLRenderer | null = null;
  let container: HTMLElement | null = null;
  let labels: HTMLElement | null = null;
  const courseGroup = new THREE.Group();
  scene.add(courseGroup);
  let track: Track | null = null;
  let course: CourseSpec | null = null;
  const horses = new Map<string, { group: THREE.Group; label: HTMLElement }>();
  let walkAngle = 0;

  function sizeToContainer(): void {
    if (!renderer || !container) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }

  /** Every horse leaves the scene, its resources freed, its label removed. */
  function clearHorses(): void {
    for (const horse of horses.values()) {
      disposeTree(horse.group);
      scene.remove(horse.group);
      horse.label.remove();
    }
    horses.clear();
  }

  /** The course's objects leave the scene, their resources freed. */
  function clearCourse(): void {
    for (const child of [...courseGroup.children]) disposeTree(child);
    courseGroup.clear();
  }

  function horseFor(id: string, isOwn: boolean, index: number): { group: THREE.Group; label: HTMLElement } {
    let horse = horses.get(id);
    if (!horse) {
      const colour = isOwn ? COLOURS.own : COLOURS.others[index % COLOURS.others.length] ?? COLOURS.others[0];
      const group = makeHorse(colour);
      scene.add(group);
      const label = document.createElement('div');
      label.className = 'horse-label';
      labels?.appendChild(label);
      horse = { group, label };
      horses.set(id, horse);
    }
    return horse;
  }

  function placeLabel(label: HTMLElement, group: THREE.Group): void {
    if (!renderer) return;
    const size = renderer.getSize(new THREE.Vector2());
    const position = group.position.clone();
    position.y += 3.2;
    position.project(camera);
    const visible = position.z < 1;
    label.style.display = visible ? '' : 'none';
    label.style.left = `${String(((position.x + 1) / 2) * size.x)}px`;
    label.style.top = `${String(((1 - position.y) / 2) * size.y)}px`;
  }

  return {
    mount(element: HTMLElement): void {
      container = element;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
      } catch {
        renderer = null; // no WebGL (a test browser): the arena stays empty, the game still runs
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.className = 'arena-canvas';
      element.insertBefore(renderer.domElement, element.firstChild);
      labels = document.createElement('div');
      labels.className = 'horse-labels';
      element.insertBefore(labels, renderer.domElement.nextSibling);
      sizeToContainer();
    },

    setCourse(next: CourseSpec | null): void {
      course = next;
      clearCourse();
      clearHorses();
      if (!next) {
        track = null;
        return;
      }
      track = buildTrack(next);
      courseGroup.add(makeTrackRibbon(track));
      for (const fence of next.fences) {
        const pose = fencePose(track, next, fence.number);
        const group = makeFence(fence.number);
        group.position.set(pose.x, 0, pose.z);
        group.rotation.y = -pose.heading;
        courseGroup.add(group);
      }
    },

    render(frame: SceneFrame): void {
      // The scene graph follows the frame even without WebGL (a test browser): only the drawing needs the renderer.
      sizeToContainer();
      const seen = new Set<string>();
      frame.riders.forEach((entry, index) => {
        seen.add(entry.id);
        const horse = horseFor(entry.id, entry.isOwn, index);
        horse.group.position.set(entry.point.x, 0, entry.point.z);
        horse.group.rotation.y = -entry.point.heading;
        horse.label.textContent = entry.label;
      });
      for (const [id, horse] of horses) {
        horse.group.visible = seen.has(id);
        horse.label.style.display = seen.has(id) ? '' : 'none';
      }
      if (frame.camera) {
        camera.position.set(frame.camera.position.x, frame.camera.position.y, frame.camera.position.z);
        camera.lookAt(frame.camera.target.x, frame.camera.target.y, frame.camera.target.z);
      } else if (frame.phase === 'walk' && track && course && frame.focusFence !== null) {
        // The fly-over: a slow circle around the focused fence, high enough to read the next turn.
        walkAngle += 0.004;
        const pose = fencePose(track, course, frame.focusFence);
        camera.position.set(pose.x + Math.cos(walkAngle) * 18, 9, pose.z + Math.sin(walkAngle) * 18);
        camera.lookAt(pose.x, 0.8, pose.z);
      } else if (track) {
        const middle = pointAt(track, track.lengthM / 2);
        camera.position.set(middle.x - 40, 30, middle.z + 50);
        camera.lookAt(middle.x, 0, middle.z);
      }
      if (!renderer) return;
      renderer.render(scene, camera);
      for (const [id, horse] of horses) if (seen.has(id)) placeLabel(horse.label, horse.group);
    },

    markers(): MarkerView[] {
      throw new NotImplementedError('the arena take-off markers (K1.1 step 7)');
    },

    dispose(): void {
      clearHorses();
      clearCourse();
      disposeTree(ground);
      scene.remove(ground);
      track = null;
      course = null;
      renderer?.dispose();
      renderer?.domElement.remove();
      labels?.remove();
      renderer = null;
      container = null;
    },
  };
}
