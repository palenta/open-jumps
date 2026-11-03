// Plan 2.3, matrix row 3: the instant hint runs the SAME judge as the server (judgeAttempt) on the client
// the moment the rider taps, with the approach the client can see (gear, line, hard turn — spooks and the
// lead horse unknown) and the tap translated through the clock estimate; the server's verdict closes it.
import {
  freezeForRound,
  judgeAttempt,
  NO_TAP_LIMIT_MS,
  RANKED_NO_ASSISTS,
  windowForAttempt,
  type ApproachState,
  type RoundRules,
  type TakeoffOutcome,
} from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { ClientClock } from '../src/net/clientClock.js';
import { InstantHint, type Hint, type HintContext } from '../src/round/hint.js';

/** The favourable roll: a gallop tap in the clean tier keeps the rail up. */
const favourable = (): number => 1;

const context70: HintContext = { heightClass: 70, rules: RANKED_NO_ASSISTS };

const trainingWider: RoundRules = {
  mode: 'training',
  assists: freezeForRound({ schoolmaster: false, widerWindow: true }),
};

/** The approach the hint assumes: collected, straight, no hard turn; spooks and the lead horse unknown (false). */
const assumed = (over: Partial<ApproachState> = {}): ApproachState => ({
  gear: 'collected',
  heightClass: 70,
  angleSharp: false,
  recentHardTurn: false,
  spooked: false,
  leadHorseBonus: false,
  ...over,
});

/** The shared judge's verdict for the assumed approach, as the hint must reproduce it. */
const judged = (offsetMs: number | null, over: Partial<ApproachState> = {}, rules: RoundRules = RANKED_NO_ASSISTS): TakeoffOutcome =>
  judgeAttempt(assumed(over), offsetMs, favourable, rules);

/** A ready clock whose server runs `offset` ms ahead of the device (three pings 200 ms apart, device at 10 000). */
function readyClock(offset: number): ClientClock {
  let t = 10_000;
  const clock = new ClientClock(() => t);
  for (let i = 0; i < 3; i += 1) {
    clock.onPing(t + offset);
    t += 200;
  }
  return clock;
}

/** A hint with an open approach for fence 1, attempt 1 at server time 6000. */
function armed(offset = 0, context: HintContext = context70): InstantHint {
  const hint = new InstantHint(readyClock(offset), context);
  hint.approach({ fence: 1, attempt: 1, t0: 6000 });
  return hint;
}

const T0 = 6000;

describe('InstantHint.tap', () => {
  it('is null before any approach was opened', () => {
    const hint = new InstantHint(readyClock(0), context70);
    expect(hint.tap(T0 + 10)).toBeNull();
    expect(hint.current()).toBeNull();
  });

  it('is null while the clock estimate is not ready (no translation of the tap into server time)', () => {
    const hint = new InstantHint(new ClientClock(() => 10_000), context70);
    hint.approach({ fence: 1, attempt: 1, t0: T0 });
    expect(hint.tap(T0 + 10)).toBeNull();
    expect(hint.current()).toBeNull();
  });

  it('a tap 10 ms after t0 on a collected approach is a perfect, not provisional hint, and current() shows it', () => {
    const hint = armed();
    const expected: Hint = { fence: 1, attempt: 1, offsetMs: 10, outcome: judged(10), provisional: false };
    expect(judged(10).kind).toBe('perfect');
    expect(hint.tap(T0 + 10)).toEqual(expected);
    expect(hint.current()).toEqual(expected);
  });

  it('applies the clock estimate: with the server 5 s ahead a device reading of t0 − 5000 + 10 is offset 10', () => {
    const hint = armed(5000);
    expect(hint.tap(T0 - 5000 + 10)?.offsetMs).toBe(10);
  });

  it('the first tap decides: a second tap in the same attempt is null and current() is unchanged', () => {
    const hint = armed();
    const first = hint.tap(T0 + 10);
    expect(first).not.toBeNull();
    expect(hint.tap(T0 + 300)).toBeNull();
    expect(hint.current()).toEqual(first);
  });

  it('a late tap outside the clean window is a chip, exactly as the shared judge says', () => {
    const hint = armed();
    const outcome = hint.tap(T0 + 300)?.outcome;
    expect(outcome).toEqual(judged(300));
    expect(outcome?.kind).toBe('chip');
  });

  it('a tap beyond the no-tap limit is judged as the no-tap outcome of that approach', () => {
    const hint = armed();
    const outcome = hint.tap(T0 - 700)?.outcome;
    expect(700).toBeGreaterThan(NO_TAP_LIMIT_MS);
    expect(outcome).toEqual(judged(-700));
    expect(outcome).toEqual(judged(null));
  });

  it('at gallop a tap in the clean tier outside the perfect band is provisional and judged with the favourable roll', () => {
    const hint = armed();
    hint.setGear('gallop');
    const result = hint.tap(T0 + 60);
    const window = windowForAttempt(assumed({ gear: 'gallop' }), RANKED_NO_ASSISTS);
    expect(60).toBeGreaterThan(window.perfectMs);
    expect(60).toBeLessThanOrEqual(window.cleanMs);
    expect(result?.outcome).toEqual(judged(60, { gear: 'gallop' }));
    expect(result?.outcome.kind).toBe('clean');
    expect(result?.provisional).toBe(true);
  });

  it('at gallop a tap inside the perfect band is still clean (gallop never scores perfect) and provisional', () => {
    const hint = armed();
    hint.setGear('gallop');
    const result = hint.tap(T0 + 10);
    expect(result?.outcome).toEqual(judged(10, { gear: 'gallop' }));
    expect(result?.outcome.kind).toBe('clean');
    expect(result?.provisional).toBe(true);
  });

  it('a gallop miss is a fall and not provisional: only the clean window depends on the roll', () => {
    const hint = armed();
    hint.setGear('gallop');
    const result = hint.tap(T0 + 200);
    expect(result?.outcome).toEqual(judged(200, { gear: 'gallop' }));
    expect(result?.outcome.kind).toBe('fall');
    expect(result?.provisional).toBe(false);
  });

  it('setGear back to collected judges with the collected window and is not provisional', () => {
    const hint = armed();
    hint.setGear('gallop');
    hint.setGear('collected');
    const result = hint.tap(T0 + 60);
    expect(result?.outcome).toEqual(judged(60));
    expect(result?.provisional).toBe(false);
  });

  it('setLine(angle) narrows the window: a tap that is clean on the centre line becomes the judge\'s sharp-angle verdict (a run-out)', () => {
    const hint = armed();
    hint.setLine('angle');
    const outcome = hint.tap(T0 + 140)?.outcome;
    expect(judged(140).kind).toBe('clean');
    expect(outcome).toEqual(judged(140, { angleSharp: true }));
    expect(outcome?.kind).toBe('runout');
  });

  it('setLine(center) after an angle restores the centre-line window', () => {
    const hint = armed();
    hint.setLine('angle');
    hint.setLine('center');
    expect(hint.tap(T0 + 140)?.outcome).toEqual(judged(140));
  });

  it('setHardTurn(true) narrows the window: a tap that is clean without it becomes the judge\'s hard-turn verdict (a chip)', () => {
    const hint = armed();
    hint.setHardTurn(true);
    const outcome = hint.tap(T0 + 140)?.outcome;
    expect(outcome).toEqual(judged(140, { recentHardTurn: true }));
    expect(outcome?.kind).toBe('chip');
  });

  it('the hard turn is cleared by the take-off it narrowed: the next approach is judged without it', () => {
    const hint = armed();
    hint.setHardTurn(true);
    const first = hint.tap(T0 + 140);
    expect(first?.outcome.kind).toBe('chip');
    hint.verdict({ fence: 1, attempt: 1, outcome: judged(140, { recentHardTurn: true }), offsetMs: 140 });
    hint.approach({ fence: 2, attempt: 1, t0: 9000 });
    const second = hint.tap(9000 + 140);
    expect(second?.outcome).toEqual(judged(140));
    expect(second?.outcome.kind).toBe('clean');
  });

  it('a new approach for the next attempt of the same fence (after a refusal) re-arms the tap', () => {
    const hint = armed();
    expect(hint.tap(T0 + 500)).not.toBeNull();
    hint.approach({ fence: 1, attempt: 2, t0: 9000 });
    const retry = hint.tap(9000 + 10);
    expect(retry).toEqual({ fence: 1, attempt: 2, offsetMs: 10, outcome: judged(10), provisional: false });
    expect(hint.current()).toEqual(retry);
  });

  it('configure() with a higher class narrows the window: a tap that is clean at 70 cm is a chip at 90 cm', () => {
    const hint = armed();
    const at70 = windowForAttempt(assumed(), RANKED_NO_ASSISTS);
    const at90 = windowForAttempt(assumed({ heightClass: 90 }), RANKED_NO_ASSISTS);
    const offset = Math.ceil((at70.cleanMs + at90.cleanMs) / 2);
    hint.configure({ heightClass: 90, rules: RANKED_NO_ASSISTS });
    const outcome = hint.tap(T0 + offset)?.outcome;
    expect(judged(offset).kind).toBe('clean');
    expect(outcome).toEqual(judged(offset, { heightClass: 90 }));
    expect(outcome?.kind).toBe('chip');
  });

  it('configure() with training rules and the wider window widens the hint like the server: a ranked chip is a training clean', () => {
    const hint = armed(0, { heightClass: 70, rules: trainingWider });
    const outcome = hint.tap(T0 + 200)?.outcome;
    expect(judged(200).kind).toBe('chip');
    expect(outcome).toEqual(judged(200, {}, trainingWider));
    expect(outcome?.kind).toBe('clean');
  });
});

describe('InstantHint.verdict', () => {
  it('agrees when the server\'s kind matches the hint, then closes the approach: current() null, no more taps', () => {
    const hint = armed();
    const shown = hint.tap(T0 + 10);
    const verdict = judged(10);
    expect(hint.verdict({ fence: 1, attempt: 1, outcome: verdict, offsetMs: 10 })).toEqual({ hint: shown, verdict, agreed: true });
    expect(hint.current()).toBeNull();
    expect(hint.tap(T0 + 20)).toBeNull();
  });

  it('disagrees when the server knew more: a lead-horse clean where the hint said chip', () => {
    const hint = armed();
    const shown = hint.tap(T0 + 180);
    expect(shown?.outcome.kind).toBe('chip');
    const verdict = judged(180, { leadHorseBonus: true });
    expect(verdict.kind).toBe('clean');
    expect(hint.verdict({ fence: 1, attempt: 1, outcome: verdict, offsetMs: 180 })).toEqual({ hint: shown, verdict, agreed: false });
    expect(hint.current()).toBeNull();
  });

  it('has nothing to compare when the rider never tapped: hint null, agreed null, and the approach is closed', () => {
    const hint = armed();
    const verdict = judged(null);
    expect(hint.verdict({ fence: 1, attempt: 1, outcome: verdict, offsetMs: null })).toEqual({ hint: null, verdict, agreed: null });
    expect(hint.tap(T0 + 10)).toBeNull();
    expect(hint.current()).toBeNull();
  });

  it('a verdict for another fence or attempt is not compared with the hint (hint null, agreed null) and still closes the approach', () => {
    const hint = armed();
    expect(hint.tap(T0 + 10)).not.toBeNull();
    const verdict = judged(10);
    expect(hint.verdict({ fence: 2, attempt: 1, outcome: verdict, offsetMs: 10 })).toEqual({ hint: null, verdict, agreed: null });
    expect(hint.current()).toBeNull();
    expect(hint.tap(T0 + 20)).toBeNull();
  });
});
