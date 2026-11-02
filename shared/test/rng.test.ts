// Matrix row 3 (plan 2.3): chance outcomes are reproducible from the round seed, fence and attempt.
import { describe, expect, it } from 'vitest';
import { chance, createRng } from '../src/rules/rng.js';

describe('createRng', () => {
  it('the same seed gives the same sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    const first = Array.from({ length: 10 }, () => a());
    const second = Array.from({ length: 10 }, () => b());
    expect(first).toEqual(second);
  });

  it('different seeds give different sequences', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(Array.from({ length: 5 }, () => a())).not.toEqual(Array.from({ length: 5 }, () => b()));
  });

  it('values lie in [0, 1)', () => {
    const rng = createRng('open-jumps');
    for (let i = 0; i < 1000; i += 1) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('accepts a string seed deterministically', () => {
    expect(createRng('round-7')()).toBe(createRng('round-7')());
  });
});

describe('chance(key, probability)', () => {
  it('is deterministic for the same key and probability', () => {
    const key = { roundSeed: 'r1', fence: 3, attempt: 1 };
    expect(chance(key, 0.5)).toBe(chance(key, 0.5));
  });

  it('probability 0 is never true and probability 1 is always true', () => {
    for (let fence = 1; fence <= 12; fence += 1) {
      expect(chance({ roundSeed: 9, fence, attempt: 1 }, 0)).toBe(false);
      expect(chance({ roundSeed: 9, fence, attempt: 1 }, 1)).toBe(true);
    }
  });

  it('depends on the fence and the attempt, not only on the seed', () => {
    const outcomes = new Set<boolean>();
    for (let fence = 1; fence <= 40; fence += 1) {
      outcomes.add(chance({ roundSeed: 'same', fence, attempt: 1 }, 0.5));
    }
    expect(outcomes.size).toBe(2);
    const byAttempt = new Set<boolean>();
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      byAttempt.add(chance({ roundSeed: 'same', fence: 1, attempt }, 0.5));
    }
    expect(byAttempt.size).toBe(2);
  });

  it('matches the probability over many keys (±5 %)', () => {
    let hits = 0;
    const total = 4000;
    for (let i = 0; i < total; i += 1) {
      if (chance({ roundSeed: 'stats', fence: i % 12, attempt: Math.floor(i / 12) }, 0.3)) hits += 1;
    }
    expect(hits / total).toBeGreaterThan(0.25);
    expect(hits / total).toBeLessThan(0.35);
  });
});
