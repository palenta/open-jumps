// Results waiting to be written (matrix row 8: "результат записан один раз"). The queue belongs to the process,
// not to a room: a room that is disposed while storage is down leaves its rows here, and the outbox keeps
// retrying on its own schedule until every row has landed. insertOnce is idempotent, so a retry after a
// half-way failure can never duplicate a row.
import type { ResultRecord, ResultRepository } from '../storage/repositories.js';

export const OUTBOX = {
  /** Minimum time between two attempts after a failure. */
  retryMs: 1000,
} as const;

const keyOf = (record: ResultRecord): string => `${record.roundId}|${record.accountId}`;

export class ResultOutbox {
  private readonly results: ResultRepository;
  private readonly clock: () => number;
  private readonly queue: ResultRecord[] = [];
  /** Keys of the rows waiting in the queue (a pending row is accepted once; a written one is forgotten, the
   * repository's idempotent insertOnce makes a later re-delivery harmless — no unbounded memory on a long-lived server). */
  private readonly pending = new Set<string>();
  private inflight: Promise<void> | null = null;
  private nextAttemptAt = 0;

  constructor(results: ResultRepository, clock: () => number = Date.now) {
    this.results = results;
    this.clock = clock;
  }

  /** Rows still waiting. */
  get size(): number {
    return this.queue.length;
  }

  /** Keys currently remembered (only the waiting rows). */
  get pendingKeys(): number {
    return this.pending.size;
  }

  /** Queue rows (a key already waiting is ignored); call flush() to write them now. */
  add(records: readonly ResultRecord[]): void {
    for (const record of records) {
      const key = keyOf(record);
      if (this.pending.has(key)) continue;
      this.pending.add(key);
      this.queue.push({ ...record });
    }
  }

  /**
   * Write the queued rows in order. A failure keeps the row (and those behind it) and postpones the next
   * attempt by OUTBOX.retryMs; concurrent callers share one attempt. Resolves when the attempt is over.
   */
  flush(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.queue.length === 0 || this.clock() < this.nextAttemptAt) return Promise.resolve();
    this.inflight = this.attempt().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async attempt(): Promise<void> {
    while (this.queue.length > 0) {
      const record = this.queue[0]!;
      try {
        await this.results.insertOnce(record);
      } catch {
        this.nextAttemptAt = this.clock() + OUTBOX.retryMs;
        return;
      }
      this.queue.shift();
      this.pending.delete(keyOf(record));
    }
  }
}
