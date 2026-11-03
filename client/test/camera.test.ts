// Plan 1.13: the chase camera sits behind and above the rider's own horse and looks ahead along the track at
// about the withers, so the next fence and the stride marks are in view and the horse is seen whole.
import { describe, expect, it } from 'vitest';
import { CAMERA, chaseCamera } from '../src/scene/camera.js';

describe('CAMERA', () => {
  it('7 m back, 3 m up, looking 6 m ahead at 1.2 m', () => {
    expect(CAMERA).toEqual({ backM: 7, upM: 3, lookAheadM: 6, targetHeightM: 1.2 });
  });
});

describe('chaseCamera', () => {
  it('heading +x: the camera is backM behind along −x and upM up, the target lookAheadM ahead at the withers', () => {
    expect(chaseCamera({ x: 10, z: 0, heading: 0 })).toEqual({
      position: { x: 10 - CAMERA.backM, y: CAMERA.upM, z: 0 },
      target: { x: 10 + CAMERA.lookAheadM, y: CAMERA.targetHeightM, z: 0 },
    });
  });

  it('heading −π/2 (towards −z): the camera is behind along +z and the target further along −z', () => {
    const { position, target } = chaseCamera({ x: 0, z: -20, heading: -Math.PI / 2 });
    expect(position.x).toBeCloseTo(0, 9);
    expect(position.y).toBe(CAMERA.upM);
    expect(position.z).toBeCloseTo(-20 + CAMERA.backM, 9);
    expect(target.x).toBeCloseTo(0, 9);
    expect(target.y).toBe(CAMERA.targetHeightM);
    expect(target.z).toBeCloseTo(-20 - CAMERA.lookAheadM, 9);
  });

  it('heading π (towards −x): the camera is backM further along +x than the horse and the target lookAheadM along −x', () => {
    const { position, target } = chaseCamera({ x: 10, z: 4, heading: Math.PI });
    expect(position.x).toBeCloseTo(10 + CAMERA.backM, 9);
    expect(position.y).toBe(CAMERA.upM);
    expect(position.z).toBeCloseTo(4, 9);
    expect(target.x).toBeCloseTo(10 - CAMERA.lookAheadM, 9);
    expect(target.y).toBe(CAMERA.targetHeightM);
    expect(target.z).toBeCloseTo(4, 9);
  });
});
