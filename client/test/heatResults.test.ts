// The heat screen at the real server's results boundary (audit K1 r2 #2), through the app itself (see liveGame.ts):
// the tick that brings the last finish or elimination of a heat is also the tick that switches to 'results', and the
// screen is drawn from the riders of that very state. Each row — status and faults — must be what the engine's own
// results say (the rows the room writes), never the values of the tick before: the last rider crossing the line
// with a time fault, and the last rider eliminated by her third refusal.
import { translate, type CourseSpec } from '@open-jumps/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoomSession } from '../src/net/roomSession.js';
import { bootApp, newDevice, sleep, until, type Device, type LiveApp } from './helpers.js';
import { appFor, click, dom, text, type AppUnderTest } from './liveGame.js';

/** One fence at 30 m on 50 m at the club norm (300 m/min): 10 s allowed, so a passive run (line at 10.1 s) has one time fault. */
const TIME_FAULT_COURSE: CourseSpec = {
  id: 'client-time-fault',
  version: 1,
  lengthM: 50,
  speedMPerMin: 300,
  fences: [{ number: 1, distanceM: 30, type: 'vertical' }],
  turns: [],
};

let live: LiveApp;

beforeAll(async () => {
  // A 3 s results phase: time to read the heat screen before 'done' and the class table replace it.
  live = await bootApp({ course: TIME_FAULT_COURSE, timing: { walkMs: 500, resultsMs: 3000 } });
});

afterAll(async () => {
  await live?.close();
  await dom.happyDOM.close();
});

/** Maria hosts in the app; Ana rides in the same heat on a plain session the test drives. */
async function heatOfTwo(): Promise<{ maria: Device; app: AppUnderTest; anaDevice: Device; ana: RoomSession; code: string }> {
  const maria = await newDevice(live, 'Maria');
  const anaDevice = await newDevice(live, 'Ana');
  const app = await appFor(maria);
  click(app.root, '[data-action="create-room"]');
  await until(() => (app.game.session?.state?.code ?? '') !== '' && app.root.dataset.screen === 'lobby', 5000, "Maria's lobby");
  const code = app.game.session?.state?.code ?? '';
  expect((await anaDevice.api.knock(code)).ok).toBe(true);
  expect((await maria.api.door(code, 'admit', anaDevice.profile.id)).ok).toBe(true);
  const ana = new RoomSession({ sdk: anaDevice.sdk(), clock: anaDevice.clock });
  await ana.connect(app.roomId(), code);
  await until(() => maria.clock.ready() && anaDevice.clock.ready(), 5000, 'both clocks');
  await sleep(1000);
  await until(() => app.root.querySelector('[data-action="start-class"]:not([disabled])') !== null, 5000, 'the start button');
  click(app.root, '[data-action="start-class"]');
  await until(() => app.root.dataset.screen === 'round' && ana.state?.phase === 'riding', 5000, 'the heat riding');
  return { maria, app, anaDevice, ana, code };
}

/** The heat screen's rows by account id, read the moment the results screen is drawn. */
async function heatScreenRows(app: AppUnderTest): Promise<Map<string, string>> {
  await until(() => app.root.dataset.screen === 'results' && app.root.querySelector('[data-heat-done]') !== null, 20000, 'the heat screen');
  const rows = new Map<string, string>();
  for (const li of app.root.querySelectorAll('[data-list="heat"] > li[data-id]')) rows.set(li.getAttribute('data-id') ?? '', text(li));
  return rows;
}

/** The row the screen must show for a result the engine wrote: "Rider on Pony · N faults · Finished/eliminada". */
function expectedRow(device: Device, row: { faults: number; status: string }): string {
  const name = translate('en', 'names.riderOnPony', { rider: device.profile.riderName, pony: device.profile.ponyName });
  const status = row.status === 'finished' ? translate('en', 'hud.finished') : translate('en', 'hud.eliminated');
  return `${name} · ${translate('en', 'hud.faults', { faults: row.faults })} · ${status}`;
}

/** The heat's rows as the room wrote them from the engine's results. */
async function engineRows(code: string, count: number) {
  const roundId = `${code}-1#0`;
  await until(async () => (await live.services.repos.results.listByRound(roundId)).length === count, 5000, 'the rows of the heat');
  return live.services.repos.results.listByRound(roundId);
}

describe('a rider who left the room for good keeps her name on the heat screen and in the class table', () => {
  it('Ana leaves before her fence: no participant any more, yet her heat row and her table row read "Ana on Dakota", as the engine wrote her result', async () => {
    const { maria, app, anaDevice, ana, code } = await heatOfTwo();
    await until(() => (app.game.session?.state?.riders[anaDevice.profile.id]?.positionM ?? 0) >= 5, 5000, 'Ana at 5 m');
    await ana.leave(); // consented: out of the room for good, eliminated in the heat
    await until(() => app.game.session?.state?.participants[anaDevice.profile.id] === undefined, 3000, 'Ana gone from the participants');
    const screen = await heatScreenRows(app);
    const rows = await engineRows(code, 2);
    const anaRow = rows.find((r) => r.accountId === anaDevice.profile.id);
    expect(anaRow).toMatchObject({ status: 'eliminated', eliminationReason: 'disconnected' });
    expect(screen.get(anaDevice.profile.id)).toBe(expectedRow(anaDevice, anaRow ?? { faults: -1, status: '' }));
    const mariaRow = rows.find((r) => r.accountId === maria.profile.id);
    expect(screen.get(maria.profile.id)).toBe(expectedRow(maria, mariaRow ?? { faults: -1, status: '' }));
    await until(() => app.root.querySelector('[data-list="results"]') !== null, 10000, 'the class table');
    expect(text(app.root.querySelector(`tr[data-id="${anaDevice.profile.id}"] td:nth-child(2)`))).toBe(translate('en', 'names.riderOnPony', { rider: anaDevice.profile.riderName, pony: anaDevice.profile.ponyName }));
    app.game.destroy();
  }, 40000);
});

describe('the heat screen at the results boundary (audit K1 r2 #2)', () => {
  it('Maria, passive in collected canter, is the last at the line with a time fault: her row says Finished with the chip and the time fault, as the engine wrote it', async () => {
    const { maria, app, anaDevice, ana, code } = await heatOfTwo();
    ana.send({ type: 'gear', gear: 'extended' }); // Ana is done at ≈ 8.5 s, Maria at 10.1 s
    const screen = await heatScreenRows(app);
    const rows = await engineRows(code, 2);
    // A class of two is one heat: its results are the class's last, and the screen says so (audit K1 r3 #6).
    expect(app.game.session?.state?.phase).toBe('results');
    expect(text(app.root.querySelector('[data-waiting]'))).toBe(translate('en', 'results.classDoneWaiting'));
    const mariaRow = rows.find((r) => r.accountId === maria.profile.id);
    expect(mariaRow).toMatchObject({ status: 'finished', faults: 5 }); // the chip (4) and one time fault
    expect(screen.get(maria.profile.id)).toBe(expectedRow(maria, mariaRow ?? { faults: -1, status: '' }));
    const anaRow = rows.find((r) => r.accountId === anaDevice.profile.id);
    expect(screen.get(anaDevice.profile.id)).toBe(expectedRow(anaDevice, anaRow ?? { faults: -1, status: '' }));
    app.game.destroy();
    await ana.leave();
  }, 40000);

  it('Ana on a sharp line never taps and is eliminated by her third refusal, the last of the heat: her row says eliminada with the faults the engine wrote', async () => {
    const { maria, app, anaDevice, ana, code } = await heatOfTwo();
    ana.send({ type: 'line', line: 'angle' }); // a bad approach with no tap is a refusal: 6.7 s, 10.8 s, 14.9 s (out)
    const screen = await heatScreenRows(app);
    const rows = await engineRows(code, 2);
    const anaRow = rows.find((r) => r.accountId === anaDevice.profile.id);
    expect(anaRow).toMatchObject({ status: 'eliminated', eliminationReason: 'refusals' });
    expect(screen.get(anaDevice.profile.id)).toBe(expectedRow(anaDevice, anaRow ?? { faults: -1, status: '' }));
    const mariaRow = rows.find((r) => r.accountId === maria.profile.id);
    expect(screen.get(maria.profile.id)).toBe(expectedRow(maria, mariaRow ?? { faults: -1, status: '' }));
    app.game.destroy();
    await ana.leave();
  }, 40000);
});
