// Tap packet acceptance and decision moment (plan 2.3 "three times"): action time, receive time, packet age.

export const PACKET = {
  /** receive − action must not exceed this (network margin). */
  maxAgeMs: 300,
  /** action − receive must not exceed this ("from the future" beyond clock-offset error). */
  maxFutureMs: 100,
  /** Last admissible action offset from t0 (beyond it the tap is "no tap"). */
  lastActionOffsetMs: 400,
  /** Margin added to the last admissible action moment to form the decision deadline. */
  marginMs: 300,
} as const;

/** Deadline for a still-undecided attempt: t0 + 400 + 300 = t0 + 700. */
export function decisionDeadline(t0: number): number {
  return t0 + PACKET.lastActionOffsetMs + PACKET.marginMs;
}

export interface TapPacket {
  /** The tap moment translated to server time. */
  actionTime: number;
  /** When the packet arrived at the server. */
  receiveTime: number;
  fence: number;
  attempt: number;
}

export type PacketRejection = 'too-old' | 'future' | 'after-deadline' | 'duplicate' | 'wrong-attempt';

export type PacketVerdict =
  | { accepted: true; offsetMs: number }
  | { accepted: false; reason: PacketRejection };

/** Pure acceptance check of one packet against t0 (no attempt state). */
export function classifyTapPacket(packet: TapPacket, t0: number): PacketVerdict {
  if (packet.receiveTime > decisionDeadline(t0)) return { accepted: false, reason: 'after-deadline' };
  if (packet.receiveTime - packet.actionTime > PACKET.maxAgeMs) return { accepted: false, reason: 'too-old' };
  if (packet.actionTime - packet.receiveTime > PACKET.maxFutureMs) return { accepted: false, reason: 'future' };
  return { accepted: true, offsetMs: packet.actionTime - t0 };
}

export type AttemptDecision =
  | { decided: true; offsetMs: number | null; decidedAt: number }
  | { decided: false };

/**
 * Decision state of one attempt (round, fence, attempt) at a fence with ideal moment t0:
 * the first accepted packet decides immediately; without one, "no tap" is fixed at the deadline.
 *
 * Ordering contract (plan 2.3: a packet received exactly at the deadline is accepted): for a server time T,
 * every packet with receiveTime ≤ T is submitted BEFORE tick(T). The judge enforces it: submitting a packet
 * whose receiveTime is not later than the last tick throws an Error (a programming error, never a lost tap).
 */
export class AttemptJudge {
  private readonly t0: number;
  private readonly fence: number;
  private readonly attempt: number;
  private readonly deadline: number;
  private lastTick = Number.NEGATIVE_INFINITY;
  private state: AttemptDecision = { decided: false };

  constructor(t0: number, fence: number, attempt: number) {
    this.t0 = t0;
    this.fence = fence;
    this.attempt = attempt;
    this.deadline = decisionDeadline(t0);
  }

  /** Submit a packet; returns its verdict and whether it decided the attempt. */
  submit(packet: TapPacket): { verdict: PacketVerdict; decision: AttemptDecision } {
    if (packet.fence !== this.fence || packet.attempt !== this.attempt) {
      return { verdict: { accepted: false, reason: 'wrong-attempt' }, decision: this.decision };
    }
    if (packet.receiveTime <= this.lastTick) {
      throw new Error(
        `packet out of order: receiveTime ${packet.receiveTime} is not later than the last tick ${this.lastTick}`,
      );
    }
    if (this.state.decided) {
      const reason: PacketRejection = packet.receiveTime > this.deadline ? 'after-deadline' : 'duplicate';
      return { verdict: { accepted: false, reason }, decision: this.decision };
    }
    const verdict = classifyTapPacket(packet, this.t0);
    if (verdict.accepted) {
      this.state = { decided: true, offsetMs: verdict.offsetMs, decidedAt: packet.receiveTime };
    }
    return { verdict, decision: this.decision };
  }

  /** Advance server time; fixes "no tap" once the deadline is reached and nothing was accepted. */
  tick(now: number): AttemptDecision {
    if (now > this.lastTick) this.lastTick = now;
    if (!this.state.decided && now >= this.deadline) {
      this.state = { decided: true, offsetMs: null, decidedAt: this.deadline };
    }
    return this.decision;
  }

  get decision(): AttemptDecision {
    return { ...this.state };
  }
}
