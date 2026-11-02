// Matrix row 6 (plan 2.9): pony categories limit the classes; height narrows the window and raises rail risk.
import { describe, expect, it } from 'vitest';
import {
  HEIGHT_CLASSES,
  allowedHeightClasses,
  gallopRailProbability,
  windowScaleForHeight,
} from '../src/rules/heightClasses.js';

describe('allowed height classes per pony category (plan 1.6)', () => {
  it('A: 50–70, B: 60–80, C: 70–90, D: 80–100', () => {
    expect(allowedHeightClasses('A')).toEqual([50, 60, 70]);
    expect(allowedHeightClasses('B')).toEqual([60, 70, 80]);
    expect(allowedHeightClasses('C')).toEqual([70, 80, 90]);
    expect(allowedHeightClasses('D')).toEqual([80, 90, 100]);
  });
});

describe('window scale by height', () => {
  it('60 cm is the reference scale 1.0', () => {
    expect(windowScaleForHeight(60)).toBe(1);
  });

  it('every +10 cm narrows the window (strictly decreasing over all classes)', () => {
    for (let i = 1; i < HEIGHT_CLASSES.length; i += 1) {
      const lower = HEIGHT_CLASSES[i - 1]!;
      const higher = HEIGHT_CLASSES[i]!;
      expect(windowScaleForHeight(higher)).toBeLessThan(windowScaleForHeight(lower));
    }
  });

  it('50 cm is more forgiving than 60 cm', () => {
    expect(windowScaleForHeight(50)).toBeGreaterThan(1);
  });

  it('never narrows below half of the base window', () => {
    for (const cls of HEIGHT_CLASSES) {
      expect(windowScaleForHeight(cls)).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('gallop rail probability (clean-tier tap on a gallop approach)', () => {
  it('is about one in two at 60 cm (plan 1.8 outcome table)', () => {
    expect(gallopRailProbability(60)).toBeCloseTo(0.5, 2);
  });

  it('strictly increases with every height class and stays a probability', () => {
    let previous = 0;
    for (const cls of HEIGHT_CLASSES) {
      const p = gallopRailProbability(cls);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
      expect(p).toBeGreaterThan(previous);
      previous = p;
    }
  });

  it('is noticeably higher at 100 cm than at 50 cm (at least +0.2)', () => {
    expect(gallopRailProbability(100) - gallopRailProbability(50)).toBeGreaterThanOrEqual(0.2);
  });
});
