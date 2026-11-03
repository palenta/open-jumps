// The server's clock announcement survives a change of connection (audit K1 r4 #2), against the real server with
// its clock frozen: every ping/pong round trip is then 0 ms, so each offset the judge measures is exactly the
// device's skew and a series can be made to give exactly the value of an earlier one. A 'clock-offset' the server
// sent on a connection that broke may never have arrived; the device prefers an announced offset to its own
// estimate, so if the new connection is never told the judge's offset again — because a new series gives the very
// same median — the device keeps translating with the old one for good.
import { matchMaker } from 'colyseus';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClientClock } from '../src/net/clientClock.js';
import { RoomSession, type RoomLike, type SdkLike } from '../src/net/roomSession.js';
import type { ServerMessage } from '../src/net/types.js';
import { bootApp, newDevice, sleep, TIMING, until, type LiveApp } from './helpers.js';

/** The room's clock: it moves only when the test moves it. */
const manual = { now: 1_700_000_000_000 };
/** An application close code that is a plain drop to the server (the seat is kept during a heat). */
const DROP_CODE = 4005;
/** After the last ping of a series: its pong and the server's answer have landed (loopback, nothing held back). */
const SERIES_TAIL_MS = 300;

let live: LiveApp;

beforeAll(async () => {
  live = await bootApp({ clock: () => manual.now });
});

afterAll(async () => {
  await live?.close();
});

/** The device's SDK on a line that loses every 'clock-offset' while `lost()` is true: the server sent it, it never arrives. */
function losingOffsets(sdk: SdkLike, lost: () => boolean): SdkLike {
  const wrap = (room: RoomLike): RoomLike => {
    const onMessage = room.onMessage.bind(room);
    room.onMessage = (type, callback) =>
      onMessage(type, (messageType, payload) => {
        if (String(messageType) === 'clock-offset' && lost()) return;
        callback(messageType, payload);
      });
    return room;
  };
  return {
    joinById: async (roomId, options) => wrap(await sdk.joinById(roomId, options)),
    reconnect: async (token) => wrap(await sdk.reconnect(token)),
  };
}

type ServerClocks = { clocks: Map<string, { active: { offsetMs: number | null; toServerTime(t: number): number | null } | null }>; accountBySession: Map<string, string> };

describe("the judge's clock offset reaches every connection of the session (audit K1 r4 #2)", () => {
  it('A delivered → the judge moves to B and the message is lost on a connection that breaks → a token reconnection whose series gives exactly B again: the device translates as the judge does (within 1 ms)', async () => {
    const host = await newDevice(live, 'OffsetHost');
    const created = await host.api.createRoom();
    if (!created.ok || created.value.roomId === undefined) throw new Error('no live room');
    const { code, roomId } = { code: created.value.code, roomId: created.value.roomId };
    // The device's clock, with a skew the test moves (the frozen server clock makes it the exact measured offset).
    const skew = { ms: 5_000 };
    const clock = new ClientClock(() => manual.now + skew.ms);
    let losing = false;
    const session = new RoomSession({ sdk: losingOffsets(host.sdk(), () => losing), clock, autoReconnect: false });
    const messages: ServerMessage[] = [];
    session.onMessage((m) => messages.push(m));
    const pings = (): number => messages.filter((m) => m.type === 'clock-ping').length;
    const heard = (): number[] => messages.flatMap((m) => (m.type === 'clock-offset' ? [m.offsetMs] : []));

    const room = matchMaker.getLocalRoomById(roomId) as unknown as ServerClocks;
    const sessionId = (): string => [...room.accountBySession].find(([, id]) => id === host.profile.id)?.[0] ?? '';
    const judge = () => room.clocks.get(sessionId())?.active ?? null;
    const gap = (t: number): number => Math.abs((clock.toServer(t) ?? Number.NaN) - (judge()?.toServerTime(t) ?? Number.NaN));

    // Series 1, at the join: A = 5000, announced and heard.
    await session.connect(roomId, code);
    await until(() => pings() >= 8, 5000, 'the join series');
    await sleep(SERIES_TAIL_MS);
    expect(judge()?.offsetMs).toBe(5_000);
    expect(heard()).toEqual([5_000]);
    expect(gap(clock.now())).toBe(0);

    // Series 2, at the course walk: the judge's offset moves to B = 5040 — and the message saying so never arrives.
    losing = true;
    skew.ms = 5_040;
    session.send({ type: 'start-class', order: 'random' });
    await until(() => session.state?.phase === 'walk', 5000, "phase 'walk'");
    await until(() => pings() >= 16, 5000, 'the walk series');
    await sleep(SERIES_TAIL_MS);
    expect(judge()?.offsetMs).toBe(5_040);
    expect(heard()).toEqual([5_000]);
    expect(clock.offset()).toBe(-5_000); // the device still translates with A: its own estimate does not override it
    manual.now += TIMING.walkMs + 100; // the walk is over on the server's clock
    await until(() => session.state?.phase === 'riding' && session.state.riders[host.profile.id] !== undefined, 5000, 'riding');

    // The connection that lost B breaks; the server keeps the seat, and the tab takes it back by its token.
    const server = matchMaker.getLocalRoomById(roomId);
    server.clients[0]?.leave(DROP_CODE);
    await until(() => session.status === 'dropped', 5000, 'the drop');
    losing = false;
    const back = messages.length;
    expect(await session.resume()).toBe(true);

    // Series 3, on the new connection: exactly B again. The device hears B — at once, before the first ping of the
    // new series (the offset in force is told to the new connection), and translates as the judge does.
    await until(() => pings() >= 24, 5000, 'the series of the new connection');
    await sleep(SERIES_TAIL_MS);
    expect(judge()?.offsetMs).toBe(5_040);
    expect(heard().at(-1)).toBe(5_040);
    const since = messages.slice(back);
    expect(since.findIndex((m) => m.type === 'clock-offset')).toBeLessThan(since.findIndex((m) => m.type === 'clock-ping'));
    expect(since.find((m) => m.type === 'clock-offset')).toEqual({ type: 'clock-offset', offsetMs: 5_040 });
    for (const t of [clock.now(), clock.now() + 60_000]) expect(gap(t)).toBeLessThanOrEqual(1);
    await session.leave();
  }, 30000);
});
