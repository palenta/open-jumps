// Room message validation and authorisation (matrix rows 20, 21): only admitted participants are heard,
// host actions only from the current host, malformed payloads dropped before any logic runs. An emote is
// an id of the closed shared list, never free text (audit finding A: no text channel between kids).
import { HEIGHT_CLASSES, isEmoteId, type EmoteId, type Gear, type HeightClass, type TurnChoice } from '@open-jumps/shared';
import { err, ok, type Result } from '../result.js';
import type { RoomAdmission } from './admission.js';

export type RoomMessage =
  | { type: 'admit'; accountId: string }
  | { type: 'deny'; accountId: string }
  | { type: 'kick'; accountId: string }
  | { type: 'unblock'; accountId: string }
  | { type: 'set-entry'; open: boolean }
  | { type: 'set-auto-admit'; on: boolean }
  | { type: 'start-class'; order: 'random' | 'lowest-class-first' }
  | { type: 'emote'; emote: EmoteId }
  // Part B2 — rider commands (only riders of the running heat; always about the sender's own horse, plan 2.3):
  | { type: 'tap'; clientTime: number; fence: number; attempt: number }
  | { type: 'turn'; choice: TurnChoice; clientTime: number }
  // A gear or line command may carry seq (K1.1 code audit r2): the sender's own number for it, monotonic per page; the
  // room answers it by that number ('control-applied' or 'refused', see LobbyRoom). Without seq (an older client) the
  // command is still applied and answered with seq null.
  | { type: 'gear'; gear: Gear; seq?: number }
  | { type: 'line'; line: 'center' | 'angle'; seq?: number }
  // Part B2 — lobby settings of the sender (any participant) and the clock answer:
  | { type: 'height'; heightClass: HeightClass }
  | { type: 'assists'; schoolmaster: boolean; widerWindow: boolean }
  | { type: 'clock-pong'; serverSent: number; clientTime: number };

/** Messages that drive the sender's horse: accepted only while the sender rides in the running heat. */
export const RIDER_ONLY_MESSAGES: ReadonlySet<RoomMessage['type']> = new Set(['tap', 'turn', 'gear', 'line']);

/**
 * Numbers must be finite; clientTime is the client's clock in ms; fence is 1..maxFence; attempt is any positive
 * safe integer — the attempt number is NOT the number of disobediences (every fall restarts the fence without
 * counting as one), so the server, not the message shape, decides whether it is the current attempt. The seq of a
 * gear or line command is a safe integer ≥ 0 (the client's own numbering; the server only echoes it).
 */
export const MESSAGE_NUMBER_LIMITS = { maxFence: 12 } as const;

export const HOST_ONLY_MESSAGES: ReadonlySet<RoomMessage['type']> = new Set([
  'admit',
  'deny',
  'kick',
  'unblock',
  'set-entry',
  'set-auto-admit',
  'start-class',
]);

export const MESSAGE_LIMITS = { maxStringLength: 64 } as const;

// The closed enumerations a string field may take: exact ids, never free text.
const CLASS_ORDERS: ReadonlySet<string> = new Set(['random', 'lowest-class-first']);
const TURN_CHOICES: ReadonlySet<string> = new Set<TurnChoice>(['left', 'right', 'straight']);
const GEARS: ReadonlySet<string> = new Set<Gear>(['collected', 'extended', 'gallop']);
const LINES: ReadonlySet<string> = new Set(['center', 'angle']);

const isBoundedString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MESSAGE_LIMITS.maxStringLength;
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isFence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MESSAGE_NUMBER_LIMITS.maxFence;
const isAttempt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isClassOrder = (value: unknown): value is 'random' | 'lowest-class-first' => typeof value === 'string' && CLASS_ORDERS.has(value);
const isTurnChoice = (value: unknown): value is TurnChoice => typeof value === 'string' && TURN_CHOICES.has(value);
const isGear = (value: unknown): value is Gear => typeof value === 'string' && GEARS.has(value);
const isLine = (value: unknown): value is 'center' | 'angle' => typeof value === 'string' && LINES.has(value);
const isHeightClass = (value: unknown): value is HeightClass =>
  typeof value === 'number' && (HEIGHT_CLASSES as readonly number[]).includes(value);

/**
 * The payload carries exactly `type` plus the given fields — nothing missing, nothing extra. An extra field
 * such as a `riderId` is malformed: a command is always about the sender's own horse (plan 2.3, row 20).
 */
function hasExactFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === fields.length + 1 &&
    Object.prototype.hasOwnProperty.call(record, 'type') &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
  );
}

/** Structural validation of an untrusted payload: known type, exact fields, bounded strings, finite numbers. */
export function validateRoomMessage(raw: unknown): Result<RoomMessage, 'malformed'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err('malformed');
  const record = raw as Record<string, unknown>;
  const exact = (...fields: string[]): boolean => hasExactFields(record, fields);
  const type = record['type'];
  switch (type) {
    case 'admit':
    case 'deny':
    case 'kick':
    case 'unblock': {
      const accountId = record['accountId'];
      return exact('accountId') && isBoundedString(accountId) ? ok({ type, accountId }) : err('malformed');
    }
    case 'set-entry': {
      const open = record['open'];
      return exact('open') && isBoolean(open) ? ok({ type, open }) : err('malformed');
    }
    case 'set-auto-admit': {
      const on = record['on'];
      return exact('on') && isBoolean(on) ? ok({ type, on }) : err('malformed');
    }
    case 'start-class': {
      const order = record['order'];
      return exact('order') && isClassOrder(order) ? ok({ type, order }) : err('malformed');
    }
    case 'emote': {
      const emote = record['emote'];
      return exact('emote') && isEmoteId(emote) ? ok({ type, emote }) : err('malformed');
    }
    // ---- Part B2: rider commands ----
    case 'tap': {
      const clientTime = record['clientTime'];
      const fence = record['fence'];
      const attempt = record['attempt'];
      return exact('clientTime', 'fence', 'attempt') && isFiniteNumber(clientTime) && isFence(fence) && isAttempt(attempt)
        ? ok({ type, clientTime, fence, attempt })
        : err('malformed');
    }
    case 'turn': {
      const choice = record['choice'];
      const clientTime = record['clientTime'];
      return exact('choice', 'clientTime') && isTurnChoice(choice) && isFiniteNumber(clientTime)
        ? ok({ type, choice, clientTime })
        : err('malformed');
    }
    case 'gear': {
      const gear = record['gear'];
      const seq = record['seq'];
      if (!isGear(gear)) return err('malformed');
      if (exact('gear')) return ok({ type, gear });
      return exact('gear', 'seq') && isSeq(seq) ? ok({ type, gear, seq }) : err('malformed');
    }
    case 'line': {
      const line = record['line'];
      const seq = record['seq'];
      if (!isLine(line)) return err('malformed');
      if (exact('line')) return ok({ type, line });
      return exact('line', 'seq') && isSeq(seq) ? ok({ type, line, seq }) : err('malformed');
    }
    // ---- Part B2: lobby settings and the clock answer ----
    case 'height': {
      const heightClass = record['heightClass'];
      return exact('heightClass') && isHeightClass(heightClass) ? ok({ type, heightClass }) : err('malformed');
    }
    case 'assists': {
      const schoolmaster = record['schoolmaster'];
      const widerWindow = record['widerWindow'];
      return exact('schoolmaster', 'widerWindow') && isBoolean(schoolmaster) && isBoolean(widerWindow)
        ? ok({ type, schoolmaster, widerWindow })
        : err('malformed');
    }
    case 'clock-pong': {
      const serverSent = record['serverSent'];
      const clientTime = record['clientTime'];
      return exact('serverSent', 'clientTime') && isFiniteNumber(serverSent) && isFiniteNumber(clientTime)
        ? ok({ type, serverSent, clientTime })
        : err('malformed');
    }
    default:
      return err('malformed');
  }
}

/** Who may send what: non-participants nothing, host-only types only the host. */
export function authorizeRoomMessage(
  admission: RoomAdmission,
  actorId: string,
  message: RoomMessage,
): Result<void, 'not-participant' | 'host-only'> {
  if (!admission.canAccessState(actorId)) return err('not-participant');
  if (HOST_ONLY_MESSAGES.has(message.type) && actorId !== admission.hostId) return err('host-only');
  return ok(undefined);
}
