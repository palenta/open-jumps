// The doorbell from the visitor's side (plan 1.5): the host creates a room and gets the code and the live
// roomId; a visitor enters the code, rings (knock), waits while the host decides (status polled once a second)
// and gets the roomId once admitted. Pure state machine over the API; the UI subscribes.
import type { ApiFailure, GameApi } from '../net/api.js';

export const LOBBY_FLOW = {
  pollMs: 1000,
  /** Stop polling after this many polls (10 minutes): the visitor can ring again. */
  maxPolls: 600,
  /** Room codes: 6 characters from the server's alphabet (no look-alikes); input is upper-cased, spaces and dashes dropped. */
  codeLength: 6,
} as const;

export type LobbyRefusal = 'denied' | 'kicked' | 'closed' | 'full' | 'unknown-code' | 'rate-limited' | 'network' | 'timeout' | 'already-in';

export type LobbyPhase =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'knocking'; code: string }
  | { kind: 'waiting'; code: string; polls: number }
  | { kind: 'ready'; code: string; roomId: string; role: 'host' | 'guest' }
  | { kind: 'refused'; code: string; reason: LobbyRefusal; status: number };

export interface LobbyFlowDeps {
  api: Pick<GameApi, 'createRoom' | 'knock' | 'roomStatus'>;
  /** Scheduling for the polls (injectable for tests). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** Upper-case, without spaces or dashes, so "ab c-def" reads "ABCDEF"; other characters are kept for the server to refuse. */
export function normalizeCode(input: string): string {
  return input.trim().replace(/[\s-]+/g, '').toUpperCase();
}

const REFUSALS: ReadonlySet<string> = new Set<LobbyRefusal>([
  'denied',
  'kicked',
  'closed',
  'full',
  'unknown-code',
  'rate-limited',
  'network',
  'timeout',
  'already-in',
]);

/** The server's error code when it is one the lobby knows, otherwise 'network' (offline, or an unexpected answer). */
function refusedBy(code: string, failure: ApiFailure): LobbyPhase {
  const reason: LobbyRefusal = REFUSALS.has(failure.error) ? (failure.error as LobbyRefusal) : 'network';
  return { kind: 'refused', code, reason, status: failure.status };
}

/** A decision the server made in a 200 reply (a rejected knock, a kicked or denied visitor). */
const DECIDED_STATUS = 200;

/**
 * - create(): POST rooms → ready(host) with the roomId; a failure → refused('network' | the error).
 * - enter(code): knock → 'admitted' → status → ready(guest); 'pending' → waiting, then roomStatus every pollMs
 *   until 'admitted'/'host' (ready), 'kicked' (refused 'kicked'), 'none' (refused 'denied' — the host said no),
 *   or maxPolls (refused 'timeout'); 'rejected' → refused with the reason; unknown-code / rate-limited /
 *   network → refused with that reason. A guest who is already admitted (status 'admitted' on knock) goes
 *   straight to ready.
 * - stop(): cancels polling (phase stays as it is). onChange fires on every phase change.
 */
export class LobbyFlow {
  private readonly api: LobbyFlowDeps['api'];
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private current: LobbyPhase = { kind: 'idle' };
  private readonly listeners = new Set<(phase: LobbyPhase) => void>();
  /** The scheduled poll, when one is pending. */
  private timer: unknown = null;
  /** Bumped by every enter() and stop(): a reply from an earlier run (or after a stop) is ignored. */
  private run = 0;
  /** Resolves the promise of the enter() in progress with its terminal phase. */
  private settleEnter: ((phase: LobbyPhase) => void) | null = null;

  constructor(deps: LobbyFlowDeps) {
    this.api = deps.api;
    this.schedule = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.cancel = deps.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  }

  get phase(): LobbyPhase {
    return this.current;
  }

  onChange(listener: (phase: LobbyPhase) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async create(): Promise<LobbyPhase> {
    this.stop();
    this.setPhase({ kind: 'creating' });
    const result = await this.api.createRoom();
    if (!result.ok) return this.setPhase(refusedBy('', result));
    const { code, roomId } = result.value;
    if (roomId === undefined) return this.setPhase({ kind: 'refused', code, reason: 'network', status: 0 });
    return this.setPhase({ kind: 'ready', code, roomId, role: 'host' });
  }

  enter(code: string): Promise<LobbyPhase> {
    this.stop();
    const run = this.run;
    const normalized = normalizeCode(code);
    const done = new Promise<LobbyPhase>((resolve) => {
      this.settleEnter = resolve;
    });
    this.setPhase({ kind: 'knocking', code: normalized });
    void this.knock(run, normalized);
    return done;
  }

  stop(): void {
    this.run += 1;
    if (this.timer !== null) {
      const handle = this.timer;
      this.timer = null;
      this.cancel(handle);
    }
  }

  private setPhase(phase: LobbyPhase): LobbyPhase {
    this.current = phase;
    for (const listener of this.listeners) listener(phase);
    return phase;
  }

  /** A terminal phase of enter(): shown, and handed to whoever awaits enter(). */
  private finish(phase: LobbyPhase): void {
    this.setPhase(phase);
    const settle = this.settleEnter;
    this.settleEnter = null;
    if (settle !== null) settle(phase);
  }

  private async knock(run: number, code: string): Promise<void> {
    const result = await this.api.knock(code);
    if (run !== this.run) return;
    if (!result.ok) {
      this.finish(refusedBy(code, result));
      return;
    }
    const decision = result.value;
    if (decision.status === 'pending') {
      this.wait(run, code, 0);
      return;
    }
    if (decision.status === 'rejected' && decision.reason !== 'already-in') {
      this.finish({ kind: 'refused', code, reason: decision.reason, status: DECIDED_STATUS });
      return;
    }
    // Admitted at once, or already in (a visitor who rang twice, or the host): the status says which room.
    await this.checkStatus(run, code, 0);
  }

  /** One status reading; `polls` is how many polls this one makes (0 for the check right after the knock). */
  private async checkStatus(run: number, code: string, polls: number): Promise<void> {
    const result = await this.api.roomStatus(code);
    if (run !== this.run) return;
    if (!result.ok) {
      this.finish(refusedBy(code, result));
      return;
    }
    const { status, roomId } = result.value;
    switch (status) {
      case 'host':
      case 'admitted':
        if (roomId === undefined) {
          // No live room to join: the same refusal as a room created without one.
          this.finish({ kind: 'refused', code, reason: 'network', status: 0 });
          return;
        }
        this.finish({ kind: 'ready', code, roomId, role: status === 'host' ? 'host' : 'guest' });
        return;
      case 'kicked':
        this.finish({ kind: 'refused', code, reason: 'kicked', status: DECIDED_STATUS });
        return;
      case 'none':
        this.finish({ kind: 'refused', code, reason: 'denied', status: DECIDED_STATUS });
        return;
      case 'pending':
        if (polls >= LOBBY_FLOW.maxPolls) {
          this.finish({ kind: 'refused', code, reason: 'timeout', status: 0 });
          return;
        }
        this.wait(run, code, polls);
        return;
      default:
        return;
    }
  }

  /** Waiting for the host after `polls` polls so far; the next poll is scheduled in pollMs. */
  private wait(run: number, code: string, polls: number): void {
    this.setPhase({ kind: 'waiting', code, polls });
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.checkStatus(run, code, polls + 1);
    }, LOBBY_FLOW.pollMs);
  }
}
