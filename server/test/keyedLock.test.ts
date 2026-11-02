// A per-key async mutex: the building block that makes "check, then write" sequences in the services atomic
// with respect to other calls for the same account (matrix rows 13 and 21: lockout and membership invariants).
import { describe, expect, it } from 'vitest';
import { KeyedLock } from '../src/concurrency/keyedLock.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('KeyedLock', () => {
  it('calls with the same key run one after another in call order; different keys interleave', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const step = (name: string, key: string) =>
      lock.run(key, async () => {
        log.push(`${name}:start`);
        await tick(5);
        log.push(`${name}:end`);
      });
    await Promise.all([step('a1', 'a'), step('a2', 'a'), step('b1', 'b')]);
    expect(log.indexOf('a1:end')).toBeLessThan(log.indexOf('a2:start'));
    expect(log.indexOf('b1:start')).toBeLessThan(log.indexOf('a1:end'));
    expect(lock.size).toBe(0);
  });

  it('returns the work result and releases the key even when the work throws', async () => {
    const lock = new KeyedLock();
    await expect(lock.run('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lock.run('a', async () => 42)).toBe(42);
    expect(lock.size).toBe(0);
  });

  it('a waiter sees the state left by the previous holder (check-then-write is atomic per key)', async () => {
    const lock = new KeyedLock();
    let slot: string | null = null;
    const claim = (who: string) =>
      lock.run('rider', async () => {
        if (slot !== null) return false;
        await tick(2); // the window where an unserialised second call would also see null
        slot = who;
        return true;
      });
    const results = await Promise.all([claim('A'), claim('B'), claim('C')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(slot).toBe('A');
  });
});
