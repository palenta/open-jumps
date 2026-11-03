// What the round screen shows (plan 1.13): the next fence number, faults and time large, the gear as a term,
// the last caption; spectators see the heat and the riders; the results table per height class (plan 1.7).
// Pure functions from the state snapshot + locale: the DOM layer only prints them.
import { formatRoundTime, translate, translateKey, type Gear, type HeightClass, type Locale } from '@open-jumps/shared';
import type { ClassTableRowWire, ClassTableWire, LobbyStateSnapshot, RiderView, RoomPhase } from '../net/types.js';

export interface HudNames {
  [accountId: string]: { riderName: string; ponyName: string; ponyGender: 'yegua' | 'macho' };
}

export interface HudRiderRow {
  accountId: string;
  /** "Maria on Dakota" / "Maria con Dakota". */
  name: string;
  heightClass: number;
  faults: number;
  nextFence: number;
  status: string;
  autopilot: boolean;
  isOwn: boolean;
}

export interface HudModel {
  phase: RoomPhase;
  /** "Manga 1", "Reconocimiento", … */
  phaseText: string;
  /** The rider's own horse is in the running heat. */
  riding: boolean;
  spectating: boolean;
  /** Fence number to show (null when finished / eliminated / not riding). */
  nextFence: number | null;
  fenceCount: number;
  /** "Fence 3" / "Finished" / "eliminada". */
  fenceText: string;
  faults: number;
  faultsText: string;
  /** formatRoundTime(roundClockMs) while a heat runs, else "0.0". */
  timeText: string;
  gear: Gear;
  gearText: string;
  caption: string;
  autopilot: boolean;
  riders: HudRiderRow[];
  /** The placeholder-art notice, always shown until the real models land. */
  badge: string;
}

export interface ResultsRow {
  accountId: string;
  placeText: string;
  name: string;
  faults: number;
  timeText: string;
  /** '' / "eliminada — tiempo" / "con autopiloto". */
  note: string;
  isOwn: boolean;
}

export interface ResultsClass {
  heightClass: HeightClass;
  title: string;
  rows: ResultsRow[];
}

/** One rider of the heat that just ended, as the results screen lists them before the class table exists. */
export interface HeatResultRow {
  accountId: string;
  name: string;
  faults: number;
  /** "4 faults" / "4 puntos". */
  faultsText: string;
  /** "Finished" / "eliminada"; '' while the snapshot still says riding. */
  statusText: string;
  isOwn: boolean;
}

export interface HudInput {
  state: LobbyStateSnapshot;
  ownId: string;
  locale: Locale;
  names: HudNames;
  fenceCount: number;
  /** The caption currently shown (the hint or the server's), '' when none. */
  caption: string;
  /** The gear the rider requested (shown even when the horse is collected by schoolmaster/autopilot). */
  requestedGear: Gear;
}

/** A name "Rider on Pony" in the locale; a missing account id reads as the id itself (never blank). */
export function riderOnPony(locale: Locale, names: HudNames, accountId: string): string {
  const entry = Object.prototype.hasOwnProperty.call(names, accountId) ? names[accountId] : undefined;
  if (entry === undefined) return accountId;
  return translate(locale, 'names.riderOnPony', { rider: entry.riderName, pony: entry.ponyName });
}

export function hudModel(input: HudInput): HudModel {
  const { state, ownId, locale, names, fenceCount } = input;
  const heatRunning = state.phase === 'riding';
  const own: RiderView | undefined = Object.prototype.hasOwnProperty.call(state.riders, ownId) ? state.riders[ownId] : undefined;
  const riding = heatRunning && own !== undefined;

  // The fence to jump next: none once finished or eliminated, none past the last fence (the run-in to the line).
  const nextFence = own !== undefined && own.status === 'riding' && own.nextFence >= 1 && own.nextFence <= fenceCount ? own.nextFence : null;
  const fenceText =
    own?.status === 'finished'
      ? translate(locale, 'hud.finished')
      : own?.status === 'eliminated'
        ? translate(locale, 'hud.eliminated')
        : nextFence === null
          ? ''
          : translate(locale, 'hud.fence', { number: nextFence });
  const faults = own?.faults ?? 0;

  const riders: HudRiderRow[] = Object.values(state.riders).map((rider) => ({
    accountId: rider.accountId,
    name: riderOnPony(locale, names, rider.accountId),
    heightClass: rider.heightClass,
    faults: rider.faults,
    nextFence: rider.nextFence,
    status: rider.status,
    autopilot: rider.autopilot,
    isOwn: rider.accountId === ownId,
  }));

  return {
    phase: state.phase,
    phaseText: translateKey(locale, `hud.phase.${state.phase}`, { heat: state.heatIndex + 1 }),
    riding,
    spectating: heatRunning && own === undefined,
    nextFence,
    fenceCount,
    fenceText,
    faults,
    faultsText: translate(locale, 'hud.faults', { faults }),
    timeText: heatRunning ? formatRoundTime(state.roundClockMs) : '0.0',
    gear: input.requestedGear,
    gearText: translateKey(locale, `hud.gear.${input.requestedGear}`),
    caption: input.caption,
    autopilot: own?.autopilot ?? false,
    riders,
    badge: translate(locale, 'app.placeholderArt'),
  };
}

/**
 * The heat that just ended, from the riders the state still carries during 'results' (the class table comes only
 * with 'done'): the room publishes the heat's final snapshot in the very patch that says 'results', so status and
 * faults are the engine's results, time faults and the last refusal included (audit K1 r2 #2). Finishers first by
 * faults, then the eliminated by faults, ties by name. There are no times in the state, so none are shown; the
 * class table brings them.
 */
export function heatResultsModel(state: LobbyStateSnapshot, names: HudNames, locale: Locale, ownId: string): HeatResultRow[] {
  const rank = (status: string): number => (status === 'finished' ? 0 : status === 'eliminated' ? 1 : 2);
  return Object.values(state.riders)
    .map((rider) => ({
      accountId: rider.accountId,
      name: riderOnPony(locale, names, rider.accountId),
      faults: rider.faults,
      faultsText: translate(locale, 'hud.faults', { faults: rider.faults }),
      statusText: rider.status === 'finished' ? translate(locale, 'hud.finished') : rider.status === 'eliminated' ? translate(locale, 'hud.eliminated') : '',
      isOwn: rider.accountId === ownId,
      rank: rank(rider.status),
    }))
    .sort((a, b) => a.rank - b.rank || a.faults - b.faults || a.name.localeCompare(b.name))
    .map(({ rank: _rank, ...row }) => row);
}

/** Tables in ascending height class; rows in the server's order (placed first, then eliminated). */
export function resultsModel(table: ClassTableWire, names: HudNames, locale: Locale, ownId: string): ResultsClass[] {
  const classes = Object.keys(table)
    .map((key) => Number(key))
    .filter((cm) => Number.isFinite(cm))
    .sort((a, b) => a - b);
  return classes.map((cm) => {
    const heightClass = cm as HeightClass;
    const rows = (table[String(cm)] ?? []).map((row) => resultsRow(row, names, locale, ownId));
    return { heightClass, title: translate(locale, 'results.title', { cm }), rows };
  });
}

function resultsRow(row: ClassTableRowWire, names: HudNames, locale: Locale, ownId: string): ResultsRow {
  return {
    accountId: row.riderId,
    placeText: row.place === null ? translate(locale, 'results.noPlace') : String(row.place),
    name: riderOnPony(locale, names, row.riderId),
    faults: row.faults,
    timeText: row.timeMs === null ? translate(locale, 'results.noTime') : formatRoundTime(row.timeMs),
    note: resultsNote(row, locale),
    isOwn: row.riderId === ownId,
  };
}

/** The elimination reason first, else the autopilot mark, else nothing. */
function resultsNote(row: ClassTableRowWire, locale: Locale): string {
  if (row.eliminationReason !== null) return translateKey(locale, `results.eliminated.${row.eliminationReason}`);
  if (row.status === 'eliminated') return translate(locale, 'hud.eliminated');
  return row.autopilot ? translate(locale, 'results.autopilot') : '';
}
