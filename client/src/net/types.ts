// The wire contract the client relies on, written out here so the client never imports server code: the HTTP
// API shapes (server/src/http/api.ts), the room state snapshot (LobbyState.toJSON()), the room messages in both
// directions (server/src/rooms/authz.ts, LobbyRoom) and the round events (server/src/round). The live tests
// check these against the real server (type-level assignability AND actual responses), so drift is caught.
import type {
  ApproachState,
  CourseSpec,
  EliminationReason,
  EmoteId,
  Gear,
  HeightClass,
  PonyCategory,
  RiderStatus,
  TakeoffOutcome,
  TurnChoice,
  TurnOutcome,
} from '@open-jumps/shared';

// ---- accounts ----------------------------------------------------------------------------------------------

export type RiderGender = 'girl' | 'boy';
export type PonyGender = 'yegua' | 'macho';

export interface PublicProfile {
  id: string;
  riderName: string;
  riderGender: RiderGender;
  ponyName: string;
  ponyGender: PonyGender;
  ponyCategory: PonyCategory;
  clubId: string | null;
}

export interface RegisterInput {
  riderName: string;
  pin: string;
  ponyName: string;
  riderGender: RiderGender;
  ponyGender: PonyGender;
  ponyCategory?: PonyCategory;
}

// ---- rooms: the doorbell over HTTP ---------------------------------------------------------------------------

export type ParticipantStatus = 'host' | 'admitted' | 'pending' | 'kicked' | 'none';

export type JoinDecision =
  | { status: 'admitted' }
  | { status: 'pending' }
  | { status: 'rejected'; reason: 'closed' | 'kicked' | 'full' | 'already-in' };

export interface RoomStatusReply {
  status: ParticipantStatus;
  /** Present only for the host and admitted people: the live room to joinById. */
  roomId?: string;
}

export interface LobbyPerson extends PublicProfile {
  club: { id: string; name: string } | null;
}

/** The host's view of the door (GET /api/rooms/:code/lobby; others get 403). */
export interface LobbyView {
  code: string;
  hostId: string;
  entryOpen: boolean;
  autoAdmitClub: boolean;
  clubId: string | null;
  participants: LobbyPerson[];
  pending: LobbyPerson[];
  kicked: LobbyPerson[];
}

export type DoorAction = 'admit' | 'deny' | 'kick' | 'unblock';

// ---- the live room: state snapshot ---------------------------------------------------------------------------

/** The room's phase string: 'lobby' before the first class, then the class phases. */
export type RoomPhase = 'lobby' | 'walk' | 'riding' | 'results' | 'done';

export interface ParticipantView {
  accountId: string;
  riderName: string;
  ponyName: string;
  isHost: boolean;
}

/** One rider of the running heat as the room publishes it (no t0, no window: the server judges). */
export interface RiderView {
  accountId: string;
  heightClass: number;
  positionM: number;
  gear: Gear;
  nextFence: number;
  attempt: number;
  faults: number;
  status: RiderStatus;
  autopilot: boolean;
  /** Term id of the last take-off or turn caption, '' when none yet. */
  lastLabel: string;
  /**
   * The rider's names, here and in the class table rows, because a rider who leaves the room for good is no
   * participant any more ('' while the server does not know them yet).
   */
  riderName: string;
  ponyName: string;
}

/** LobbyState.toJSON(): maps become plain objects keyed by account id. */
export interface LobbyStateSnapshot {
  code: string;
  hostId: string;
  entryOpen: boolean;
  pendingCount: number;
  participants: Record<string, ParticipantView>;
  phase: RoomPhase;
  heatIndex: number;
  roundClockMs: number;
  riders: Record<string, RiderView>;
}

// ---- the live room: messages ---------------------------------------------------------------------------------

/** What a client may send (payload of the 'room' message); the server validates and authorises every one. */
export type ClientRoomMessage =
  | { type: 'admit'; accountId: string }
  | { type: 'deny'; accountId: string }
  | { type: 'kick'; accountId: string }
  | { type: 'unblock'; accountId: string }
  | { type: 'set-entry'; open: boolean }
  | { type: 'set-auto-admit'; on: boolean }
  | { type: 'start-class'; order: 'random' | 'lowest-class-first' }
  | { type: 'emote'; emote: EmoteId }
  | { type: 'tap'; clientTime: number; fence: number; attempt: number }
  | { type: 'turn'; choice: TurnChoice; clientTime: number }
  | { type: 'gear'; gear: Gear }
  | { type: 'line'; line: 'center' | 'angle' }
  | { type: 'height'; heightClass: HeightClass }
  | { type: 'assists'; schoolmaster: boolean; widerWindow: boolean }
  | { type: 'clock-pong'; serverSent: number; clientTime: number };

export type RoundEventWire = { riderId: string } & (
  | { type: 'approach'; fence: number; attempt: number; t0: number }
  | { type: 'takeoff'; fence: number; attempt: number; decidedAt: number; offsetMs: number | null; outcome: TakeoffOutcome; approach: ApproachState }
  | { type: 'turn-ahead'; distanceM: number; at: number }
  | { type: 'turn'; distanceM: number; decidedAt: number; outcome: TurnOutcome }
  | { type: 'restart'; fence: number; attempt: number; at: number }
  | { type: 'finish'; at: number; elapsedMs: number }
  | { type: 'eliminated'; at: number; reason: EliminationReason }
  | { type: 'autopilot'; at: number; on: boolean }
  | { type: 'waiting'; at: number }
);

export interface ClassTableRowWire {
  place: number | null;
  riderId: string;
  riderName: string;
  ponyName: string;
  faults: number;
  timeMs: number | null;
  status: RiderStatus;
  eliminationReason: EliminationReason | null;
  autopilot: boolean;
}

/** One table per height class; JSON keys are the class as a string ("60"). */
export type ClassTableWire = Record<string, ClassTableRowWire[]>;

/** Everything the server sends (message type → payload), as the session hands it on. */
export type ServerMessage =
  | { type: 'clock-ping'; serverSent: number }
  /**
   * To one connection: the server's clock measurement for it, each time a series becomes the active one and each time
   * a further sample refines it — offsetMs is ClockSync.offsetMs (client − server; the server translates a clientTime c
   * as c − offsetMs). The client translates with it from then on, so the lit tap zone and the instant hint use the
   * judge's own translation (audit K1 r3 #5).
   */
  | { type: 'clock-offset'; offsetMs: number }
  | { type: 'class-course'; course: CourseSpec; classNumber: number }
  /** A phase began at `startedAt` (server ms); `endsAt` is when its timer ends — walk and results — or null (riding, done). */
  | { type: 'class-phase'; phase: Exclude<RoomPhase, 'lobby'>; heatIndex: number; startedAt: number; endsAt: number | null }
  | { type: 'round-event'; event: RoundEventWire }
  /**
   * To a rider of the running heat who takes control back (a reconnection by token, or a fresh join during the heat),
   * to that connection only: the approach the server has open for the own horse right now and still undecided, or
   * null when none is (between fences, in flight, stopped), with the hard-turn flag in force (audit K1 r2 #1).
   */
  | { type: 'approach-sync'; classNumber: number; heatIndex: number; hardTurn: boolean; approach: { fence: number; attempt: number; t0: number } | null }
  | { type: 'class-table'; table: ClassTableWire }
  | { type: 'refused'; error: string }
  | { type: 'emote'; from: string; emote: EmoteId };

/** WebSocket close codes the server uses (LobbyRoom). */
export const KICKED_CLOSE_CODE = 4100;
export const SESSION_REVOKED_CLOSE_CODE = 4101;
