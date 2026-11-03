// Clock offset between a client and the server (plan 2.3): the server sends ping, the client answers with its
// clock, the server measures RTT and takes the median offset over a short series (repeated every round).

export const CLOCK_SYNC = {
  /** Samples kept (the newest ones); the offset is their median. */
  samples: 8,
  /** Samples needed before the offset is trusted. */
  minSamples: 3,
  /** Samples with a longer round trip are discarded (a stalled tab, not a measurement). */
  maxRttMs: 1000,
} as const;

export interface ClockSample {
  /** Server time when the ping left. */
  serverSent: number;
  /** The client's clock when it answered. */
  clientTime: number;
  /** Server time when the answer arrived. */
  serverReceived: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export class ClockSync {
  /** The newest valid samples as (offset, rtt) pairs. */
  private readonly kept: { offset: number; rtt: number }[] = [];

  /** Record one ping/pong; samples with RTT < 0 or > maxRttMs are ignored. */
  addSample(sample: ClockSample): void {
    const rtt = sample.serverReceived - sample.serverSent;
    if (rtt < 0 || rtt > CLOCK_SYNC.maxRttMs) return;
    this.kept.push({ offset: sample.clientTime - (sample.serverSent + rtt / 2), rtt });
    if (this.kept.length > CLOCK_SYNC.samples) this.kept.shift();
  }

  /** True once minSamples valid samples have been recorded. */
  get ready(): boolean {
    return this.kept.length >= CLOCK_SYNC.minSamples;
  }

  /** Median of (clientTime − (serverSent + rtt / 2)) over the kept samples; null until ready. */
  get offsetMs(): number | null {
    return this.ready ? median(this.kept.map((s) => s.offset)) : null;
  }

  /** Median round trip of the kept samples; null until ready. */
  get rttMs(): number | null {
    return this.ready ? median(this.kept.map((s) => s.rtt)) : null;
  }

  /** A client clock reading in server time (clientTime − offset); null until ready. */
  toServerTime(clientTime: number): number | null {
    const offset = this.offsetMs;
    return offset === null ? null : clientTime - offset;
  }
}
