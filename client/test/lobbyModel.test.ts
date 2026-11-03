// The lobby screen's view model (plan 1.5): who is in the room with the host marked and "you" marked, who
// wants in and who was asked to leave (host only, with the club), the door, the start button, and the rider's
// own height class and private assists — a pure function of the snapshot, the host's door view and the locale.
import { allowedHeightClasses } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { lobbyModel, type LobbyInput } from '../src/lobby/lobbyModel.js';
import type { LobbyPerson, LobbyStateSnapshot, LobbyView } from '../src/net/types.js';

const person = (id: string, riderName: string, ponyName: string, over: Partial<LobbyPerson> = {}): LobbyPerson => ({
  id,
  riderName,
  riderGender: 'girl',
  ponyName,
  ponyGender: 'yegua',
  ponyCategory: 'C',
  clubId: null,
  club: null,
  ...over,
});

const snapshot = (over: Partial<LobbyStateSnapshot> = {}): LobbyStateSnapshot => ({
  code: 'ABCDEF',
  hostId: 'host',
  entryOpen: true,
  pendingCount: 1,
  participants: {
    host: { accountId: 'host', riderName: 'Maria', ponyName: 'Dakota', isHost: true },
    ana: { accountId: 'ana', riderName: 'Ana', ponyName: 'Luna', isHost: false },
  },
  phase: 'lobby',
  heatIndex: -1,
  nextHeat: false,
  roundClockMs: 0,
  riders: {},
  ...over,
});

/** The host's door view: Bea rings the bell from her club, Cris was asked to leave. */
const view: LobbyView = {
  code: 'ABCDEF',
  hostId: 'host',
  entryOpen: true,
  autoAdmitClub: false,
  clubId: null,
  participants: [person('host', 'Maria', 'Dakota'), person('ana', 'Ana', 'Luna', { ponyCategory: 'B' })],
  pending: [person('bea', 'Bea', 'Nube', { ponyGender: 'macho', clubId: 'club1', club: { id: 'club1', name: 'Open Sports Barcelona' } })],
  kicked: [person('cris', 'Cris', 'Trueno', { ponyGender: 'macho', ponyCategory: 'A' })],
};

const asHost = (over: Partial<LobbyInput> = {}): LobbyInput => ({
  state: snapshot(),
  view,
  ownId: 'host',
  ponyCategory: 'C',
  heightClass: 70,
  assists: { schoolmaster: false, widerWindow: false },
  locale: 'en',
  ...over,
});

const asGuest = (over: Partial<LobbyInput> = {}): LobbyInput => asHost({ view: null, ownId: 'ana', ponyCategory: 'B', heightClass: 60, ...over });

describe('lobbyModel for the host', () => {
  it('names the room and the door', () => {
    const model = lobbyModel(asHost());
    expect(model.code).toBe('ABCDEF');
    expect(model.title).toBe('Room ABCDEF');
    expect(model.isHost).toBe(true);
    expect(model.entryOpen).toBe(true);
    expect(model.autoAdmitClub).toBe(false);
  });

  it('lists the participants in state order, the host tagged, the own row marked', () => {
    expect(lobbyModel(asHost()).participants).toEqual([
      { accountId: 'host', name: 'Maria on Dakota', isHost: true, isOwn: true, tag: 'Host' },
      { accountId: 'ana', name: 'Ana on Luna', isHost: false, isOwn: false, tag: '' },
    ]);
  });

  it('shows who wants in and who was asked to leave, with the club', () => {
    const model = lobbyModel(asHost());
    expect(model.pending).toEqual([{ accountId: 'bea', name: 'Bea on Nube', club: 'Open Sports Barcelona' }]);
    expect(model.kicked).toEqual([{ accountId: 'cris', name: 'Cris on Trueno', club: null }]);
    expect(model.pendingCount).toBe(1);
  });

  it('may start the class from the lobby', () => {
    expect(lobbyModel(asHost()).canStart).toBe(true);
  });

  it('may not start while a class runs, may again once it is done', () => {
    expect(lobbyModel(asHost({ state: snapshot({ phase: 'walk', heatIndex: 0 }) })).canStart).toBe(false);
    expect(lobbyModel(asHost({ state: snapshot({ phase: 'riding', heatIndex: 0 }) })).canStart).toBe(false);
    expect(lobbyModel(asHost({ state: snapshot({ phase: 'results', heatIndex: 0 }) })).canStart).toBe(false);
    expect(lobbyModel(asHost({ state: snapshot({ phase: 'done', heatIndex: 1 }) })).canStart).toBe(true);
  });

  it('may start alone: one rider may ride the course by herself', () => {
    const alone = snapshot({ participants: { host: { accountId: 'host', riderName: 'Maria', ponyName: 'Dakota', isHost: true } }, pendingCount: 0 });
    const model = lobbyModel(asHost({ state: alone, view: { ...view, participants: [person('host', 'Maria', 'Dakota')], pending: [] } }));
    expect(model.canStart).toBe(true);
    expect(model.participants).toHaveLength(1);
  });

  it('offers the height classes of the pony category and shows the chosen one', () => {
    const model = lobbyModel(asHost());
    expect(model.heightChoices).toEqual(allowedHeightClasses('C'));
    expect(model.heightClass).toBe(70);
    expect(model.heightText).toBe('70 cm');
    expect(lobbyModel(asHost({ ponyCategory: 'A', heightClass: 50 })).heightChoices).toEqual(allowedHeightClasses('A'));
    expect(lobbyModel(asHost({ ponyCategory: 'A', heightClass: 50 })).heightText).toBe('50 cm');
  });

  it('carries the private assists as set', () => {
    expect(lobbyModel(asHost()).schoolmaster).toBe(false);
    expect(lobbyModel(asHost()).widerWindow).toBe(false);
    const assisted = lobbyModel(asHost({ assists: { schoolmaster: true, widerWindow: true } }));
    expect(assisted.schoolmaster).toBe(true);
    expect(assisted.widerWindow).toBe(true);
  });

  it('Spanish: the room title and the host tag', () => {
    const model = lobbyModel(asHost({ locale: 'es' }));
    expect(model.title).toBe('Sala ABCDEF');
    expect(model.participants[0]?.name).toBe('Maria con Dakota');
    expect(model.participants[0]?.tag).toBe('Anfitriona');
  });
});

describe('lobbyModel for a guest', () => {
  it('is not the host, sees the door count but never the door lists, and may not start', () => {
    const model = lobbyModel(asGuest());
    expect(model.isHost).toBe(false);
    expect(model.pending).toEqual([]);
    expect(model.kicked).toEqual([]);
    expect(model.pendingCount).toBe(1);
    expect(model.canStart).toBe(false);
    expect(model.autoAdmitClub).toBe(false);
    expect(model.entryOpen).toBe(true);
  });

  it('tags the own row "you" and the host "Host"', () => {
    expect(lobbyModel(asGuest()).participants).toEqual([
      { accountId: 'host', name: 'Maria on Dakota', isHost: true, isOwn: false, tag: 'Host' },
      { accountId: 'ana', name: 'Ana on Luna', isHost: false, isOwn: true, tag: 'you' },
    ]);
  });

  it('Spanish tags', () => {
    expect(lobbyModel(asGuest({ locale: 'es' })).participants.map((row) => row.tag)).toEqual(['Anfitriona', 'tú']);
  });

  it('may not start even when the class is done', () => {
    expect(lobbyModel(asGuest({ state: snapshot({ phase: 'done', heatIndex: 1 }) })).canStart).toBe(false);
  });

  it('offers the height classes of her own pony category', () => {
    const model = lobbyModel(asGuest());
    expect(model.heightChoices).toEqual(allowedHeightClasses('B'));
    expect(model.heightClass).toBe(60);
    expect(model.heightText).toBe('60 cm');
  });
});
