// Other riders' horses are drawn ~100 ms in the past (plan 2.3) so that movement between 20 Hz patches is
// smooth: positions are interpolated between the two state samples around (render time − delay).

export const INTERP = {
  delayMs: 100,
  /** Beyond the newest sample the position is extrapolated at the last speed for at most this long, then held. */
  maxExtrapolationMs: 100,
  /** Samples kept per rider. */
  maxSamples: 20,
} as const;

interface Sample {
  /** Round clock, ms. */
  t: number;
  /** Position along the track, m. */
  p: number;
}

/**
 * Samples are (roundClockMs, positionM) pairs read from state patches; renderTime is the client's estimate of
 * the round clock now (RoundClockEstimate). Before the first sample → the first position; between samples →
 * linear; after the newest → extrapolation at the speed of the last two samples, capped by maxExtrapolationMs.
 */
export class RemoteInterpolator {
  /** Per rider, oldest first, strictly increasing in t. */
  private readonly riders = new Map<string, Sample[]>();

  push(riderId: string, roundClockMs: number, positionM: number): void {
    let samples = this.riders.get(riderId);
    if (samples === undefined) {
      samples = [];
      this.riders.set(riderId, samples);
    }
    const newest = samples[samples.length - 1];
    if (newest !== undefined) {
      // A patch that arrived out of order says nothing new; the same instant again only updates the position.
      if (roundClockMs < newest.t) return;
      if (roundClockMs === newest.t) {
        newest.p = positionM;
        return;
      }
    }
    samples.push({ t: roundClockMs, p: positionM });
    if (samples.length > INTERP.maxSamples) samples.splice(0, samples.length - INTERP.maxSamples);
  }

  /** The position to draw at renderTime (the delay is applied inside), or null for an unknown rider. */
  positionAt(riderId: string, renderTime: number): number | null {
    const samples = this.riders.get(riderId);
    const first = samples?.[0];
    const newest = samples?.[samples.length - 1];
    if (samples === undefined || first === undefined || newest === undefined) return null;

    const t = renderTime - INTERP.delayMs;
    if (t <= first.t) return first.p;
    if (t >= newest.t) {
      const previous = samples[samples.length - 2];
      if (previous === undefined) return newest.p;
      const speed = (newest.p - previous.p) / (newest.t - previous.t);
      const ahead = Math.min(t - newest.t, INTERP.maxExtrapolationMs);
      return newest.p + speed * ahead;
    }
    for (let i = 1; i < samples.length; i += 1) {
      const a = samples[i - 1];
      const b = samples[i];
      if (a === undefined || b === undefined) break;
      if (t <= b.t) {
        const share = (t - a.t) / (b.t - a.t);
        return a.p + (b.p - a.p) * share;
      }
    }
    return newest.p;
  }

  forget(riderId: string): void {
    this.riders.delete(riderId);
  }
}

/** The round clock between patches: the last roundClockMs plus the device time since that patch arrived. */
export class RoundClockEstimate {
  private base: { roundClockMs: number; receivedAt: number } | null = null;

  onPatch(roundClockMs: number, receivedAt: number): void {
    this.base = { roundClockMs, receivedAt };
  }

  /** null before the first patch. */
  estimate(now: number): number | null {
    return this.base === null ? null : this.base.roundClockMs + (now - this.base.receivedAt);
  }
}
