// From a press on a control to a room message (plan 1.8, 1.12, 2.3): the take-off tap is stamped with the
// device clock at pointer-down and sent once per attempt (the first tap decides on the server too); 'left' /
// 'right' are a turn while a turn window is open, otherwise a line shift; the pace button cycles the gear.
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
  /** The class and heat this state belongs to (`${classNumber}#${heatIndex}`): a new value re-arms the tap even for the same fence and attempt. */
  round: string;
  nextFence: number;
  attempt: number;
}

export interface InputControllerDeps {
  send: (message: ClientRoomMessage) => void;
}

/** The attempt a tap belongs to: one tap per (round, fence, attempt). */
const tapKey = (state: RiderInputState): string => `${state.round}|${state.nextFence}|${state.attempt}`;

/**
 * - update(): the own rider's view from the room state (round, fence and attempt key the tap; a new attempt or a new
 *   round re-arms it — the next class starts at fence 1 attempt 1 again).
 * - press(control, clientTime): the message sent, or null when nothing was (not riding; a second tap in the
 *   same attempt; an unknown control). clientTime is the ClientClock reading at pointer-down.
 * - turnAhead() opens the turn window for turnWindowMs (or until turnTaken()); a 'turn-left'/'turn-right' press
 *   inside it sends {type:'turn', choice, clientTime} and closes the window; outside it sends a line toggle
 *   {type:'line', line} (center ↔ angle); the gear press sends the next gear of INPUT.gearOrder (cyclic),
 *   starting from 'collected'.
 */
export class InputController {
  private readonly send: (message: ClientRoomMessage) => void;
  private state: RiderInputState | null = null;
  /** The key of the attempt whose tap was already sent. */
  private tappedKey: string | null = null;
  /** Device time until which a direction press is a turn; null when no window is open. */
  private turnWindowUntil: number | null = null;
  private gear: Gear = 'collected';
  private line: 'center' | 'angle' = 'center';

  constructor(deps: InputControllerDeps) {
    this.send = deps.send;
  }

  update(state: RiderInputState): void {
    this.state = { ...state };
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
        const key = tapKey(state);
        if (key === this.tappedKey) return null;
        this.tappedKey = key;
        message = { type: 'tap', clientTime, fence: state.nextFence, attempt: state.attempt };
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
