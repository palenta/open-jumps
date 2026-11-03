// The chase camera (plan 1.13): behind and slightly above the rider's own horse, looking ahead along the
// track so the next fence and the stride marks are in view and the horse is seen whole.
import type { TrackPoint } from './track.js';

export const CAMERA = {
  backM: 7,
  upM: 3,
  lookAheadM: 6,
  /** Height of the look-at point (about the horse's withers). */
  targetHeightM: 1.2,
} as const;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

/** position = horse − direction × backM + up × upM; target = horse + direction × lookAheadM at targetHeightM. */
export function chaseCamera(horse: TrackPoint): CameraPose {
  const dx = Math.cos(horse.heading);
  const dz = Math.sin(horse.heading);
  return {
    position: { x: horse.x - dx * CAMERA.backM, y: CAMERA.upM, z: horse.z - dz * CAMERA.backM },
    target: { x: horse.x + dx * CAMERA.lookAheadM, y: CAMERA.targetHeightM, z: horse.z + dz * CAMERA.lookAheadM },
  };
}
