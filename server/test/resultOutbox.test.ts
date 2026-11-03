// Matrix row 8 ("результат записан один раз") against storage trouble: queued results survive the room that
// produced them and are retried on their own schedule until every row has landed exactly once.
import { describe, expect, it } from 'vitest';
import { ResultOutbox, OUTBOX } from '../src/round/resultOutbox.js';
import type { ResultRecord, ResultRepository } from '../src/storage/repositories.js';
import { createMemoryRepositories } from '../src/storage/memory.js';

const record = (roundId: string, accountId: string, over: Partial<ResultRecord> = {}): ResultRecord => ({
  roundId, accountId, courseId: 'c', courseVersion: 1, rulesVersion: 1, heightClass: 60, faults: 0, timeMs: 1000, status: 'finished',
  eliminationReason: null, autopilot: false, schoolmaster: false, mode: 'ranked', seed: 's', recordedAt: 1, ...over,
});

/** A repository whose next `failures` insertOnce calls reject (storage trouble), counting every call. */
function flakyResults(failures: number): { repo: ResultRepository; calls: () => number } {
  const inner = createMemoryRepositories().results;
  let calls = 0;
  let left = failures;
  const repo: ResultRepository = {
    insertOnce: async (r) => {
      calls += 1;
      if (left > 0) {
        left -= 1;
        throw new Error('storage unavailable');
      }
      return inner.insertOnce(r);
    },
    get: (roundId, accountId) => inner.get(roundId, accountId),
    listByRound: (roundId) => inner.listByRound(roundId),
    listByAccount: (accountId) => inner.listByAccount(accountId),
  };
  return { repo, calls: () => calls };
}

describe('ResultOutbox', () => {
  it('retries no more often than the interval and keeps the order; a success drains the queue', async () => {
    expect(OUTBOX.retryMs).toBe(1000);
    const clock = { now: 10_000 };
    const { repo, calls } = flakyResults(2);
    const outbox = new ResultOutbox(repo, () => clock.now);
    outbox.add([record('r1', 'ana'), record('r1', 'bea')]);
    await outbox.flush(); // first attempt: ana fails
    expect(calls()).toBe(1);
    expect(outbox.size).toBe(2);
    await outbox.flush(); // too soon: no attempt
    expect(calls()).toBe(1);
    clock.now += OUTBOX.retryMs;
    await outbox.flush(); // ana fails again
    expect(calls()).toBe(2);
    clock.now += OUTBOX.retryMs;
    await outbox.flush(); // ana lands, then bea in the same pass
    expect(calls()).toBe(4);
    expect(outbox.size).toBe(0);
    expect((await repo.listByRound('r1')).map((r) => r.accountId)).toEqual(['ana', 'bea']);
  });

  it('a row queued twice while waiting is written once; a re-delivery after it landed is harmless and leaves no key behind', async () => {
    const clock = { now: 0 };
    const { repo, calls } = flakyResults(0);
    const outbox = new ResultOutbox(repo, () => clock.now);
    outbox.add([record('r1', 'ana', { faults: 4 })]);
    outbox.add([record('r1', 'ana', { faults: 8 })]); // the same key while waiting: ignored
    await outbox.flush();
    expect(calls()).toBe(1);
    expect((await repo.get('r1', 'ana'))?.faults).toBe(4);
    expect(outbox.pendingKeys).toBe(0); // written rows are forgotten: memory does not grow with the rounds played
    outbox.add([record('r1', 'ana', { faults: 12 })]); // delivered again later: the idempotent repository keeps the first row
    clock.now += OUTBOX.retryMs;
    await outbox.flush();
    expect(calls()).toBe(2);
    expect((await repo.get('r1', 'ana'))?.faults).toBe(4);
    expect(outbox.pendingKeys).toBe(0);
  });

  it('flush is reentrancy-safe and the queue outlives the caller: a later flush writes what an earlier one could not', async () => {
    const clock = { now: 0 };
    const { repo, calls } = flakyResults(1);
    const outbox = new ResultOutbox(repo, () => clock.now);
    outbox.add([record('r2', 'cris')]);
    await Promise.all([outbox.flush(), outbox.flush()]); // one of them waits/returns; a single attempt
    expect(calls()).toBe(1);
    expect(outbox.size).toBe(1);
    clock.now += OUTBOX.retryMs;
    await outbox.flush();
    expect(outbox.size).toBe(0);
    expect(await repo.get('r2', 'cris')).not.toBeNull();
  });
});
