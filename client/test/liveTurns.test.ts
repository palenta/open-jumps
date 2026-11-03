// K1.1 steps 2–3 on the real server (matrix row 17): the turns of a course that turns both ways, pressed through
// the app itself (createGame with a real RoomSession and the device's own clock, as main.ts wires it) on the
// direction buttons while the own turn window is open and lit — the judge answers with a turn that costs no stop
// (giro cerrado or giro abierto), never "¡Recto!" or "recorrido equivocado"; and a press before the window opened
// is a line shift, not a turn.
import type { CourseSpec } from '@open-jumps/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoundEventWire, ServerMessage } from '../src/net/types.js';
import { bootApp, newDevice, sleep, until, type LiveApp } from './helpers.js';
import { appFor, click, dom, pressControl, serverRider } from './liveGame.js';

/**
 * Three fences and two turns, left then right, at collected canter (5 m/s): fence 1 at 30 m (lands at 33 m), the
 * left turn at 45 m (its zone from 35 m: the turn-ahead ≈ 2 s before the turn), fence 2 at 64 m, the right turn at
 * 80 m (zone from 70 m), fence 3 at 110 m, the finish at 130 m.
 */
const BOTH_WAYS: CourseSpec = {
  id: 'client-live-turns',
  version: 1,
  lengthM: 130,
  speedMPerMin: 300,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 64, type: 'oxer' },
    { number: 3, distanceM: 110, type: 'vertical' },
  ],
  turns: [
    { distanceM: 45, direction: 'left' },
    { distanceM: 80, direction: 'right' },
  ],
};

let live: LiveApp;

beforeAll(async () => {
  live = await bootApp({ course: BOTH_WAYS });
});

afterAll(async () => {
  await live?.close();
  await dom.happyDOM.close();
});

const roundEvents = <T extends RoundEventWire['type']>(messages: ServerMessage[], type: T, riderId: string) =>
  messages
    .filter((m): m is Extract<ServerMessage, { type: 'round-event' }> => m.type === 'round-event')
    .map((m) => m.event)
    .filter((e): e is Extract<RoundEventWire, { type: T }> => e.type === type && e.riderId === riderId);

describe('turns pressed in the open window on the live server (K1.1, matrix row 17)', () => {
  it('a press before the window is a line shift; then left and right, each pressed while both buttons are lit, are turns the judge takes without a stop', async () => {
    const maria = await newDevice(live, 'Turner');
    const app = await appFor(maria);
    const id = maria.profile.id;
    click(app.root, '[data-action="create-room"]');
    await until(() => (app.game.session?.state?.code ?? '') !== '' && app.root.dataset.screen === 'lobby', 5000, 'her lobby');
    await until(() => maria.clock.ready(), 5000, 'her clock');
    await until(() => app.root.querySelector('[data-action="start-class"]:not([disabled])') !== null, 5000, 'the start button');
    click(app.root, '[data-action="start-class"]');
    await until(() => app.root.dataset.screen === 'round', 5000, 'the round screen');
    const roomId = app.roomId();

    // Before any turn-ahead: the direction buttons shift the line (and shift it back, so fence 1 is ridden straight).
    await until(() => (serverRider(roomId, id)?.positionM ?? 0) >= 2, 3000, 'under way');
    expect(app.root.querySelector('[data-control="turn-left"]')?.hasAttribute('data-window')).toBe(false);
    pressControl(app, 'turn-left');
    pressControl(app, 'turn-right');
    expect(app.sent.filter((m) => m.type === 'line' || m.type === 'turn')).toEqual([
      { type: 'line', line: 'angle' },
      { type: 'line', line: 'center' },
    ]);

    for (const [index, direction] of (['left', 'right'] as const).entries()) {
      await until(() => roundEvents(app.received, 'turn-ahead', id).length > index, 20000, `the turn-ahead of turn ${String(index + 1)}`);
      // The window is open from the turn-ahead on: both buttons lit, neither telling the way.
      expect(app.root.querySelector('[data-control="turn-left"]')?.getAttribute('data-window')).toBe('open');
      expect(app.root.querySelector('[data-control="turn-right"]')?.getAttribute('data-window')).toBe('open');
      // The finger lands at the turn moment the server announced (≈ 2 s into the 3.5 s window): a tight turn, so the
      // next fence is no hard approach and the horse, jumping by itself, rides on to the next turn.
      const ahead = roundEvents(app.received, 'turn-ahead', id)[index];
      const moment = ahead === undefined ? null : maria.clock.toClient(ahead.at);
      if (moment === null) throw new Error('the turn moment cannot be read on this clock');
      await sleep(Math.max(0, moment - maria.clock.now()));
      app.game.frame(maria.clock.now());
      expect(app.root.querySelector('[data-control="turn-left"]')?.getAttribute('data-window')).toBe('open'); // still open
      pressControl(app, direction === 'left' ? 'turn-left' : 'turn-right');
      const turns = app.sent.filter((m) => m.type === 'turn');
      expect(turns.at(-1)).toEqual({ type: 'turn', choice: direction, clientTime: expect.any(Number) });
      await until(() => roundEvents(app.received, 'turn', id).length > index, 5000, `the verdict of turn ${String(index + 1)}`);
      const verdict = roundEvents(app.received, 'turn', id)[index];
      expect(['giro_cerrado', 'giro_abierto']).toContain(verdict?.outcome.label);
      expect(verdict?.outcome.stopSec).toBe(0);
      expect(app.root.querySelector(`[data-control="turn-${direction}"]`)?.hasAttribute('data-chosen')).toBe(false); // the verdict clears it
    }
    expect(roundEvents(app.received, 'turn', id).map((e) => e.outcome.label)).not.toContain('recto');
    expect(roundEvents(app.received, 'turn', id).map((e) => e.outcome.label)).not.toContain('recorrido_equivocado');
    app.game.destroy();
  }, 60000);
});
