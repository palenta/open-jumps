// Storage contracts (plan 2.3 "Хранение и вход"): small records, no images, PINs only as hashes.
import type { EliminationReason, HeightClass, PonyCategory, RiderStatus } from '@open-jumps/shared';

export type RiderGender = 'girl' | 'boy';
export type PonyGender = 'yegua' | 'macho';

export interface AccountRecord {
  id: string;
  riderName: string;
  /** Normalised rider name used for uniqueness (case- and diacritic-insensitive). */
  riderNameKey: string;
  riderGender: RiderGender;
  ponyName: string;
  ponyGender: PonyGender;
  ponyCategory: PonyCategory;
  /** scrypt hash with salt; the PIN itself is never stored. */
  pinHash: string;
  /** Bumped on PIN reset: every session issued under an older generation is revoked. */
  sessionGeneration: number;
  failedLogins: number;
  lockedUntil: number | null;
  clubId: string | null;
  createdAt: number;
}

export interface SessionRecord {
  /** SHA-256 of the token; the token itself lives only in the cookie. */
  tokenHash: string;
  accountId: string;
  generation: number;
  createdAt: number;
  expiresAt: number;
}

export interface ClubRecord {
  id: string;
  name: string;
  nameKey: string;
  code: string;
  adminAccountId: string;
  createdAt: number;
}

export type MembershipStatus = 'pending' | 'member';

export interface MembershipRecord {
  clubId: string;
  accountId: string;
  status: MembershipStatus;
  requestedAt: number;
  confirmedAt: number | null;
}

export interface AccountRepository {
  /** Throws if riderNameKey already exists. */
  create(record: AccountRecord): Promise<void>;
  getById(id: string): Promise<AccountRecord | null>;
  getByNameKey(nameKey: string): Promise<AccountRecord | null>;
  update(record: AccountRecord): Promise<void>;
  /**
   * Atomic field-level update: only the given fields change, so two services writing different fields never
   * overwrite each other with a stale copy of the whole record. Throws for an unknown id.
   */
  patch(id: string, fields: Partial<Omit<AccountRecord, 'id'>>): Promise<void>;
  /** Atomic increment of sessionGeneration (one storage operation); the new value, or null for an unknown id. */
  bumpSessionGeneration(id: string): Promise<number | null>;
}

export interface SessionRepository {
  insert(record: SessionRecord): Promise<void>;
  getByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  update(record: SessionRecord): Promise<void>;
  deleteExpired(now: number): Promise<number>;
}

export interface ClubRepository {
  create(record: ClubRecord): Promise<void>;
  getById(id: string): Promise<ClubRecord | null>;
  getByCode(code: string): Promise<ClubRecord | null>;
  getByNameKey(nameKey: string): Promise<ClubRecord | null>;
  update(record: ClubRecord): Promise<void>;
  upsertMembership(record: MembershipRecord): Promise<void>;
  getMembership(clubId: string, accountId: string): Promise<MembershipRecord | null>;
  deleteMembership(clubId: string, accountId: string): Promise<void>;
  listMemberships(clubId: string, status?: MembershipStatus): Promise<MembershipRecord[]>;
}

/** A rider's result of one round (plan 2.5): one row per (roundId, accountId), never a second one. */
export interface ResultRecord {
  roundId: string;
  accountId: string;
  courseId: string;
  courseVersion: number;
  rulesVersion: number;
  heightClass: HeightClass;
  faults: number;
  /** Time on course in ms; null when eliminated. */
  timeMs: number | null;
  status: RiderStatus;
  eliminationReason: EliminationReason | null;
  /** "con autopiloto": excluded from leaderboards and career (plan 2.3). */
  autopilot: boolean;
  schoolmaster: boolean;
  mode: 'ranked' | 'training';
  /** The round seed (plan 2.3): chance outcomes of the stored result stay reproducible. */
  seed: string;
  recordedAt: number;
}

export interface ResultRepository {
  /** Insert unless a row with the same (roundId, accountId) exists; returns whether it was inserted. */
  insertOnce(record: ResultRecord): Promise<boolean>;
  get(roundId: string, accountId: string): Promise<ResultRecord | null>;
  listByRound(roundId: string): Promise<ResultRecord[]>;
  /** Newest first. */
  listByAccount(accountId: string): Promise<ResultRecord[]>;
}

export interface Repositories {
  accounts: AccountRepository;
  sessions: SessionRepository;
  clubs: ClubRepository;
  results: ResultRepository;
  /** Release resources (close the database). */
  close(): Promise<void>;
}
