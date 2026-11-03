// A late joiner's course walk against the real server (audit K1 r2 #3), through the app itself (see liveGame.ts):
// she comes in 2.5 s into a 6 s walk on a fresh device whose clock runs 5 s ahead of the server's and is not
// measured yet — the room sends 'class-course' and 'class-phase' at once, the pings that measure the clock follow
// 200 ms apart. The fly-over must show fence 1 only for that moment, then the fence of the SERVER's window, reach
// the last fence before the server's deadline, and give way to the round when the server starts it — never a walk
// restarted at her join.
import type { CourseSpec } from '@open-jumps/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoomSession } from '../src/net/roomSession.js';
import type { ServerMessage } from '../src/net/types.js';
import { walkFocus } from '../src/walk/walkModel.js';
import { bootApp, newDevice, until, type LiveApp } from './helpers.js';
import { appFor, dom, ring, text } from './liveGame.js';

/** Three fences over 120 m: the fly-over has a first, a middle and a last fence to show. */
const WALK_COURSE: CourseSpec = {
  id: 'client-late-walk',
  version: 1,
  lengthM: 120,
  speedMPerMin: 300,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 60, type: 'oxer' },
    { number: 3, distanceM: 100, type: 'vertical' },
  ],
  turns: [],
};
const WALK_MS = 6000;

let live: LiveApp;

beforeAll(async () => {
  live = await bootApp({ course: WALK_COURSE, timing: { walkMs: WALK_MS, resultsMs: 500 } });
});

afterAll(async () => {
  await live?.close();
  await dom.happyDOM.close();
});

describe("a late joiner's walk before her clock is measured (audit K1 r2 #3)", () => {
  it('in 2.5 s into the walk, toClient still null: fence 1 for the moment → the clock measured → the fence of the server\'s window → the last fence before the server\'s deadline → the round when the server starts it', async () => {
    const host = await newDevice(live, 'Host');
    const maria = await newDevice(live, 'Maria', 5000); // her device runs 5 s ahead of the server
    const created = await host.api.createRoom();
    if (!created.ok || created.value.roomId === undefined) throw new Error('no live room');
    const { code, roomId } = created.value;
    expect((await maria.api.knock(code)).ok).toBe(true);
    expect((await host.api.door(code, 'admit', maria.profile.id)).ok).toBe(true);
    const hostSession = new RoomSession({ sdk: host.sdk(), clock: host.clock });
    const hostMessages: ServerMessage[] = [];
    hostSession.onMessage((message) => hostMessages.push(message));
    await hostSession.connect(roomId, code);
    const app = await appFor(maria);

    hostSession.send({ type: 'start-class', order: 'random' });
    await until(() => hostMessages.some((m) => m.type === 'class-phase' && m.phase === 'walk'), 5000, 'the walk');
    const walk = hostMessages.find((m): m is Extract<ServerMessage, { type: 'class-phase' }> => m.type === 'class-phase' && m.phase === 'walk');
    if (!walk || walk.endsAt === null) throw new Error('no walk window');
    const { startedAt, endsAt } = walk;
    expect(endsAt - startedAt).toBe(WALK_MS);
    // The room's clock is Date.now() here: the server's own reading of "now".
    await until(() => Date.now() >= startedAt + 2500, 5000, '2.5 s into the walk');

    ring(app, code); // admitted already: the doorbell connects her at once
    await until(() => app.root.dataset.screen === 'walk', 3000, 'her walk screen');
    const focusNow = (): number => {
      app.game.frame(maria.clock.now());
      return Number(text(app.root.querySelector('[data-focus]:not([data-fence-marker])')));
    };
    expect(maria.clock.ready()).toBe(false); // the series has only begun
    expect(focusNow()).toBe(1);

    await until(() => maria.clock.ready(), 3000, 'her clock measured');
    const serverFocus = (serverNow: number): number => walkFocus(WALK_MS, WALK_COURSE.fences.length, serverNow - startedAt);
    const before = serverFocus(Date.now());
    const shown = focusNow();
    const after = serverFocus(Date.now());
    expect([before, after]).toContain(shown);
    expect(shown).toBe(2); // ≈ 3 s of the server's 6 s; a walk restarted at her join would still show fence 1

    await until(() => Date.now() >= endsAt - 400, 5000, 'just before the server ends the walk');
    expect(app.root.dataset.screen).toBe('walk');
    expect(focusNow()).toBe(3); // the end of the fly-over is the server's deadline, not her join + 6 s
    await until(() => app.root.dataset.screen === 'round', 3000, 'the round when the server starts it');

    app.game.destroy();
    await hostSession.leave();
  }, 30000);
});
