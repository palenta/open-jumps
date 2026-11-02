// Room admission (plan 1.5 "Комната и допуск"): the code is a doorbell, the host decides; kicks revoke state
// and voice at once and block the code; unblocking returns the person to the doorbell, never to auto-admit.
import { err, ok, type Result } from '../result.js';

export const ROOM_CAPACITY = 16;

export interface AdmissionOptions {
  hostId: string;
  clubId: string | null;
  /** Off by default; only confirmed club members are ever auto-admitted. */
  autoAdmitClub?: boolean;
  capacity?: number;
}

export interface JoinContext {
  /** True only when the club service confirmed membership of the room's club. */
  confirmedClubMember: boolean;
}

export type JoinDecision =
  | { status: 'admitted' }
  | { status: 'pending' }
  | { status: 'rejected'; reason: 'closed' | 'kicked' | 'full' | 'already-in' };

export type ParticipantStatus = 'host' | 'admitted' | 'pending' | 'kicked' | 'none';

export type AdmissionError = 'forbidden' | 'no-request' | 'full' | 'not-participant' | 'cannot-kick-self' | 'not-kicked';

export interface Revocation {
  accountId: string;
  /** What the server must cut immediately: room state and the voice room. */
  revoke: ['state', 'voice'];
}

const remove = (list: string[], id: string): boolean => {
  const at = list.indexOf(id);
  if (at === -1) return false;
  list.splice(at, 1);
  return true;
};

export class RoomAdmission {
  private host: string;
  private readonly clubId: string | null;
  private readonly capacity: number;
  private open = true;
  private autoAdmit: boolean;
  private readonly admitted: string[];
  private readonly waiting: string[] = [];
  private readonly blocked: string[] = [];
  /** Once kicked, a person is never auto-admitted again by this code, even after an unblock. */
  private readonly onceKicked = new Set<string>();

  constructor(options: AdmissionOptions) {
    this.host = options.hostId;
    this.clubId = options.clubId;
    this.capacity = options.capacity ?? ROOM_CAPACITY;
    this.autoAdmit = options.autoAdmitClub ?? false;
    this.admitted = [options.hostId];
  }

  get hostId(): string {
    return this.host;
  }

  /** Admitted participants in join order (host first). */
  get participants(): readonly string[] {
    return this.admitted;
  }

  get pending(): readonly string[] {
    return this.waiting;
  }

  get kicked(): readonly string[] {
    return this.blocked;
  }

  get entryOpen(): boolean {
    return this.open;
  }

  get autoAdmitClub(): boolean {
    return this.autoAdmit;
  }

  /** Someone entered the code. */
  requestJoin(accountId: string, ctx: JoinContext): JoinDecision {
    if (this.admitted.includes(accountId)) return { status: 'rejected', reason: 'already-in' };
    if (this.blocked.includes(accountId)) return { status: 'rejected', reason: 'kicked' };
    if (!this.open) return { status: 'rejected', reason: 'closed' };
    if (this.isFull()) return { status: 'rejected', reason: 'full' };
    if (this.waiting.includes(accountId)) return { status: 'pending' };
    const autoAdmitted = this.autoAdmit && this.clubId !== null && ctx.confirmedClubMember && !this.onceKicked.has(accountId);
    if (autoAdmitted) {
      this.admitted.push(accountId);
      return { status: 'admitted' };
    }
    this.waiting.push(accountId);
    return { status: 'pending' };
  }

  admit(actorId: string, accountId: string): Result<void, AdmissionError> {
    if (actorId !== this.host) return err('forbidden');
    if (!this.waiting.includes(accountId)) return err('no-request');
    if (this.isFull()) return err('full');
    remove(this.waiting, accountId);
    this.admitted.push(accountId);
    return ok(undefined);
  }

  deny(actorId: string, accountId: string): Result<void, AdmissionError> {
    if (actorId !== this.host) return err('forbidden');
    if (!remove(this.waiting, accountId)) return err('no-request');
    return ok(undefined);
  }

  /** Host only: the person loses state and voice now and cannot come back by this code. */
  kick(actorId: string, accountId: string): Result<Revocation, AdmissionError> {
    if (actorId !== this.host) return err('forbidden');
    if (accountId === this.host) return err('cannot-kick-self');
    if (!remove(this.admitted, accountId)) return err('not-participant');
    this.blocked.push(accountId);
    this.onceKicked.add(accountId);
    return ok({ accountId, revoke: ['state', 'voice'] });
  }

  /** Host only: the person may ring the doorbell again; the host decides again, club auto-admit no longer applies. */
  unblock(actorId: string, accountId: string): Result<void, AdmissionError> {
    if (actorId !== this.host) return err('forbidden');
    if (!remove(this.blocked, accountId)) return err('not-kicked');
    return ok(undefined);
  }

  setEntryOpen(actorId: string, open: boolean): Result<void, AdmissionError> {
    if (actorId !== this.host) return err('forbidden');
    this.open = open;
    return ok(undefined);
  }

  setAutoAdmitClub(actorId: string, on: boolean): Result<void, AdmissionError> {
    if (actorId !== this.host) return err('forbidden');
    this.autoAdmit = on;
    return ok(undefined);
  }

  /** A participant left (or disconnected for good); when the host leaves, the next by join order becomes host. */
  leave(accountId: string): void {
    remove(this.waiting, accountId);
    if (!remove(this.admitted, accountId)) return;
    if (accountId === this.host) this.host = this.admitted[0] ?? '';
  }

  statusOf(accountId: string): ParticipantStatus {
    if (this.admitted.includes(accountId)) return accountId === this.host ? 'host' : 'admitted';
    if (this.waiting.includes(accountId)) return 'pending';
    if (this.blocked.includes(accountId)) return 'kicked';
    return 'none';
  }

  /** Room state and the voice token are available only to admitted participants. */
  canAccessState(accountId: string): boolean {
    return this.admitted.includes(accountId);
  }

  canGetVoiceToken(accountId: string): boolean {
    return this.canAccessState(accountId);
  }

  private isFull(): boolean {
    return this.admitted.length >= this.capacity;
  }
}
