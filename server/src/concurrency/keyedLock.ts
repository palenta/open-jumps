// Per-key async mutex. The server is one Node process whose repositories are synchronous inside each call, so
// interleaving happens only at `await` points; a "check, then write" sequence stays correct only if every call
// that touches the same key (an account id) runs after the previous one finished. Used by the account and
// club services (matrix rows 13 and 21: lockout counting, PIN reset vs login, one club per rider).

/** Serialises async work per key; the lock is released even when the work throws. */
export class KeyedLock {
  /** The tail of the promise chain per key, removed once nobody holds or awaits the key. */
  private readonly tails = new Map<string, Promise<void>>();

  /** Keys currently held or awaited (for tests). */
  get size(): number {
    return this.tails.size;
  }

  /** Run `work` after every earlier call for `key` has settled, holding the key until `work` settles. */
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
