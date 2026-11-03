// Plan 2.3: the server measures each client's clock offset as the median of a ping/pong series.
import { describe, expect, it } from 'vitest';
import { CLOCK_SYNC, ClockSync } from '../src/round/clockSync.js';

/** A client whose clock runs `offset` ms ahead of the server, answering after `rtt` ms. */
const sample = (serverSent: number, offset: number, rtt: number) => ({
  serverSent,
  clientTime: serverSent + rtt / 2 + offset,
  serverReceived: serverSent + rtt,
});

describe('ClockSync', () => {
  it('constants: 8 samples kept, 3 needed, round trips over 1000 ms discarded', () => {
    expect(CLOCK_SYNC).toEqual({ samples: 8, minSamples: 3, maxRttMs: 1000 });
  });

  it('is not ready before three valid samples and then reports the median offset and rtt', () => {
    const sync = new ClockSync();
    expect(sync.ready).toBe(false);
    expect(sync.offsetMs).toBeNull();
    expect(sync.rttMs).toBeNull();
    expect(sync.toServerTime(1000)).toBeNull();
    sync.addSample(sample(1000, 500, 40));
    sync.addSample(sample(1200, 500, 60));
    expect(sync.ready).toBe(false);
    sync.addSample(sample(1400, 500, 50));
    expect(sync.ready).toBe(true);
    expect(sync.offsetMs).toBe(500);
    expect(sync.rttMs).toBe(50);
    expect(sync.toServerTime(10_500)).toBe(10_000);
  });

  it('the median ignores one wild sample and negative offsets work too', () => {
    const sync = new ClockSync();
    sync.addSample(sample(1000, -300, 40));
    sync.addSample(sample(1200, -300, 40));
    sync.addSample(sample(1400, 2000, 40)); // a tab that stalled between ping and pong
    sync.addSample(sample(1600, -300, 40));
    sync.addSample(sample(1800, -300, 40));
    expect(sync.offsetMs).toBe(-300);
    expect(sync.toServerTime(700)).toBe(1000);
  });

  it('samples with a round trip over the maximum or negative are ignored', () => {
    const sync = new ClockSync();
    sync.addSample(sample(1000, 100, 1500));
    sync.addSample({ serverSent: 1200, clientTime: 1300, serverReceived: 1100 });
    sync.addSample(sample(1400, 100, 1000)); // exactly the maximum counts
    expect(sync.ready).toBe(false);
    sync.addSample(sample(1600, 100, 20));
    sync.addSample(sample(1800, 100, 20));
    expect(sync.ready).toBe(true);
    expect(sync.offsetMs).toBe(100);
  });

  it('keeps only the newest eight samples, so the offset follows a clock that drifted', () => {
    const sync = new ClockSync();
    for (let i = 0; i < 8; i += 1) sync.addSample(sample(1000 + i * 200, 0, 40));
    expect(sync.offsetMs).toBe(0);
    for (let i = 0; i < 8; i += 1) sync.addSample(sample(5000 + i * 200, 250, 40));
    expect(sync.offsetMs).toBe(250);
  });
});
