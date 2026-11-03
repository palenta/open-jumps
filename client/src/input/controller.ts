// From a press on a control to a room message (plan 1.8, 1.12, 2.3): the take-off tap is armed by the server's
// 'approach' event for the own horse, stamped with the device clock at pointer-down and sent once per approach
// (the first tap decides on the server too); a press while no approach is open is nothing — it is neither sent
// nor remembered, so it can never spend the tap of the attempt that follows (audit K1 r1 #1: the state names the
// next fence from the decision on, 600 ms before the horse even lands); 'left' / 'right' are a turn while a turn
// window is open, otherwise a line shift; the pace button cycles the gear.
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
 *   approach, so a stale one never arms a tap in the next round.
 * - approach(event): the server opened the own horse's approach (its 'approach' event) — the tap is armed for THAT
 *   fence and attempt, whatever the state patch says; approachClosed(): its 'takeoff' verdict arrived — disarmed
 *   until the next approach (a refusal's new attempt and the next fence each bring their own approach).
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
  /** Device time until which a direction press is a turn; null when no window is open. */
  private turnWindowUntil: number | null = null;
  private gear: Gear = 'collected';
  private line: 'center' | 'angle' = 'center';

  constructor(deps: InputControllerDeps) {
    this.send = deps.send;
  }

  update(state: RiderInputState): void {
    if (this.state !== null && this.state.round !== state.round) this.open = null;
    this.state = { ...state };
  }

  /** The server opened the own horse's approach: arms the tap for this fence and attempt (one tap per approach). */
  approach(event: OpenApproach): void {
    this.open = { fence: event.fence, attempt: event.attempt, tapped: false };
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
