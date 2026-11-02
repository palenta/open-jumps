// Matrix row 3 (plan 2.3 "three times"): packet age, future taps, the decision deadline and immediate decisions.
import { describe, expect, it } from 'vitest';
import { AttemptJudge, PACKET, classifyTapPacket, decisionDeadline, type TapPacket } from '../src/rules/packetTiming.js';

const t0 = 10_000;
const packet = (actionTime: number, receiveTime: number, over: Partial<TapPacket> = {}): TapPacket => ({
  actionTime,
  receiveTime,
  fence: 3,
  attempt: 1,
  ...over,
});

describe('constants and deadline', () => {
  it('max age 300, max future 100, last action +400, margin 300', () => {
    expect(PACKET).toMatchObject({ maxAgeMs: 300, maxFutureMs: 100, lastActionOffsetMs: 400, marginMs: 300 });
  });

  it('deadline = t0 + 400 + 300 = t0 + 700', () => {
    expect(decisionDeadline(t0)).toBe(t0 + 700);
  });
});

describe('classifyTapPacket', () => {
  it('plan example: action t0+150 with 200 ms delay → accepted, offset +150', () => {
    expect(classifyTapPacket(packet(t0 + 150, t0 + 350), t0)).toEqual({ accepted: true, offsetMs: 150 });
  });

  it('plan example: action t0−180 with 400 ms delay → too old', () => {
    expect(classifyTapPacket(packet(t0 - 180, t0 + 220), t0)).toEqual({ accepted: false, reason: 'too-old' });
  });

  it('age exactly 300 ms is accepted, 301 is not', () => {
    expect(classifyTapPacket(packet(t0, t0 + 300), t0).accepted).toBe(true);
    expect(classifyTapPacket(packet(t0, t0 + 301), t0)).toEqual({ accepted: false, reason: 'too-old' });
  });

  it('a tap from the future beyond 100 ms is rejected, 100 ms is tolerated', () => {
    expect(classifyTapPacket(packet(t0 + 150, t0), t0)).toEqual({ accepted: false, reason: 'future' });
    expect(classifyTapPacket(packet(t0 + 100, t0), t0).accepted).toBe(true);
  });

  it('a packet received after the deadline is rejected even if its age is fine', () => {
    expect(classifyTapPacket(packet(t0 + 450, t0 + 701), t0)).toEqual({ accepted: false, reason: 'after-deadline' });
  });

  it('a packet received exactly at the deadline is accepted', () => {
    expect(classifyTapPacket(packet(t0 + 400, t0 + 700), t0).accepted).toBe(true);
  });

  it('action exactly t0+400 is accepted with offset 400 (the judge calls it chip)', () => {
    expect(classifyTapPacket(packet(t0 + 400, t0 + 450), t0)).toEqual({ accepted: true, offsetMs: 400 });
  });

  it('an early tap is accepted with a negative offset', () => {
    expect(classifyTapPacket(packet(t0 - 120, t0 - 20), t0)).toEqual({ accepted: true, offsetMs: -120 });
  });
});

describe('AttemptJudge: when the attempt is decided', () => {
  it('the first accepted tap decides immediately, at its receive time, not at the deadline', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    const result = judge.submit(packet(t0 + 150, t0 + 200));
    expect(result.verdict).toEqual({ accepted: true, offsetMs: 150 });
    expect(result.decision).toEqual({ decided: true, offsetMs: 150, decidedAt: t0 + 200 });
    expect(judge.decision).toEqual({ decided: true, offsetMs: 150, decidedAt: t0 + 200 });
  });

  it('a second packet with the same key is a duplicate and changes nothing', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    judge.submit(packet(t0 + 150, t0 + 200));
    const again = judge.submit(packet(t0 + 10, t0 + 220));
    expect(again.verdict).toEqual({ accepted: false, reason: 'duplicate' });
    expect(judge.decision).toEqual({ decided: true, offsetMs: 150, decidedAt: t0 + 200 });
  });

  it('a packet for another fence or attempt is rejected as wrong-attempt', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    expect(judge.submit(packet(t0, t0 + 50, { fence: 4 })).verdict).toEqual({ accepted: false, reason: 'wrong-attempt' });
    expect(judge.submit(packet(t0, t0 + 50, { attempt: 2 })).verdict).toEqual({ accepted: false, reason: 'wrong-attempt' });
    expect(judge.decision).toEqual({ decided: false });
  });

  it('without an accepted tap, "no tap" is not fixed before the deadline', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    expect(judge.tick(t0 + 400)).toEqual({ decided: false });
    expect(judge.tick(t0 + 699)).toEqual({ decided: false });
  });

  it('"no tap" is fixed exactly at the deadline', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    expect(judge.tick(t0 + 700)).toEqual({ decided: true, offsetMs: null, decidedAt: t0 + 700 });
  });

  it('plan example: a too-old packet does not decide; the attempt waits for the deadline', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    const late = judge.submit(packet(t0 - 180, t0 + 220));
    expect(late.verdict).toEqual({ accepted: false, reason: 'too-old' });
    expect(late.decision).toEqual({ decided: false });
    expect(judge.tick(t0 + 699)).toEqual({ decided: false });
    expect(judge.tick(t0 + 700)).toEqual({ decided: true, offsetMs: null, decidedAt: t0 + 700 });
  });

  it('once decided, later ticks keep the decision', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    judge.submit(packet(t0 + 150, t0 + 350));
    expect(judge.tick(t0 + 900)).toEqual({ decided: true, offsetMs: 150, decidedAt: t0 + 350 });
  });

  it('a packet arriving after "no tap" was fixed is rejected as after-deadline', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    judge.tick(t0 + 700);
    expect(judge.submit(packet(t0 + 400, t0 + 701)).verdict).toEqual({ accepted: false, reason: 'after-deadline' });
  });
});

describe('AttemptJudge: the deadline boundary and processing order (plan 2.3)', () => {
  it('a packet received exactly at the deadline, submitted before the tick of that time, keeps the tap', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    const result = judge.submit(packet(t0 + 400, t0 + 700));
    expect(result.verdict).toEqual({ accepted: true, offsetMs: 400 });
    expect(judge.tick(t0 + 700)).toEqual({ decided: true, offsetMs: 400, decidedAt: t0 + 700 });
  });

  it('a packet received one millisecond after the deadline does not change the final "no tap"', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    judge.tick(t0 + 700);
    const late = judge.submit(packet(t0 + 400, t0 + 701));
    expect(late.verdict).toEqual({ accepted: false, reason: 'after-deadline' });
    expect(judge.decision).toEqual({ decided: true, offsetMs: null, decidedAt: t0 + 700 });
  });

  it('submitting a packet not later than the last tick violates the ordering contract and throws', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    judge.tick(t0 + 650);
    expect(() => judge.submit(packet(t0 + 400, t0 + 650))).toThrow(/order/);
    expect(() => judge.submit(packet(t0 + 300, t0 + 640))).toThrow(/order/);
    expect(judge.submit(packet(t0 + 400, t0 + 651)).verdict).toEqual({ accepted: true, offsetMs: 400 });
  });

  it('the same rule at the deadline itself: tick(t0+700) first, then a packet stamped t0+700 is an ordering error, not a lost tap', () => {
    const judge = new AttemptJudge(t0, 3, 1);
    judge.tick(t0 + 700);
    expect(() => judge.submit(packet(t0 + 400, t0 + 700))).toThrow(/order/);
  });
});
