// The client's view of the server clock (plan 2.3). The server measures the real offset from the clock-pong
// series and translates every tap itself; this estimate exists only for the INSTANT HINT (where t0 is server
// time and the tap is client time) — it is biased by one-way latency (a ping is stamped when sent, read when
// received), which on a home network is a few milliseconds and never changes a hint's tier.

export const CLIENT_CLOCK = {
  /** Samples before the estimate is trusted (same as the server's ClockSync). */
  minSamples: 3,
  /** Newest samples kept per series. */
  maxSamples: 8,
  /** A ping this long after the previous one starts a new series (the server sends one at join and one per walk). */
  seriesGapMs: 1000,
} as const;

export interface ClockPong {
  type: 'clock-pong';
  serverSent: number;
  clientTime: number;
}

/** The same median as the server's ClockSync: an even count gives the mean of the two middle values. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * - `now()` is the device's monotonic clock in ms (performance.now() in the browser), the SAME clock every
 *   clientTime the client ever sends is read from (pongs and taps), or the server's translation is wrong.
 * - A series is 8 pings 200 ms apart; a gap ≥ seriesGapMs opens a new series. The active estimate is the
 *   median offset of the newest complete series: a new series replaces it only once it has minSamples, so a
 *   stalled series never blanks a working estimate.
 * - offset = serverSent − receivedAt (server − client); toServer(t) = t + offset; toClient(s) = s − offset.
 */
export class ClientClock {
  private readonly read: () => number;
  /** Offsets (server − client) of the newest series, oldest first; at most maxSamples. */
  private series: number[] = [];
  /** Device reading of the last ping, for the series gap. */
  private lastReceivedAt: number | null = null;
  /** The trusted estimate: the median of the newest series that reached minSamples. */
  private estimate: number | null = null;

  constructor(now: () => number) {
    this.read = now;
  }

  now(): number {
    return this.read();
  }

  /** A clock-ping arrived at receivedAt (default now()); returns the pong to send back as the 'room' message. */
  onPing(serverSent: number, receivedAt?: number): ClockPong {
    const at = receivedAt ?? this.read();
    if (this.lastReceivedAt !== null && at - this.lastReceivedAt >= CLIENT_CLOCK.seriesGapMs) {
      this.series = [];
    }
    this.lastReceivedAt = at;
    this.series.push(serverSent - at);
    if (this.series.length > CLIENT_CLOCK.maxSamples) this.series.shift();
    if (this.series.length >= CLIENT_CLOCK.minSamples) this.estimate = median(this.series);
    return { type: 'clock-pong', serverSent, clientTime: at };
  }

  /** Server minus client, or null until a series has minSamples. */
  offset(): number | null {
    return this.estimate;
  }

  ready(): boolean {
    return this.estimate !== null;
  }

  toServer(clientTime: number): number | null {
    return this.estimate === null ? null : clientTime + this.estimate;
  }

  toClient(serverTime: number): number | null {
    return this.estimate === null ? null : serverTime - this.estimate;
  }
}
