// The round screen's view model (plan 1.13, 1.7): the next fence, faults and time large, the gear as a term,
// the last caption, the riders of the heat for spectators, and the results table per height class — pure
// functions of the room snapshot and the locale, so the DOM layer only prints what it gets.
import { caption, MESSAGES } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { heatResultsModel, hudModel, namesFrom, resultsModel, riderOnPony, type HudInput, type HudNames } from '../src/hud/viewModel.js';
import type { ClassTableRowWire, ClassTableWire, LobbyStateSnapshot, RiderView } from '../src/net/types.js';

const names: HudNames = {
  host: { riderName: 'Maria', ponyName: 'Dakota', ponyGender: 'yegua' },
  ana: { riderName: 'Ana', ponyName: 'Luna', ponyGender: 'yegua' },
  bea: { riderName: 'Bea', ponyName: 'Nube', ponyGender: 'macho' },
};

const rider = (accountId: string, over: Partial<RiderView> = {}): RiderView => ({
  accountId,
  heightClass: 60,
  positionM: 0,
  gear: 'collected',
  nextFence: 1,
  attempt: 1,
  faults: 0,
  status: 'riding',
  autopilot: false,
  lastLabel: '',
  riderName: '',
  ponyName: '',
  ...over,
});

/** The room during heat 1 of a class: Maria (host) is between fences 1 and 2 after a rail, Ana is at fence 1. */
const snapshot = (over: Partial<LobbyStateSnapshot> = {}): LobbyStateSnapshot => ({
  code: 'ABCDEF',
  hostId: 'host',
  entryOpen: true,
  pendingCount: 0,
  participants: {
    host: { accountId: 'host', riderName: 'Maria', ponyName: 'Dakota', isHost: true },
    ana: { accountId: 'ana', riderName: 'Ana', ponyName: 'Luna', isHost: false },
  },
  phase: 'riding',
  heatIndex: 0,
  nextHeat: false,
  roundClockMs: 42_340,
  riders: {
    host: rider('host', { heightClass: 70, positionM: 31, gear: 'extended', nextFence: 2, faults: 4, lastLabel: 'batida_corta' }),
    ana: rider('ana', { heightClass: 60, positionM: 12 }),
  },
  ...over,
});

const input = (over: Partial<HudInput> = {}): HudInput => ({
  state: snapshot(),
  ownId: 'host',
  locale: 'en',
  names,
  fenceCount: 3,
  caption: 'Dakota: batida corta at fence 1 — derribo',
  requestedGear: 'extended',
  ...over,
});

const table: ClassTableWire = {
  '60': [{ place: 1, riderId: 'ana', riderName: 'Ana', ponyName: 'Luna', faults: 0, timeMs: 55_200, status: 'finished', eliminationReason: null, autopilot: false }],
  '70': [
    { place: 1, riderId: 'host', riderName: 'Maria', ponyName: 'Dakota', faults: 4, timeMs: 60_100, status: 'finished', eliminationReason: null, autopilot: true },
    { place: null, riderId: 'bea', riderName: 'Bea', ponyName: 'Nube', faults: 8, timeMs: null, status: 'eliminated', eliminationReason: 'refusals', autopilot: false },
  ],
};

describe('riderOnPony', () => {
  it('reads "Rider on Pony" in the locale', () => {
    expect(riderOnPony('en', names, 'host')).toBe('Maria on Dakota');
    expect(riderOnPony('es', names, 'host')).toBe('Maria con Dakota');
    expect(riderOnPony('en', names, 'ana')).toBe('Ana on Luna');
  });

  it('an unknown account id reads as the id itself, never blank', () => {
    expect(riderOnPony('en', names, 'ghost')).toBe('ghost');
    expect(riderOnPony('es', {}, 'ghost')).toBe('ghost');
  });
});

describe('hudModel', () => {
  it('the own rider in the running heat: next fence, faults, time, gear and caption', () => {
    const hud = hudModel(input());
    expect(hud.phase).toBe('riding');
    expect(hud.phaseText).toBe('manga 1');
    expect(hud.riding).toBe(true);
    expect(hud.spectating).toBe(false);
    expect(hud.nextFence).toBe(2);
    expect(hud.fenceCount).toBe(3);
    expect(hud.fenceText).toBe('Fence 2');
    expect(hud.faults).toBe(4);
    expect(hud.faultsText).toBe('4 faults');
    expect(hud.timeText).toBe('42.3');
    expect(hud.gear).toBe('extended');
    expect(hud.gearText).toBe('galope largo');
    expect(hud.caption).toBe('Dakota: batida corta at fence 1 — derribo');
    expect(hud.autopilot).toBe(false);
  });

  it('the badge is the placeholder-art notice until the real models land', () => {
    expect(hudModel(input()).badge).toBe(MESSAGES.en['app.placeholderArt']);
    expect(hudModel(input({ locale: 'es' })).badge).toBe(MESSAGES.es['app.placeholderArt']);
  });

  it('lists every rider of the heat with name, class, faults, next fence and status, the own one marked', () => {
    const { riders } = hudModel(input());
    expect(riders).toHaveLength(2);
    const maria = riders.find((row) => row.accountId === 'host');
    const ana = riders.find((row) => row.accountId === 'ana');
    expect(maria).toEqual({ accountId: 'host', name: 'Maria on Dakota', heightClass: 70, faults: 4, nextFence: 2, status: 'riding', autopilot: false, isOwn: true });
    expect(ana).toEqual({ accountId: 'ana', name: 'Ana on Luna', heightClass: 60, faults: 0, nextFence: 1, status: 'riding', autopilot: false, isOwn: false });
  });

  it('the own rider past the last fence and heading to the finish line: still riding, nothing to jump, the clock runs', () => {
    const state = snapshot({ riders: { host: rider('host', { heightClass: 70, positionM: 110, nextFence: 4, faults: 4 }), ana: rider('ana') } });
    const hud = hudModel(input({ state }));
    expect(hud.riding).toBe(true);
    expect(hud.nextFence).toBeNull();
    expect(hud.fenceText).toBe('');
    expect(hud.timeText).toBe('42.3');
    expect(hud.faultsText).toBe('4 faults');
  });

  it('the own rider finished: no fence to show, "Finished"', () => {
    const state = snapshot({ riders: { host: rider('host', { heightClass: 70, nextFence: 4, faults: 4, status: 'finished' }), ana: rider('ana') } });
    const hud = hudModel(input({ state }));
    expect(hud.nextFence).toBeNull();
    expect(hud.fenceText).toBe('Finished');
    expect(hud.faults).toBe(4);
  });

  it('the own rider eliminated: no fence to show, "eliminada" in both locales', () => {
    const state = snapshot({ riders: { host: rider('host', { heightClass: 70, nextFence: 2, faults: 8, status: 'eliminated' }), ana: rider('ana') } });
    expect(hudModel(input({ state })).nextFence).toBeNull();
    expect(hudModel(input({ state })).fenceText).toBe('eliminada');
    expect(hudModel(input({ state, locale: 'es' })).fenceText).toBe('eliminada');
  });

  it('a spectator of this heat: not riding, nothing to jump, the requested gear still named, the heat named', () => {
    const state = snapshot({ riders: { ana: rider('ana') } });
    const hud = hudModel(input({ state }));
    expect(hud.riding).toBe(false);
    expect(hud.spectating).toBe(true);
    expect(hud.nextFence).toBeNull();
    expect(hud.fenceText).toBe('');
    expect(hud.gearText).toBe('galope largo');
    expect(hud.phaseText).toBe('manga 1');
    expect(hud.timeText).toBe('42.3');
    expect(hud.riders.map((row) => row.accountId)).toEqual(['ana']);
  });

  it('the heat number is the heat index plus one', () => {
    expect(hudModel(input({ state: snapshot({ heatIndex: 2 }) })).phaseText).toBe('manga 3');
  });

  it('during the course walk the clock reads 0.0 and nobody is riding', () => {
    const hud = hudModel(input({ state: snapshot({ phase: 'walk', riders: {}, roundClockMs: 42_340 }) }));
    expect(hud.phase).toBe('walk');
    expect(hud.phaseText).toBe('reconocimiento');
    expect(hud.timeText).toBe('0.0');
    expect(hud.riding).toBe(false);
  });

  it('names the other phases in the locale', () => {
    expect(hudModel(input({ state: snapshot({ phase: 'lobby', riders: {} }) })).phaseText).toBe('Lobby');
    expect(hudModel(input({ state: snapshot({ phase: 'results', riders: {} }) })).phaseText).toBe('Results');
    expect(hudModel(input({ state: snapshot({ phase: 'done', riders: {} }) })).phaseText).toBe('Class finished');
    expect(hudModel(input({ state: snapshot({ phase: 'done', riders: {} }), locale: 'es' })).phaseText).toBe('Prueba terminada');
  });

  it('autopilot on the own rider is shown', () => {
    const state = snapshot({ riders: { host: rider('host', { heightClass: 70, nextFence: 2, faults: 4, autopilot: true }), ana: rider('ana') } });
    expect(hudModel(input({ state })).autopilot).toBe(true);
  });

  it('Spanish: the term stays, the rest is translated', () => {
    const hud = hudModel(input({ locale: 'es' }));
    expect(hud.gearText).toBe('galope largo');
    expect(hud.faultsText).toBe('4 puntos');
    expect(hud.fenceText).toBe('Salto 2');
    expect(hud.phaseText).toBe('manga 1');
    expect(hud.riders.find((row) => row.accountId === 'host')?.name).toBe('Maria con Dakota');
  });
});

describe('resultsModel', () => {
  it('one table per height class in ascending order, the class in the title', () => {
    const classes = resultsModel(table, names, 'en', 'host');
    expect(classes.map((entry) => entry.heightClass)).toEqual([60, 70]);
    expect(classes.map((entry) => entry.title)).toEqual(['Results — 60 cm', 'Results — 70 cm']);
    expect(resultsModel(table, names, 'es', 'host').map((entry) => entry.title)).toEqual(['Resultados — 60 cm', 'Resultados — 70 cm']);
  });

  it('placed rows: place, name, faults and time; the own row marked; autopilot noted', () => {
    const [sixty, seventy] = resultsModel(table, names, 'en', 'host');
    expect(sixty?.rows).toEqual([{ accountId: 'ana', placeText: '1', name: 'Ana on Luna', faults: 0, timeText: '55.2', note: '', isOwn: false }]);
    expect(seventy?.rows[0]).toEqual({ accountId: 'host', placeText: '1', name: 'Maria on Dakota', faults: 4, timeText: '1:00.1', note: 'con autopiloto', isOwn: true });
  });

  it('eliminated rows: no place, no time, the reason as the note, in the server order after the placed rows', () => {
    const [, seventy] = resultsModel(table, names, 'en', 'host');
    expect(seventy?.rows.map((row) => row.accountId)).toEqual(['host', 'bea']);
    expect(seventy?.rows[1]).toEqual({ accountId: 'bea', placeText: '—', name: 'Bea on Nube', faults: 8, timeText: '—', note: 'eliminada — three rehúse', isOwn: false });
  });

  it('names the other elimination reasons in the locale', () => {
    const eliminated = (reason: 'time' | 'disconnected'): ClassTableWire => ({
      '60': [{ place: null, riderId: 'ana', riderName: 'Ana', ponyName: 'Luna', faults: 0, timeMs: null, status: 'eliminated', eliminationReason: reason, autopilot: false }],
    });
    expect(resultsModel(eliminated('time'), names, 'en', 'host')[0]?.rows[0]?.note).toBe('eliminada — time');
    expect(resultsModel(eliminated('disconnected'), names, 'en', 'host')[0]?.rows[0]?.note).toBe('eliminada — sin conexión');
    expect(resultsModel(eliminated('time'), names, 'es', 'host')[0]?.rows[0]?.note).toBe('eliminada — tiempo');
  });

  it('an unknown rider id shows the id as the name', () => {
    const rows = resultsModel({ '60': [{ place: 1, riderId: 'ghost', riderName: '', ponyName: '', faults: 0, timeMs: 50_000, status: 'finished', eliminationReason: null, autopilot: false }] }, names, 'en', 'host');
    expect(rows[0]?.rows[0]?.name).toBe('ghost');
  });

  it('an empty table has no classes', () => {
    expect(resultsModel({}, names, 'en', 'host')).toEqual([]);
  });
});

describe('heatResultsModel (audit K1 r1 #2: what the results screen shows between the heats)', () => {
  it('lists the riders of the heat that just ended: finishers first by faults, the eliminated after, each with the name, faults and how it went', () => {
    const state = snapshot({
      phase: 'results',
      riders: {
        host: rider('host', { faults: 4, status: 'finished', lastLabel: 'batida_corta' }),
        ana: rider('ana', { faults: 0, status: 'finished', lastLabel: 'cero_faltas' }),
        bea: rider('bea', { faults: 8, status: 'eliminated', lastLabel: 'rehuse' }),
      },
    });
    const rows = heatResultsModel(state, names, 'en', 'host');
    expect(rows.map((row) => [row.accountId, row.name, row.faults, row.faultsText, row.statusText, row.isOwn])).toEqual([
      ['ana', 'Ana on Luna', 0, '0 faults', 'Finished', false],
      ['host', 'Maria on Dakota', 4, '4 faults', 'Finished', true],
      ['bea', 'Bea on Nube', 8, '8 faults', 'eliminada', false],
    ]);
  });

  it('a rider still marked riding (a snapshot between patches) has no status text; an empty heat is an empty list; Spanish reads Spanish', () => {
    expect(heatResultsModel(snapshot({ phase: 'results', riders: { ana: rider('ana') } }), names, 'en', 'host')[0]?.statusText).toBe('');
    expect(heatResultsModel(snapshot({ phase: 'done', riders: {} }), names, 'en', 'host')).toEqual([]);
    const es = heatResultsModel(snapshot({ phase: 'results', riders: { host: rider('host', { faults: 4, status: 'finished' }) } }), names, 'es', 'host');
    expect(es[0]).toMatchObject({ name: 'Maria con Dakota', faultsText: '4 puntos', statusText: 'Meta' });
  });
});

describe('namesFrom: a rider who left the room is named by her rider entry or her table row', () => {
  const row = (riderId: string, riderName: string, ponyName: string): ClassTableRowWire => ({ place: null, riderId, riderName, ponyName, faults: 4, timeMs: null, status: 'eliminated', eliminationReason: 'disconnected', autopilot: false });

  it("participants first, then the heat's riders, then the class table rows; empty names are skipped; nothing without a source", () => {
    const state = snapshot({
      participants: { host: { accountId: 'host', riderName: 'Maria', ponyName: 'Dakota', isHost: true } },
      riders: { host: rider('host', { riderName: 'Other', ponyName: 'X' }), ana: rider('ana', { riderName: 'Ana', ponyName: 'Luna' }), cris: rider('cris') },
    });
    const table: ClassTableWire = { '70': [row('bea', 'Bea', 'Nube'), row('ana', 'Anita', 'Z'), row('dani', '', '')] };
    expect(namesFrom(state, table)).toEqual({
      host: { riderName: 'Maria', ponyName: 'Dakota', ponyGender: 'yegua' },
      ana: { riderName: 'Ana', ponyName: 'Luna', ponyGender: 'yegua' },
      bea: { riderName: 'Bea', ponyName: 'Nube', ponyGender: 'yegua' },
    });
    expect(namesFrom(state, null)).toEqual({
      host: { riderName: 'Maria', ponyName: 'Dakota', ponyGender: 'yegua' },
      ana: { riderName: 'Ana', ponyName: 'Luna', ponyGender: 'yegua' },
    });
    expect(namesFrom(null, null)).toEqual({});
  });

  it('heatResultsModel and resultsModel print those names, and an id only for a rider nobody can name', () => {
    const state = snapshot({ phase: 'results', participants: {}, riders: { bea: rider('bea', { riderName: 'Bea', ponyName: 'Nube', status: 'eliminated', faults: 4 }), cris: rider('cris', { status: 'finished' }) } });
    const names = namesFrom(state, { '60': [row('bea', 'Bea', 'Nube')] });
    expect(heatResultsModel(state, names, 'en', 'host').map((r) => r.name)).toEqual(['cris', 'Bea on Nube']);
    expect(resultsModel({ '60': [row('bea', 'Bea', 'Nube')] }, names, 'es', 'host')[0]?.rows[0]?.name).toBe('Bea con Nube');
  });
});

describe('the turn captions the HUD shows say why the horse stopped (K1.1 step 8)', () => {
  const dakota = { rider: 'Maria', pony: 'Dakota', ponyGender: 'yegua' as const };

  it('a missed turn: the term and the reason, in English and in Spanish', () => {
    const en = hudModel(input({ caption: caption('en', { type: 'turn', label: 'recto' }, dakota) })).caption;
    expect(en).toContain('¡Recto!');
    expect(en).toContain('missed the turn');
    const es = hudModel(input({ locale: 'es', caption: caption('es', { type: 'turn', label: 'recto' }, dakota) })).caption;
    expect(es).toContain('¡Recto!');
    expect(es).toContain('se pasó el giro');
  });

  it('a wrong turn: the term and the reason, in English and in Spanish', () => {
    const en = hudModel(input({ caption: caption('en', { type: 'turn', label: 'recorrido_equivocado' }, dakota) })).caption;
    expect(en).toContain('recorrido equivocado');
    expect(en).toContain('wrong way');
    const es = hudModel(input({ locale: 'es', caption: caption('es', { type: 'turn', label: 'recorrido_equivocado' }, dakota) })).caption;
    expect(es).toContain('hacia el otro lado');
  });

  it('negative: a good turn needs no reason — the term alone', () => {
    expect(hudModel(input({ caption: caption('en', { type: 'turn', label: 'giro_cerrado' }, dakota) })).caption).toBe('Dakota: giro cerrado');
  });
});
