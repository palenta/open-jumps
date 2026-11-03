// From a press on a control to a room message (plan 1.8, 1.12, 2.3): the take-off tap is armed by the server's
// 'approach' event for the own horse, stamped with the device clock at pointer-down and sent once per approach
// (the first tap decides on the server too); a press while no approach is open is nothing — it is neither sent
// nor remembered, so it can never spend the tap of the attempt that follows (audit K1 r1 #1: the state names the
// next fence from the decision on, 600 ms before the horse even lands); a client that takes control back after a
// drop is told the approach in progress by the server's 'approach-sync' instead (audit K1 r2 #1), and an attempt
// whose tap already went out is never armed twice; 'left' / 'right' are a turn while a turn window is open,
// otherwise a line shift; the pace button cycles the gear. A timed press (the tap, a turn) handled too late for the
// judge to accept is not sent at all (audit K1 r4 #1).
import { PACKET, type Gear } from '@open-jumps/shared';
import type { Control } from './layout.js';
import type { ClientRoomMessage } from '../net/types.js';

export const INPUT = {
  /** How long after a 'turn-ahead' the direction buttons mean a turn (zone 10 m ≈ 2 s before the turn moment, plus the late window). */
  turnWindowMs: 3500,
  gearOrder: ['collected', 'extended', 'gallop'] as const,
  /**
   * The oldest a timed press (the tap, a turn) may be when it is handled, against the clock read at handling: the
   * judge's own limit, PACKET.maxAgeMs. The server refuses a tap or a turn whose receive time is more than that after
   * its action time ('too-old'), and the packet arrives at least as late as it is handled — so a press already older
   * at handling is refused whatever the network (short of an error of the clock measurement itself in its favour,
   * which would have to outweigh the whole transit), and sending it would only spend the attempt or the turn.
   */
  maxPressAgeMs: PACKET.maxAgeMs,
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
  /** Hands a message to the room session: true when it went out, false when the session could not send it (dropped, connecting). */
  send: (message: ClientRoomMessage) => boolean;
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
 * - Only what went out is spent (audit K1 r3 #1): a press is turned into its message first, the message is handed to
 *   deps.send, and only when send answers true does the press take effect — the tap of the approach marked as gone
 *   (and remembered as the last tap), the turn window closed, the gear or line switched. A press while the session
 *   cannot send (dropped, connecting) changes nothing, so the tap of an approach still open after the SDK recovered
 *   goes out on the next press — and a second press after a tap that really went out still sends nothing.
 * - press(control, clientTime, handledAt = clientTime): the message sent, or null when nothing was (not riding; a
 *   tap with no approach open or a second tap in the same approach; a timed press too old for the judge; an unknown
 *   control; the session could not send). clientTime is the ClientClock reading of the pointer-down (the game
 *   passes the event's own time, see game.ts); handledAt is the clock read while the press is handled.
 * - A timed press too old for the judge is nothing (audit K1 r4 #1): a tap, or a direction press that is a turn at
 *   its moment, with handledAt − clientTime > INPUT.maxPressAgeMs is null, sends nothing and spends nothing — the
 *   tap of the approach stays armed and the turn window stays open, so the next timely press still goes out. Such
 *   a press is never re-timed to handledAt: that would turn a finger that landed before the window into a fresh
 *   take-off or turn. The gear and the line carry no time and go out whatever the age of the press; whether a
 *   direction press is a turn or a line shift is decided at its own moment (clientTime), not at its handling.
 * - turnAhead() opens the turn window for turnWindowMs (or until turnTaken()); a 'turn-left'/'turn-right' press
 *   inside it sends {type:'turn', choice, clientTime} and closes the window; outside it sends a line toggle
 *   {type:'line', line} (center ↔ angle); the gear press sends the next gear of INPUT.gearOrder (cyclic),
 *   starting from 'collected'.
 */
export class InputController {
  private readonly send: (message: ClientRoomMessage) => boolean;
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

  press(control: Control, clientTime: number, handledAt: number = clientTime): ClientRoomMessage | null {
    const state = this.state;
    if (state === null || !state.riding) return null;
    const message = this.messageFor(control, clientTime);
    if (message === null) return null;
    // A timed press already older than the judge accepts is not a take-off or a turn of now (audit K1 r4 #1).
    if ((message.type === 'tap' || message.type === 'turn') && handledAt - clientTime > INPUT.maxPressAgeMs) return null;
    // Nothing is spent unless the message really went out (audit K1 r3 #1).
    if (!this.send(message)) return null;
    switch (message.type) {
      case 'tap':
        if (this.open !== null) this.open.tapped = true;
        this.lastTap = { fence: message.fence, attempt: message.attempt };
        break;
      case 'gear':
        this.gear = message.gear;
        break;
      case 'turn':
        this.turnWindowUntil = null;
        break;
      case 'line':
        this.line = message.line;
        break;
      default:
        break;
    }
    return message;
  }

  /** The message a press would send now, without changing anything; null when the press means nothing. */
  private messageFor(control: Control, clientTime: number): ClientRoomMessage | null {
    switch (control) {
      case 'tap': {
        const open = this.open;
        if (open === null || open.tapped) return null;
        return { type: 'tap', clientTime, fence: open.fence, attempt: open.attempt };
      }
      case 'gear': {
        const order = INPUT.gearOrder;
        const index = order.indexOf(this.gear);
        return { type: 'gear', gear: order[(index + 1) % order.length] ?? order[0] };
      }
      case 'turn-left':
      case 'turn-right':
        if (this.turnWindowUntil !== null && clientTime < this.turnWindowUntil) {
          return { type: 'turn', choice: control === 'turn-left' ? 'left' : 'right', clientTime };
        }
        return { type: 'line', line: this.line === 'center' ? 'angle' : 'center' };
      default:
        return null;
    }
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
