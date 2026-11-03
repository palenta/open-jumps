// The client's view of the server clock (plan 2.3). The server measures the offset from the clock-pong series and
// translates every tap and turn itself; the client translates for what it draws and shows from server times — the
// lit tap zone (data-takeoff-at = toClient(t0)), the instant hint (toServer of the tap), the course walk. Both must
// read the SAME translation, or a tap at the edge of a window is shown one tier and judged another: the server's
// ClockSync takes the middle of the ping–pong round trip, while a ping alone (stamped when sent, read when received)
// is off by the one-way delay — rtt/2 on a symmetric link, 7–13 ms measured by the smoke route, enough for "cero
// faltas" on the screen and a rail from the judge (audit K1 r3 #5). So the server announces its own offset
// ('clock-offset', see LobbyRoom) and, once heard, that offset is the translation; the estimate from the pings
// only bridges the moments before it.

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
 * - onServerOffset(offsetMs): the server's own measurement for this device ('clock-offset': its ClockSync.offsetMs,
 *   client − server; the server translates a clientTime c as c − offsetMs). From then on offset() is −offsetMs and
 *   toServer / toClient translate exactly as the judge does; later pings never move it (the newest server value
 *   replaces it), and the estimate from the pings counts only until the first one arrives. A value that is not a
 *   finite number is ignored.
 */
export class ClientClock {
  private readonly read: () => number;
  /** Offsets (server − client) of the newest series, oldest first; at most maxSamples. */
  private series: number[] = [];
  /** Device reading of the last ping, for the series gap. */
  private lastReceivedAt: number | null = null;
  /** The own estimate: the median of the newest series that reached minSamples. */
  private estimate: number | null = null;
  /** The server's own measurement (server − client), once announced: it overrides the own estimate. */
  private announced: number | null = null;

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

  /** The server announced its offset for this device ('clock-offset': client − server, as its ClockSync keeps it). */
  onServerOffset(offsetMs: number): void {
    if (!Number.isFinite(offsetMs)) return;
    this.announced = -offsetMs;
  }

  /** Server minus client: the server's announced offset, else the own estimate; null until either exists. */
  offset(): number | null {
    return this.announced ?? this.estimate;
  }

  ready(): boolean {
    return this.offset() !== null;
  }

  toServer(clientTime: number): number | null {
    const offset = this.offset();
    return offset === null ? null : clientTime + offset;
  }

  toClient(serverTime: number): number | null {
    const offset = this.offset();
    return offset === null ? null : serverTime - offset;
  }
}
