// Audit K1 r5 #1: the game clock is the wall read once plus the monotonic time elapsed since, in whole milliseconds; a
// step of the wall after composition changes nothing. The live room uses it for every game time (see
// classRoomWallClock.test.ts and classRoomSystemClock.test.ts for the room itself).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TIME, composeGameClock } from '../src/round/gameClock.js';
import { OUTBOX, ResultOutbox } from '../src/round/resultOutbox.js';
import type { ResultRecord, ResultRepository } from '../src/storage/repositories.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('composeGameClock (audit K1 r5 #1)', () => {
  it('reads the wall once: then it moves with the monotonic clock only, whatever the wall does', () => {
    const wall = { now: 1_700_000_000_000 };
    const monotonic = { now: 12_345.678 };
    const game = composeGameClock({ wall: () => wall.now, monotonic: () => monotonic.now });
    expect(game()).toBe(1_700_000_000_000);
    wall.now -= 65; // macOS timed, 19:07:56
    expect(game()).toBe(1_700_000_000_000);
    monotonic.now += 250;
    wall.now += 3_600_000;
    expect(game()).toBe(1_700_000_000_250);
    wall.now -= 7_200_000;
    monotonic.now += 1;
    expect(game()).toBe(1_700_000_000_251);
  });

  it('whole milliseconds that never decrease: a fractional monotonic reading is floored', () => {
    const monotonic = { now: 0.9 };
    const game = composeGameClock({ wall: () => 5_000, monotonic: () => monotonic.now });
    const readings: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      monotonic.now += 0.3;
      readings.push(game());
    }
    expect(readings.every((reading) => Number.isInteger(reading))).toBe(true);
    expect(readings.every((reading, index) => index === 0 || reading >= readings[index - 1]!)).toBe(true);
    expect(readings.at(-1)).toBe(5_012); // 40 × 0.3 ms = 12 ms elapsed
  });

  it('the system sources: the wall is Date.now(), the pace is performance.now() — a stepped Date.now() does not reach the game clock', () => {
    let shift = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + shift);
    expect(Math.abs(SYSTEM_TIME.wall() - realNow())).toBeLessThan(50);
    const game = composeGameClock(SYSTEM_TIME);
    const first = game();
    shift = -3_600_000;
    const second = game();
    expect(second).toBeGreaterThanOrEqual(first);
    expect(second - first).toBeLessThan(1_000);
    expect(Math.abs(SYSTEM_TIME.monotonic() - performance.now())).toBeLessThan(50);
  });
});

describe('ResultOutbox default clock (audit K1 r5 #1)', () => {
  it('measures the retry delay on the monotonic clock: a Date.now() stepped forward an hour does not hurry the retry', async () => {
    const calls: string[] = [];
    let fail = 1;
    const repo: ResultRepository = {
      insertOnce: async (record) => {
        calls.push(record.roundId);
        if (fail > 0) {
          fail -= 1;
          throw new Error('storage unavailable (test)');
        }
        return true;
      },
      get: async () => null,
      listByRound: async () => [],
      listByAccount: async () => [],
    };
    const record: ResultRecord = {
      roundId: 'r#0', accountId: 'a', courseId: 'c', courseVersion: 1, rulesVersion: 1, heightClass: 60, faults: 0, timeMs: 1,
      status: 'finished', eliminationReason: null, autopilot: false, schoolmaster: false, mode: 'ranked', seed: 's', recordedAt: 1,
    };
    const monotonic = { now: 1_000 };
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic.now);
    let shift = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + shift);
    const outbox = new ResultOutbox(repo);
    outbox.add([record]);
    await outbox.flush();
    shift = 3_600_000;
    await outbox.flush();
    expect(calls).toEqual(['r#0']);
    monotonic.now += OUTBOX.retryMs;
    await outbox.flush();
    expect(calls).toEqual(['r#0', 'r#0']);
    expect(outbox.size).toBe(0);
  });
});
