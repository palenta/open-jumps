// Matrix rows 4 and 7 (plan 1.8, 1.11): fences, attempts, disobedience numbering, falls, finish and time.
import { describe, expect, it } from 'vitest';
import { RiderRound } from '../src/rules/attempts.js';
import type { TakeoffOutcome } from '../src/rules/takeoff.js';

const clean: TakeoffOutcome = { kind: 'clean', faults: 0, cleared: true, label: 'cero_faltas', horseJumped: true };
const chip: TakeoffOutcome = { kind: 'chip', faults: 4, cleared: true, label: 'batida_corta', horseJumped: true };
const refusal: TakeoffOutcome = { kind: 'refusal', faults: 0, cleared: false, label: 'rehuse', horseJumped: false };
const runout: TakeoffOutcome = { kind: 'runout', faults: 0, cleared: false, label: 'desvio', horseJumped: false };
const fall: TakeoffOutcome = { kind: 'fall', faults: 8, cleared: false, label: 'caida', horseJumped: true };
const refusalWithFall: TakeoffOutcome = { kind: 'refusal', faults: 8, cleared: false, label: 'rehuse', horseJumped: false };

describe('a fresh round', () => {
  it('starts at fence 1, attempt 1, riding, no faults', () => {
    const r = new RiderRound(8);
    expect(r.currentFence).toBe(1);
    expect(r.currentAttempt).toBe(1);
    expect(r.status).toBe('riding');
    expect(r.faults).toBe(0);
    expect(r.entries).toEqual([]);
  });

  it('needs at least one fence (RangeError)', () => {
    expect(() => new RiderRound(0)).toThrow(RangeError);
  });
});

describe('clearing fences', () => {
  it('a clean jump moves to the next fence, attempt 1', () => {
    const r = new RiderRound(8);
    r.recordOutcome(clean);
    expect(r.currentFence).toBe(2);
    expect(r.currentAttempt).toBe(1);
    expect(r.faults).toBe(0);
  });

  it('a chip adds 4 faults and still moves on', () => {
    const r = new RiderRound(8);
    r.recordOutcome(chip);
    expect(r.faults).toBe(4);
    expect(r.currentFence).toBe(2);
    expect(r.entries).toEqual([{ fence: 1, attempt: 1, kind: 'chip', faults: 4, label: 'batida_corta' }]);
  });

  it('the entries view is a copy: mutating it never changes the round\'s own log or total', () => {
    const r = new RiderRound(8);
    r.recordOutcome(chip);
    const view = r.entries as unknown as { faults: number }[];
    view[0]!.faults = 0;
    view.length = 0;
    expect(r.faults).toBe(4);
    expect(r.entries).toEqual([{ fence: 1, attempt: 1, kind: 'chip', faults: 4, label: 'batida_corta' }]);
  });
});

describe('disobediences: 4, 8, elimination; the fence stays obligatory', () => {
  it('a refusal keeps the fence, increments the attempt and costs 4', () => {
    const r = new RiderRound(8);
    r.recordOutcome(refusal);
    expect(r.currentFence).toBe(1);
    expect(r.currentAttempt).toBe(2);
    expect(r.faults).toBe(4);
  });

  it('the second disobedience anywhere in the round costs 8 (total 12)', () => {
    const r = new RiderRound(8);
    r.recordOutcome(refusal);
    r.recordOutcome(clean);
    r.recordOutcome(runout);
    expect(r.faults).toBe(12);
    expect(r.currentFence).toBe(2);
    expect(r.currentAttempt).toBe(2);
  });

  it('the third disobedience eliminates and freezes the round', () => {
    const r = new RiderRound(8);
    r.recordOutcome(refusal);
    r.recordOutcome(refusal);
    r.recordOutcome(runout);
    expect(r.status).toBe('eliminated');
    expect(r.eliminationReason).toBe('refusals');
    expect(() => r.recordOutcome(clean)).toThrow(/eliminated/);
  });

  it('after a refusal the same fence must still be jumped (no skipping)', () => {
    const r = new RiderRound(2);
    r.recordOutcome(refusal);
    r.recordOutcome(clean);
    expect(r.currentFence).toBe(2);
  });
});

describe('falls', () => {
  it('a fall costs 8, keeps the fence and is not a disobedience', () => {
    const r = new RiderRound(8);
    r.recordOutcome(fall);
    expect(r.faults).toBe(8);
    expect(r.currentFence).toBe(1);
    expect(r.currentAttempt).toBe(2);
    r.recordOutcome(refusal);
    r.recordOutcome(refusal);
    expect(r.status).toBe('riding');
    expect(r.faults).toBe(8 + 4 + 8);
  });

  it('a refusal with a fall (gallop, no tap) costs 8 for the fall plus the disobedience number', () => {
    const r = new RiderRound(8);
    r.recordOutcome(refusalWithFall);
    expect(r.faults).toBe(8 + 4);
    expect(r.currentAttempt).toBe(2);
  });
});

describe('finishing', () => {
  it('after the last fence the rider heads to the finish; finish within time keeps the faults', () => {
    const r = new RiderRound(2);
    r.recordOutcome(clean);
    r.recordOutcome(chip);
    expect(r.currentFence).toBe(3);
    expect(r.status).toBe('riding');
    r.finish(50, 60);
    expect(r.status).toBe('finished');
    expect(r.faults).toBe(4);
  });

  it('finishing over the time allowed adds one fault per started second as a time entry', () => {
    const r = new RiderRound(1);
    r.recordOutcome(clean);
    r.finish(61.5, 60);
    expect(r.faults).toBe(2);
    expect(r.entries.at(-1)).toMatchObject({ kind: 'time', faults: 2 });
  });

  it('finishing at the limit is an elimination by time', () => {
    const r = new RiderRound(1);
    r.recordOutcome(clean);
    r.finish(120, 60);
    expect(r.status).toBe('eliminated');
    expect(r.eliminationReason).toBe('time');
  });

  it('cannot finish with fences left', () => {
    const r = new RiderRound(2);
    r.recordOutcome(clean);
    expect(() => r.finish(30, 60)).toThrow(/fences left/);
  });

  it('the limit reached on course eliminates by time', () => {
    const r = new RiderRound(8);
    r.recordOutcome(clean);
    r.timeOut();
    expect(r.status).toBe('eliminated');
    expect(r.eliminationReason).toBe('time');
  });
});

describe('withdrawal: the rider left the room or never came back after a disconnection', () => {
  it('withdraw("disconnected") while riding eliminates with that reason; faults, entries and position stay as they were', () => {
    const r = new RiderRound(8);
    r.recordOutcome(chip);
    r.recordOutcome(refusal);
    const entriesBefore = r.entries;
    r.withdraw('disconnected');
    expect(r.status).toBe('eliminated');
    expect(r.eliminationReason).toBe('disconnected');
    expect(r.faults).toBe(8);
    expect(r.entries).toEqual(entriesBefore);
    expect(r.entries).toHaveLength(2);
    expect(r.currentFence).toBe(2);
    expect(r.currentAttempt).toBe(2);
  });

  it('after a withdrawal the round is over: recordOutcome, finish and withdraw all throw', () => {
    const r = new RiderRound(1);
    r.withdraw('disconnected');
    expect(() => r.recordOutcome(clean)).toThrow(/eliminated/);
    expect(() => r.finish(30, 60)).toThrow(/eliminated/);
    expect(() => r.withdraw('disconnected')).toThrow(/eliminated/);
  });

  it('a rider already eliminated by time cannot be withdrawn', () => {
    const r = new RiderRound(8);
    r.timeOut();
    expect(() => r.withdraw('disconnected')).toThrow(/eliminated/);
    expect(r.eliminationReason).toBe('time');
  });

  it('a rider who has finished cannot be withdrawn', () => {
    const r = new RiderRound(1);
    r.recordOutcome(clean);
    r.finish(30, 60);
    expect(() => r.withdraw('disconnected')).toThrow(/finished/);
    expect(r.status).toBe('finished');
  });
});
