// Room message validation and authorisation (matrix rows 20, 21): only admitted participants are heard,
// host actions only from the current host, malformed payloads dropped before any logic runs. An emote is
// an id of the closed shared list, never free text (audit finding A: no text channel between kids).
import { isEmoteId, type EmoteId } from '@open-jumps/shared';
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
  | { type: 'emote'; emote: EmoteId };

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

const isBoundedString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MESSAGE_LIMITS.maxStringLength;

/** Structural validation of an untrusted payload: known type, exact fields, bounded strings. */
export function validateRoomMessage(raw: unknown): Result<RoomMessage, 'malformed'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err('malformed');
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  const field = keys.find((key) => key !== 'type');
  // Exactly two own fields: the type and its one payload field.
  if (keys.length !== 2 || field === undefined) return err('malformed');
  const type = record['type'];
  const value = record[field];
  switch (type) {
    case 'admit':
    case 'deny':
    case 'kick':
    case 'unblock':
      return field === 'accountId' && isBoundedString(value) ? ok({ type, accountId: value }) : err('malformed');
    case 'set-entry':
      return field === 'open' && typeof value === 'boolean' ? ok({ type, open: value }) : err('malformed');
    case 'set-auto-admit':
      return field === 'on' && typeof value === 'boolean' ? ok({ type, on: value }) : err('malformed');
    case 'start-class':
      return field === 'order' && (value === 'random' || value === 'lowest-class-first')
        ? ok({ type, order: value })
        : err('malformed');
    case 'emote':
      return field === 'emote' && isEmoteId(value) ? ok({ type, emote: value }) : err('malformed');
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
