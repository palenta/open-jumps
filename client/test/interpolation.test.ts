// Plan 2.3: other riders' horses are drawn 100 ms in the past, interpolated between the two state samples
// around (render time − delay), extrapolated for at most 100 ms past the newest sample, then held; the round
// clock between patches is the last patch's clock plus the device time since it arrived.
import { describe, expect, it } from 'vitest';
import { INTERP, RemoteInterpolator, RoundClockEstimate } from '../src/scene/interpolation.js';

/** An interpolator with Ana's samples (1000 ms, 5 m) and (1050 ms, 5.25 m): 5 m/s. */
function twoSamples(): RemoteInterpolator {
  const interpolator = new RemoteInterpolator();
  interpolator.push('ana', 1000, 5);
  interpolator.push('ana', 1050, 5.25);
  return interpolator;
}

describe('INTERP', () => {
  it('100 ms behind, 100 ms of extrapolation at most, 20 samples per rider', () => {
    expect(INTERP).toEqual({ delayMs: 100, maxExtrapolationMs: 100, maxSamples: 20 });
  });
});

describe('RemoteInterpolator', () => {
  it('knows nothing about a rider without samples', () => {
    expect(new RemoteInterpolator().positionAt('ana', 1100)).toBeNull();
  });

  it('with one sample returns its position at and before it', () => {
    const interpolator = new RemoteInterpolator();
    interpolator.push('ana', 1000, 5);
    expect(interpolator.positionAt('ana', 1100)).toBe(5); // render time − delay = 1000: exactly the sample
    expect(interpolator.positionAt('ana', 1050)).toBe(5); // 950: before the first sample
  });

  it('interpolates linearly between the two samples around render time − delay', () => {
    expect(twoSamples().positionAt('ana', 1125)).toBeCloseTo(5.125, 9); // 1025: halfway
  });

  it('before the first sample the first position is held', () => {
    expect(twoSamples().positionAt('ana', 1050)).toBe(5); // 950
  });

  it('exactly at the newest sample it returns that position without extrapolating', () => {
    expect(twoSamples().positionAt('ana', 1150)).toBeCloseTo(5.25, 9); // 1050
  });

  it('past the newest sample it extrapolates at the speed of the last two samples', () => {
    expect(twoSamples().positionAt('ana', 1200)).toBeCloseTo(5.5, 9); // 1100: 50 ms past at 5 m/s
  });

  it('caps the extrapolation at maxExtrapolationMs and holds the position from there', () => {
    const interpolator = twoSamples();
    expect(interpolator.positionAt('ana', 1250)).toBeCloseTo(5.75, 9); // 1150: exactly 100 ms past
    expect(interpolator.positionAt('ana', 1400)).toBeCloseTo(5.75, 9); // 1300: 250 ms past, capped
    expect(interpolator.positionAt('ana', 9000)).toBeCloseTo(5.75, 9);
  });

  it('never extrapolates a rider with a single sample (speed unknown): the position is held', () => {
    const interpolator = new RemoteInterpolator();
    interpolator.push('ana', 1000, 5);
    expect(interpolator.positionAt('ana', 1300)).toBe(5);
  });

  it('ignores a sample older than the newest one (patches arriving out of order)', () => {
    const interpolator = twoSamples();
    interpolator.push('ana', 1020, 9);
    expect(interpolator.positionAt('ana', 1125)).toBeCloseTo(5.125, 9);
    expect(interpolator.positionAt('ana', 1200)).toBeCloseTo(5.5, 9);
  });

  it('keeps only the newest maxSamples: a render time before the oldest kept sample returns that sample\'s position', () => {
    const interpolator = new RemoteInterpolator();
    for (let i = 0; i < 25; i += 1) interpolator.push('ana', 1000 + i * 50, i);
    // Kept: samples 5..24 (1250 ms onwards); 1100 − 100 = 1000 is before all of them.
    expect(interpolator.positionAt('ana', 1100)).toBe(5);
  });

  it('forget() drops the rider: positionAt is null again', () => {
    const interpolator = twoSamples();
    interpolator.forget('ana');
    expect(interpolator.positionAt('ana', 1125)).toBeNull();
  });

  it('keeps riders independent', () => {
    const interpolator = twoSamples();
    interpolator.push('bea', 1000, 50);
    interpolator.push('bea', 1050, 51);
    expect(interpolator.positionAt('ana', 1125)).toBeCloseTo(5.125, 9);
    expect(interpolator.positionAt('bea', 1125)).toBeCloseTo(50.5, 9);
    interpolator.forget('bea');
    expect(interpolator.positionAt('bea', 1125)).toBeNull();
    expect(interpolator.positionAt('ana', 1125)).toBeCloseTo(5.125, 9);
  });
});

describe('RoundClockEstimate', () => {
  it('has no estimate before the first patch', () => {
    expect(new RoundClockEstimate().estimate(5_000)).toBeNull();
  });

  it('adds the device time since the patch to the patch\'s round clock', () => {
    const estimate = new RoundClockEstimate();
    estimate.onPatch(42_000, 5_000);
    expect(estimate.estimate(5_250)).toBe(42_250);
    expect(estimate.estimate(5_000)).toBe(42_000);
  });

  it('the newest patch replaces the base', () => {
    const estimate = new RoundClockEstimate();
    estimate.onPatch(42_000, 5_000);
    estimate.onPatch(43_000, 6_100);
    expect(estimate.estimate(6_200)).toBe(43_100);
  });
});
