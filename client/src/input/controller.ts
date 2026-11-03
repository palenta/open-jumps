// From a press on a control to a room message (plan 1.8, 1.12, 2.3): the take-off tap is armed by the server's
// 'approach' event for the own horse, stamped with the device clock at pointer-down and sent once per approach
// (the first tap decides on the server too); a press while no approach is open is nothing — it is neither sent
// nor remembered, so it can never spend the tap of the attempt that follows (audit K1 r1 #1: the state names the
// next fence from the decision on, 600 ms before the horse even lands); a client that takes control back after a
// drop is told the approach in progress by the server's 'approach-sync' instead (audit K1 r2 #1), and an attempt
// whose tap already went out is never armed twice; 'left' / 'right' are a turn when pressed inside a turn window
// (from its opening to its end, audit K1 r5 #2), otherwise a line shift; the pace button cycles the gear. A timed
// press (the tap, a turn) handled too late for the judge to accept is not sent at all (audit K1 r4 #1).
import { PACKET, type Gear } from '@open-jumps/shared';
import { NotImplementedError } from '../errors.js';
import type { Control } from './layout.js';
import type { ClientRoomMessage } from '../net/types.js';

export const INPUT = {
  /** How long after the 'turn-ahead' is handled the direction buttons mean a turn (zone 10 m ≈ 2 s before the turn moment, plus the late window). */
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

/**
 * Why a press did what it did (K1.1 step 2) — the one source of the reason; the game draws its feedback from it and
 * never repeats the controller's branches:
 * - 'sent': the message went out (the session answered true);
 * - 'not-riding': the rider is not riding (no state yet, or not in the running heat, or done) — whatever the control;
 * - 'no-control': not a control of the layout;
 * - 'not-armed': the tap while no approach of the own horse is open (between fences, before the first, in flight);
 * - 'already-tapped': the tap of an approach whose one tap already went out (a second tap, or an attempt re-armed by a
 *   sync after its tap went out);
 * - 'too-old': a timed press (the tap, or a direction press that is a turn at its moment) handled more than
 *   INPUT.maxPressAgeMs after its moment;
 * - 'cannot-send': the press meant a message, but the session could not send it (dropped, connecting).
 * The checks run in this order: not-riding; then what the press means (no-control, not-armed, already-tapped); then
 * too-old; then cannot-send. Only 'sent' changes anything.
 */
export type PressOutcome = 'sent' | 'too-old' | 'not-armed' | 'already-tapped' | 'not-riding' | 'cannot-send' | 'no-control';

/** What a press did: the message that went out (null for every outcome but 'sent') and why. */
export interface PressResult {
  readonly message: ClientRoomMessage | null;
  readonly outcome: PressOutcome;
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
 * - press(control, clientTime, handledAt = clientTime) → { message, outcome } (K1.1 step 2): message is the message
 *   sent, or null when nothing was; outcome says why (PressOutcome: 'sent'; 'not-riding'; 'no-control'; a tap with no
 *   approach open 'not-armed', a second tap in the same approach 'already-tapped'; a timed press too old for the judge
 *   'too-old'; the session could not send 'cannot-send'). Which message a press means and whether it goes out are
 *   decided exactly as before; outcome only names the branch taken. clientTime is the ClientClock reading of the
 *   pointer-down (the game passes the event's own time, see game.ts); handledAt is the clock read while the press is
 *   handled.
 * - A timed press too old for the judge is nothing (audit K1 r4 #1): a tap, or a direction press that is a turn at
 *   its moment, with handledAt − clientTime > INPUT.maxPressAgeMs is null, sends nothing and spends nothing — the
 *   tap of the approach stays armed and the turn window stays open, so the next timely press still goes out. Such
 *   a press is never re-timed to handledAt: that would turn a finger that landed before the window into a fresh
 *   take-off or turn. The gear and the line carry no time and go out whatever the age of the press; whether a
 *   direction press is a turn or a line shift is decided at its own moment (clientTime), not at its handling.
 * - turnAhead(now) opens the turn window [now, now + turnWindowMs) — `now` is the clock read while the 'turn-ahead'
 *   is handled, the same clock and units as every press's clientTime — until it ends or turnTaken() closes it; a new
 *   turnAhead replaces both bounds. A 'turn-left'/'turn-right' press whose moment is inside the window — at or after
 *   its opening and strictly before its end — sends {type:'turn', choice, clientTime} and closes the window; any
 *   other press on them sends a line toggle {type:'line', line} (center ↔ angle) and leaves the window as it is. A
 *   finger that landed before the window opened is a line shift even when it is handled after the opening (audit K1
 *   r5 #2): the rider could not have meant the turn she had not been shown yet, and taking it for one would spend
 *   the turn ('wrong' for the other direction: a 6 s stop) and send her deliberate turn as a line shift. Exactly at
 *   the opening is inside. The gear press sends the next gear of INPUT.gearOrder (cyclic), starting from 'collected'.
 * - turnWindowOpen(at) (K1.1 step 2, read by the interface): true exactly when a direction press at moment `at` would be
 *   a turn — inside [opened, opened + turnWindowMs) of the latest turnAhead, false before it, at and after its end,
 *   after turnTaken() and after a turn that went out; never changes anything. line: the line the rider asked for
 *   last ('center' until a line shift went out) — the same value as requestedLine.
 */
export class InputController {
  private readonly send: (message: ClientRoomMessage) => boolean;
  private state: RiderInputState | null = null;
  /** The open approach of the own horse and whether its one tap went out; null between approaches. */
  private open: (OpenApproach & { tapped: boolean }) | null = null;
  /** The approach whose tap went out last in this round: that attempt is never armed again. */
  private lastTap: OpenApproach | null = null;
  /** The turn window in device time, [from, until): a direction press at a moment inside it is a turn; null when closed. */
  private turnWindow: { from: number; until: number } | null = null;
  private gear: Gear = 'collected';
  private currentLine: 'center' | 'angle' = 'center';

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

  /** The 'turn-ahead' of the own horse was handled at `now` (the clock of every clientTime): the window [now, now + turnWindowMs). */
  turnAhead(now: number): void {
    this.turnWindow = { from: now, until: now + INPUT.turnWindowMs };
  }

  /** The server decided the turn: the window is closed at both ends. */
  turnTaken(): void {
    this.turnWindow = null;
  }

  press(control: Control, clientTime: number, handledAt: number = clientTime): PressResult {
    const state = this.state;
    if (state === null || !state.riding) return result(null);
    const message = this.messageFor(control, clientTime);
    if (message === null) return result(null);
    // A timed press already older than the judge accepts is not a take-off or a turn of now (audit K1 r4 #1).
    if ((message.type === 'tap' || message.type === 'turn') && handledAt - clientTime > INPUT.maxPressAgeMs) return result(null);
    // Nothing is spent unless the message really went out (audit K1 r3 #1).
    if (!this.send(message)) return result(null);
    switch (message.type) {
      case 'tap':
        if (this.open !== null) this.open.tapped = true;
        this.lastTap = { fence: message.fence, attempt: message.attempt };
        break;
      case 'gear':
        this.gear = message.gear;
        break;
      case 'turn':
        this.turnWindow = null;
        break;
      case 'line':
        this.currentLine = message.line;
        break;
      default:
        break;
    }
    return result(message);
  }

  /** True when a direction press at moment `at` would be a turn: inside [opened, opened + turnWindowMs) of an open window. */
  turnWindowOpen(at: number): boolean {
    void at;
    throw new NotImplementedError('InputController.turnWindowOpen (K1.1 step 2)');
  }

  /** The line the rider asked for last (what the line toast names). */
  get line(): 'center' | 'angle' {
    throw new NotImplementedError('InputController.line (K1.1 step 2)');
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
      case 'turn-right': {
        // A turn only at a moment inside the window, never before its opening (audit K1 r5 #2).
        const turnWindow = this.turnWindow;
        if (turnWindow !== null && clientTime >= turnWindow.from && clientTime < turnWindow.until) {
          return { type: 'turn', choice: control === 'turn-left' ? 'left' : 'right', clientTime };
        }
        return { type: 'line', line: this.currentLine === 'center' ? 'angle' : 'center' };
      }
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
    return this.currentLine;
  }
}

/**
 * K1.1 contract stage: the message is decided and sent exactly as in K1; the outcome that names the branch is not
 * built yet — reading it throws until the code stage.
 */
function result(message: ClientRoomMessage | null): PressResult {
  return {
    message,
    get outcome(): never {
      throw new NotImplementedError('InputController.press outcome (K1.1 step 2)');
    },
  };
}
