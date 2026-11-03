// Plan 2.3: the client's view of the server clock — what the lit tap zone, the instant hint and the course walk
// translate with. The server's own measurement, once it announces it ('clock-offset', audit K1 r3 #5), is the
// translation; before it, the median offset (server − client) of the newest ping series, trusted after three
// samples, the newest eight counted, a stalled series never blanking a working estimate.
import { describe, expect, it } from 'vitest';
import { CLIENT_CLOCK, ClientClock } from '../src/net/clientClock.js';

interface Device {
  clock: ClientClock;
  now: () => number;
  /** Moves the device clock forward. */
  tick: (ms: number) => void;
  /** A ping received now whose server stamp puts the server `offset` ms ahead of the device. */
  ping: (offset: number) => void;
}

/** A device whose clock the test moves by hand; pings of one series arrive 200 ms apart. */
function device(start = 10_000): Device {
  let t = start;
  const clock = new ClientClock(() => t);
  return {
    clock,
    now: () => t,
    tick: (ms) => {
      t += ms;
    },
    ping: (offset) => {
      clock.onPing(t + offset);
    },
  };
}

/** One series: `offsets` pings 200 ms apart (the first one now). */
function series(d: Device, offsets: number[]): void {
  offsets.forEach((offset, i) => {
    if (i > 0) d.tick(200);
    d.ping(offset);
  });
}

describe('CLIENT_CLOCK', () => {
  it('three samples to trust, eight kept, a gap of a second opens a new series (as the server sends them)', () => {
    expect(CLIENT_CLOCK).toEqual({ minSamples: 3, maxSamples: 8, seriesGapMs: 1000 });
  });
});

describe('ClientClock', () => {
  it('now() is the injected device reading', () => {
    const d = device(10_000);
    expect(d.clock.now()).toBe(10_000);
    d.tick(5);
    expect(d.clock.now()).toBe(10_005);
  });

  it('onPing answers with the pong carrying the server stamp and the device reading as clientTime', () => {
    const d = device(10_000);
    expect(d.clock.onPing(15_000)).toEqual({ type: 'clock-pong', serverSent: 15_000, clientTime: 10_000 });
  });

  it('an explicit receivedAt (a ping read late) is the clientTime of the pong', () => {
    const d = device(10_000);
    expect(d.clock.onPing(15_000, 9_990)).toEqual({ type: 'clock-pong', serverSent: 15_000, clientTime: 9_990 });
  });

  it('has no estimate before three samples: offset null, not ready, no translation either way', () => {
    const d = device();
    for (let samples = 0; samples < CLIENT_CLOCK.minSamples; samples += 1) {
      expect(d.clock.offset()).toBeNull();
      expect(d.clock.ready()).toBe(false);
      expect(d.clock.toServer(d.now())).toBeNull();
      expect(d.clock.toClient(d.now())).toBeNull();
      d.tick(200);
      d.ping(5000);
    }
    expect(d.clock.ready()).toBe(true);
  });

  it('three pings 200 ms apart with the server 5 s ahead give offset 5000: toServer adds it, toClient subtracts it', () => {
    const d = device(10_000);
    series(d, [5000, 5000, 5000]);
    expect(d.clock.ready()).toBe(true);
    expect(d.clock.offset()).toBe(5000);
    expect(d.clock.toServer(10_400)).toBe(15_400);
    expect(d.clock.toClient(15_400)).toBe(10_400);
  });

  it('the offset is the median of the series: three samples 5000, 5000, 9000 give 5000', () => {
    const d = device();
    series(d, [5000, 5000, 9000]);
    expect(d.clock.offset()).toBe(5000);
  });

  it('the median of an even count is the mean of the two middle values (as the server ClockSync does): 5000, 5000, 9000, 9000 give 7000', () => {
    const d = device();
    series(d, [5000, 5000, 9000, 9000]);
    expect(d.clock.offset()).toBe(7000);
  });

  it('only the newest eight samples of a series count: a wild first sample is dropped by the ninth', () => {
    const d = device();
    series(d, [100_000, 5000, 5000, 5000, 5000, 9000, 9000, 9000, 9000]);
    // Kept: four at 5000 and four at 9000 → 7000; had the wild sample stayed, the median of nine would be 9000.
    expect(d.clock.offset()).toBe(7000);
  });

  it('a ping 999 ms after the previous one (device clock) is the same series; 1000 ms later it starts a new one', () => {
    const same = device();
    same.ping(5000);
    same.tick(200);
    same.ping(5000);
    same.tick(999);
    same.ping(5000);
    expect(same.clock.ready()).toBe(true);

    const fresh = device();
    fresh.ping(5000);
    fresh.tick(200);
    fresh.ping(5000);
    fresh.tick(1000);
    fresh.ping(5000);
    expect(fresh.clock.ready()).toBe(false);
  });

  it('a new series keeps the old estimate until it has three samples, then its median replaces it', () => {
    const d = device();
    series(d, [5000, 5000, 5000]);
    expect(d.clock.offset()).toBe(5000);
    d.tick(1500);
    d.ping(7000);
    expect(d.clock.offset()).toBe(5000);
    d.tick(200);
    d.ping(7000);
    expect(d.clock.offset()).toBe(5000);
    d.tick(200);
    d.ping(7000);
    expect(d.clock.offset()).toBe(7000);
    expect(d.clock.toServer(d.now())).toBe(d.now() + 7000);
  });

  it('a series that stalls after two samples never blanks a working estimate', () => {
    const d = device();
    series(d, [5000, 5000, 5000]);
    d.tick(1500);
    series(d, [7000, 7000]);
    expect(d.clock.ready()).toBe(true);
    expect(d.clock.offset()).toBe(5000);
    expect(d.clock.toClient(20_000)).toBe(15_000);
  });

  it('samples use the explicit receivedAt when one is passed, not the reading at the call', () => {
    const d = device(10_000);
    for (let i = 0; i < 3; i += 1) {
      d.clock.onPing(d.now() + 5000, d.now() - 10);
      d.tick(200);
    }
    expect(d.clock.offset()).toBe(5010);
  });
});

describe("ClientClock with the server's own offset (audit K1 r3 #5)", () => {
  it("once the server's offset (its ClockSync.offsetMs, client − server) is heard it is the translation, exactly as the server translates", () => {
    const d = device(10_000);
    series(d, [5000, 5000, 5000]); // the own estimate: server 5000 ahead, biased by the one-way delay
    expect(d.clock.offset()).toBe(5000);
    d.clock.onServerOffset(-4980); // the server measured client − server = −4980 (mid-point of the round trip)
    expect(d.clock.offset()).toBe(4980);
    expect(d.clock.toServer(10_400)).toBe(10_400 + 4980); // = 10 400 − (−4980): the server's toServerTime
    expect(d.clock.toClient(15_380)).toBe(10_400);
    expect(d.clock.ready()).toBe(true);
  });

  it("later pings never move it (the own estimate counts only until the server's is known); a newer server offset replaces it", () => {
    const d = device(10_000);
    series(d, [5000, 5000, 5000]);
    d.clock.onServerOffset(-4980);
    d.tick(1500);
    series(d, [7000, 7000, 7000]);
    expect(d.clock.offset()).toBe(4980);
    d.clock.onServerOffset(-4990.5);
    expect(d.clock.offset()).toBe(4990.5);
    expect(d.clock.toServer(1000)).toBe(5990.5);
  });

  it("the server's offset alone makes the clock ready (no own series yet)", () => {
    const d = device(10_000);
    expect(d.clock.ready()).toBe(false);
    d.clock.onServerOffset(250);
    expect(d.clock.ready()).toBe(true);
    expect(d.clock.toServer(10_000)).toBe(9_750);
  });

  it('a value that is not a finite number is ignored', () => {
    const d = device(10_000);
    series(d, [5000, 5000, 5000]);
    d.clock.onServerOffset(Number.NaN);
    d.clock.onServerOffset(Number.POSITIVE_INFINITY);
    expect(d.clock.offset()).toBe(5000);
  });
});
