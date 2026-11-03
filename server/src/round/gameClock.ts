// The live room's game clock (audit K1 r5 #1). Every game time the room handles — the simulation tick, the class
// phases, the receive time of a rider command, a rider's disconnection, reconnection and leave, the clock pings and
// pongs, the retry interval of the result outbox — is read from ONE source of milliseconds that never goes back.
//
// The calendar clock (Date.now) cannot be that source: the system may set it back or forward at any moment (NTP;
// macOS `timed` calling settimeofday). A step back of 65 ms made the next tick ask RoundEngine.tick for a time before
// the last one ('tick goes backwards'); the throw escaped the simulation interval and the server process exited with
// every room in it. A step forward would end a course walk early or eliminate a whole heat on its time limit, and a
// step between a ping and its pong biases the clock offset of a rider (or discards the sample).
//
// So the game clock is the wall time read ONCE, when the clock is composed, plus the monotonic time elapsed since
// (performance.now() in production), floored to a whole millisecond: its readings still look like epoch ms, they
// move exactly as fast as the monotonic source, and no later step of the wall changes them. The room simulates
// completed milliseconds only (tick(clock() − 1)), which needs whole milliseconds that never decrease: the floor of a
// non-decreasing reading is one.
//
// The calendar date of a result (recordedAt) is not a game time: it is read from the wall clock itself, separately,
// so a result recorded after a step of the wall carries the date the system believes, as every other date does.

/** The two time sources of the server. */
export interface TimeSources {
  /** Calendar ms since the epoch (Date.now): what the system believes the date is; it may step back or forward. */
  wall: () => number;
  /** Elapsed ms from an arbitrary origin that never decrease (performance.now): the pace of every game time. */
  monotonic: () => number;
}

/** The production sources: the system's calendar clock and the process's monotonic clock. */
export const SYSTEM_TIME: TimeSources = {
  wall: () => Date.now(),
  monotonic: () => performance.now(),
};

/**
 * The game clock composed from `sources`: wall() read once, now, plus the monotonic time elapsed since this call,
 * floored to a whole millisecond. It never decreases as long as `monotonic` never does (its own contract); a step of
 * the wall after composition — back or forward, any size — changes no reading.
 */
export function composeGameClock(sources: TimeSources): () => number {
  const origin = sources.wall();
  const base = sources.monotonic();
  return () => Math.floor(origin + (sources.monotonic() - base));
}
