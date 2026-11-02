// Emotes (audit finding A): the only "speech" between kids in a room is a closed list of crowd and trainer
// shouts. A client sends an id; the server relays only ids; each client renders the emoji and the Spanish
// shout itself. No free text ever crosses the wire, so there is nothing to moderate.

/** Crowd and trainer shouts at a kids' show-jumping class. Ids are lowercase ASCII letters; shouts are Spanish. */
export const EMOTES = [
  { id: 'bravo', emoji: '👏', shout: '¡Bravo!' },
  { id: 'vamos', emoji: '💪', shout: '¡Vamos!' },
  { id: 'animo', emoji: '🙌', shout: '¡Ánimo!' },
  { id: 'ole', emoji: '🎉', shout: '¡Olé!' },
  { id: 'bonito', emoji: '😍', shout: '¡Qué bonito!' },
  { id: 'jajaja', emoji: '😂', shout: '¡Jajaja!' },
  { id: 'uy', emoji: '😱', shout: '¡Uy!' },
  { id: 'cuidado', emoji: '😬', shout: '¡Cuidado!' },
  { id: 'tranquila', emoji: '🧘', shout: '¡Tranquila!' },
  { id: 'talon', emoji: '🦶', shout: '¡Talón abajo!' },
  { id: 'mirada', emoji: '👀', shout: '¡Mirada arriba!' },
] as const;

export type Emote = (typeof EMOTES)[number];
export type EmoteId = Emote['id'];

/** The ids alone, for O(1) membership checks on untrusted input. */
export const EMOTE_IDS: ReadonlySet<string> = new Set<string>(EMOTES.map((emote) => emote.id));

/** True only for a string that is one of the known ids (never free text, never the emoji or the shout). */
export function isEmoteId(value: unknown): value is EmoteId {
  return typeof value === 'string' && EMOTE_IDS.has(value);
}
