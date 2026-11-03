// What the lobby screen shows (plan 1.5): who is in, who wants in (host only, with the club), the door, the
// start button; the height picker and the private assists are the rider's own settings.
import { allowedHeightClasses, translate, type HeightClass, type Locale, type PonyCategory } from '@open-jumps/shared';
import type { LobbyPerson, LobbyStateSnapshot, LobbyView } from '../net/types.js';

export interface DoorRow {
  accountId: string;
  /** "Maria on Dakota". */
  name: string;
  /** Club name or null. */
  club: string | null;
}

export interface LobbyParticipantRow {
  accountId: string;
  name: string;
  isHost: boolean;
  isOwn: boolean;
  /** The host's label / "you" in the locale, '' otherwise. */
  tag: string;
}

export interface LobbyModel {
  code: string;
  title: string;
  isHost: boolean;
  entryOpen: boolean;
  autoAdmitClub: boolean;
  participants: LobbyParticipantRow[];
  /** Host only (from the LobbyView); empty for guests. */
  pending: DoorRow[];
  kicked: DoorRow[];
  pendingCount: number;
  /** The host may start: a class is not running (phase lobby or done) and there is at least one participant. */
  canStart: boolean;
  /** Height classes this pony may ride (plan 1.6), for the picker. */
  heightChoices: HeightClass[];
  heightClass: HeightClass;
  heightText: string;
  schoolmaster: boolean;
  widerWindow: boolean;
}

export interface LobbyInput {
  state: LobbyStateSnapshot;
  /** The host's door view, null for guests or before it loaded. */
  view: LobbyView | null;
  ownId: string;
  ponyCategory: PonyCategory;
  heightClass: HeightClass;
  assists: { schoolmaster: boolean; widerWindow: boolean };
  locale: Locale;
}

export function lobbyModel(input: LobbyInput): LobbyModel {
  const { state, view, ownId, locale } = input;
  const isHost = state.hostId === ownId;
  const name = (riderName: string, ponyName: string): string =>
    translate(locale, 'names.riderOnPony', { rider: riderName, pony: ponyName });
  const door = (person: LobbyPerson): DoorRow => ({
    accountId: person.id,
    name: name(person.riderName, person.ponyName),
    club: person.club === null ? null : person.club.name,
  });

  const participants: LobbyParticipantRow[] = Object.values(state.participants).map((person) => {
    const isOwn = person.accountId === ownId;
    const tag = person.isHost ? translate(locale, 'lobby.host') : isOwn ? translate(locale, 'lobby.you') : '';
    return { accountId: person.accountId, name: name(person.riderName, person.ponyName), isHost: person.isHost, isOwn, tag };
  });

  // The door lists are the host's alone: a guest never sees them, whatever view she was handed.
  const hostView = isHost ? view : null;
  const classRunning = state.phase !== 'lobby' && state.phase !== 'done';

  return {
    code: state.code,
    title: translate(locale, 'lobby.title', { code: state.code }),
    isHost,
    entryOpen: state.entryOpen,
    autoAdmitClub: hostView?.autoAdmitClub ?? false,
    participants,
    pending: hostView === null ? [] : hostView.pending.map(door),
    kicked: hostView === null ? [] : hostView.kicked.map(door),
    pendingCount: state.pendingCount,
    canStart: isHost && !classRunning && participants.length > 0,
    heightChoices: allowedHeightClasses(input.ponyCategory),
    heightClass: input.heightClass,
    heightText: translate(locale, 'lobby.heightCm', { cm: input.heightClass }),
    schoolmaster: input.assists.schoolmaster,
    widerWindow: input.assists.widerWindow,
  };
}
