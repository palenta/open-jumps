// From a press on a control to a room message (plan 1.8, 1.12, 2.3): the take-off tap is armed by the server's
// 'approach' event for the own horse, stamped with the device clock at pointer-down and sent once per approach
// (the first tap decides on the server too); a press while no approach is open is nothing — it is neither sent
// nor remembered, so it can never spend the tap of the attempt that follows (audit K1 r1 #1: the state names the
// next fence from the decision on, 600 ms before the horse even lands); a client that takes control back after a
// drop is told the approach in progress by the server's 'approach-sync' instead (audit K1 r2 #1), and an attempt
// whose tap already went out is never armed twice; 'left' / 'right' are a turn while a turn window is open,
// otherwise a line shift; the pace button cycles the gear.
import type { Gear } from '@open-jumps/shared';
import type { Control } from './layout.js';
import type { ClientRoomMessage } from '../net/types.js';

export const INPUT = {
  /** How long after a 'turn-ahead' the direction buttons mean a turn (zone 10 m ≈ 2 s before the turn moment, plus the late window). */
  turnWindowMs: 3500,
  gearOrder: ['collected', 'extended', 'gallop'] as const,
} as const;

export interface RiderInputState {
  /** The rider is in the running heat and still riding (else every press is ignored). */
  riding: boolean;
  /** The class and heat this state belongs to (`${classNumber}#${heatIndex}`): a new value drops an approach left open by the old one. */
  round: string;
  nextFence: number;
  attempt: number;
}

/** The own horse's open approach as the server announced it. */
export interface OpenApproach {
  fence: number;
  attempt: number;
}

export interface InputControllerDeps {
  send: (message: ClientRoomMessage) => void;
}

/**
 * - update(): the own rider's view from the room state; a new round key (the next class or heat) drops the open
 *   approach and the memory of the last tap, so a stale one never arms (or blocks) a tap in the next round.
 * - approach(event): the server opened the own horse's approach (its 'approach' event) — the tap is armed for THAT
 *   fence and attempt, whatever the state patch says; approachClosed(): its 'takeoff' verdict arrived — disarmed
 *   until the next approach (a refusal's new attempt and the next fence each bring their own approach).
 * - sync(round, approach): the server's 'approach-sync' for a client taking control back (audit K1 r2 #1) — the
 *   approach open for the own horse right now arms the tap as an 'approach' event would; null disarms (no approach
 *   is open: between fences, in flight, stopped — the verdict of the old one was missed). A sync of another round
 *   than the state's is ignored. Never armed from the state's nextFence.
 * - One tap per attempt: the fence and attempt of the last tap that went out are remembered for the round, and
 *   neither a repeated approach event nor a sync arms that attempt again.
 * - press(control, clientTime): the message sent, or null when nothing was (not riding; a tap with no approach open
 *   or a second tap in the same approach; an unknown control). clientTime is the ClientClock reading at pointer-down.
 * - turnAhead() opens the turn window for turnWindowMs (or until turnTaken()); a 'turn-left'/'turn-right' press
 *   inside it sends {type:'turn', choice, clientTime} and closes the window; outside it sends a line toggle
 *   {type:'line', line} (center ↔ angle); the gear press sends the next gear of INPUT.gearOrder (cyclic),
 *   starting from 'collected'.
 */
export class InputController {
  private readonly send: (message: ClientRoomMessage) => void;
  private state: RiderInputState | null = null;
  /** The open approach of the own horse and whether its one tap went out; null between approaches. */
  private open: (OpenApproach & { tapped: boolean }) | null = null;
  /** The approach whose tap went out last in this round: that attempt is never armed again. */
  private lastTap: OpenApproach | null = null;
  /** Device time until which a direction press is a turn; null when no window is open. */
  private turnWindowUntil: number | null = null;
  private gear: Gear = 'collected';
  private line: 'center' | 'angle' = 'center';

  constructor(deps: InputControllerDeps) {
    this.send = deps.send;
  }

  update(state: RiderInputState): void {
    if (this.state !== null && this.state.round !== state.round) {
      this.open = null;
      this.lastTap = null;
    }
    this.state = { ...state };
  }

  /** The server opened the own horse's approach: arms the tap for this fence and attempt (one tap per attempt). */
  approach(event: OpenApproach): void {
    const spent = this.lastTap !== null && this.lastTap.fence === event.fence && this.lastTap.attempt === event.attempt;
    this.open = { fence: event.fence, attempt: event.attempt, tapped: spent };
  }

  /** The server's view of the own horse's approach for `round` on taking control back: armed for it, or disarmed (null). */
  sync(round: string, approach: OpenApproach | null): void {
    if (this.state !== null && this.state.round !== round) return;
    if (approach === null) this.open = null;
    else this.approach(approach);
  }

  /** The server's verdict on the open approach arrived: no tap until the next approach. */
  approachClosed(): void {
    this.open = null;
  }

  /** True while an approach is open and its tap has not gone out yet. */
  get armed(): boolean {
    return this.open !== null && !this.open.tapped;
  }

  turnAhead(now: number): void {
    this.turnWindowUntil = now + INPUT.turnWindowMs;
  }

  turnTaken(): void {
    this.turnWindowUntil = null;
  }

  press(control: Control, clientTime: number): ClientRoomMessage | null {
    const state = this.state;
    if (state === null || !state.riding) return null;

    let message: ClientRoomMessage | null = null;
    switch (control) {
      case 'tap': {
        const open = this.open;
        if (open === null || open.tapped) return null;
        open.tapped = true;
        this.lastTap = { fence: open.fence, attempt: open.attempt };
        message = { type: 'tap', clientTime, fence: open.fence, attempt: open.attempt };
        break;
      }
      case 'gear': {
        const order = INPUT.gearOrder;
        const index = order.indexOf(this.gear);
        this.gear = order[(index + 1) % order.length] ?? order[0];
        message = { type: 'gear', gear: this.gear };
        break;
      }
      case 'turn-left':
      case 'turn-right': {
        if (this.turnWindowUntil !== null && clientTime < this.turnWindowUntil) {
          this.turnWindowUntil = null;
          message = { type: 'turn', choice: control === 'turn-left' ? 'left' : 'right', clientTime };
        } else {
          this.line = this.line === 'center' ? 'angle' : 'center';
          message = { type: 'line', line: this.line };
        }
        break;
      }
      default:
        return null;
    }

    this.send(message);
    return message;
  }

  /** The gear the rider asked for last (what the pace button shows). */
  get requestedGear(): Gear {
    return this.gear;
  }

  /** The line the rider asked for last. */
  get requestedLine(): 'center' | 'angle' {
    return this.line;
  }
}
