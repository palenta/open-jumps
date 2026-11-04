// K1.1 step 6: the one source of the own horse's take-off window on the client. The instant hint judges a tap with
// it and the take-off marker is drawn from it: the approach state as of a moment (the gear in force then, the line,
// the hard turn, the class height; spooks and the lead horse unknown) and the window of the shared rules for it.
import { BASE_WINDOW, freezeForRound, PACKET, RANKED_NO_ASSISTS, windowForAttempt, WINDOW_MODIFIERS, windowScaleForHeight, type RoundRules } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { ApproachWindow, type WindowContext } from '../src/round/approachWindow.js';

const context70: WindowContext = { heightClass: 70, rules: RANKED_NO_ASSISTS };
const trainingWider: RoundRules = { mode: 'training', assists: freezeForRound({ schoolmaster: false, widerWindow: true }) };

/** The plain window at 70 cm in collected canter: 175 × 0.9 = 157.5 ms clean, 65 × 0.9 = 58.5 ms perfect. */
const CLEAN_70 = BASE_WINDOW.cleanMs * windowScaleForHeight(70);
const PERFECT_70 = BASE_WINDOW.perfectMs * windowScaleForHeight(70);

describe('ApproachWindow.stateAt', () => {
  it('before anything is set: collected, the class height, straight, no hard turn, no spook, no lead horse', () => {
    expect(new ApproachWindow(context70).stateAt(5_000)).toEqual({
      gear: 'collected',
      heightClass: 70,
      angleSharp: false,
      recentHardTurn: false,
      spooked: false,
      leadHorseBonus: false,
    });
  });

  it('the gear in force AT the moment asked: before a change the old gear, from its moment on the new one', () => {
    const window = new ApproachWindow(context70);
    window.setGear('gallop', 6_000);
    expect(window.stateAt(5_999).gear).toBe('collected');
    expect(window.stateAt(6_000).gear).toBe('gallop');
    window.setGear('collected', 6_500);
    expect(window.stateAt(6_200).gear).toBe('gallop');
    expect(window.stateAt(6_500).gear).toBe('collected');
    expect(window.stateAt(9_000).gear).toBe('collected');
  });

  it('the line of the last shift and the hard turn of the last turn verdict, until the fence is cleared', () => {
    const window = new ApproachWindow(context70);
    window.setLine('angle');
    window.setHardTurn(true);
    expect(window.stateAt(5_000)).toMatchObject({ angleSharp: true, recentHardTurn: true });
    window.setLine('center');
    window.clearedFence();
    expect(window.stateAt(5_000)).toMatchObject({ angleSharp: false, recentHardTurn: false });
  });

  it('spooks and the lead-horse bonus are unknown on the client: always false, so the window is never wider than the judge\'s', () => {
    const window = new ApproachWindow(context70);
    window.setGear('extended', 0);
    window.setLine('angle');
    window.setHardTurn(true);
    expect(window.stateAt(1_000)).toMatchObject({ spooked: false, leadHorseBonus: false });
  });

  it('configure: another height from then on', () => {
    const window = new ApproachWindow(context70);
    window.configure({ heightClass: 90, rules: RANKED_NO_ASSISTS });
    expect(window.stateAt(0).heightClass).toBe(90);
  });

  it('negative: reading changes nothing — the same moment reads the same state twice', () => {
    const window = new ApproachWindow(context70);
    window.setGear('gallop', 6_000);
    expect(window.stateAt(6_100)).toEqual(window.stateAt(6_100));
    expect(window.stateAt(5_000).gear).toBe('collected');
  });
});

describe('ApproachWindow.windowAt', () => {
  it('is the shared windowForAttempt of stateAt for the round\'s rules: 157.5 / 58.5 ms at 70 cm in collected canter', () => {
    const window = new ApproachWindow(context70);
    expect(window.windowAt(5_000)).toEqual(windowForAttempt(window.stateAt(5_000), RANKED_NO_ASSISTS));
    expect(window.windowAt(5_000).cleanMs).toBeCloseTo(CLEAN_70, 9);
    expect(window.windowAt(5_000).perfectMs).toBeCloseTo(PERFECT_70, 9);
  });

  it('the sharp line narrows both tiers by 0.8, the hard turn by 0.7, both together by 0.56', () => {
    const window = new ApproachWindow(context70);
    window.setLine('angle');
    expect(window.windowAt(0).cleanMs).toBeCloseTo(CLEAN_70 * WINDOW_MODIFIERS.sharpAngle, 9);
    window.setLine('center');
    window.setHardTurn(true);
    expect(window.windowAt(0).perfectMs).toBeCloseTo(PERFECT_70 * WINDOW_MODIFIERS.hardTurn, 9);
    window.setLine('angle');
    expect(window.windowAt(0).cleanMs).toBeCloseTo(CLEAN_70 * WINDOW_MODIFIERS.sharpAngle * WINDOW_MODIFIERS.hardTurn, 9);
  });

  it('gallop halves the window from the moment it is in force; back to collected it is whole again', () => {
    const window = new ApproachWindow(context70);
    window.setGear('gallop', 6_000);
    window.setGear('collected', 7_000);
    expect(window.windowAt(5_000).cleanMs).toBeCloseTo(CLEAN_70, 9);
    expect(window.windowAt(6_500).cleanMs).toBeCloseTo(CLEAN_70 * WINDOW_MODIFIERS.gallop, 9);
    expect(window.windowAt(7_000).cleanMs).toBeCloseTo(CLEAN_70, 9);
  });

  it('the round rules apply: the wider window of training × 1.5; ranked rounds never get it', () => {
    const training = new ApproachWindow({ heightClass: 70, rules: trainingWider });
    expect(training.windowAt(0).cleanMs).toBeCloseTo(CLEAN_70 * 1.5, 9);
    const ranked = new ApproachWindow({ heightClass: 70, rules: { mode: 'ranked', assists: freezeForRound({ schoolmaster: false, widerWindow: true }) } });
    expect(ranked.windowAt(0).cleanMs).toBeCloseTo(CLEAN_70, 9);
  });
});

describe("ApproachWindow — the rider's own pace presses (K1.1 code audit r1, finding 1)", () => {
  const schoolmaster: RoundRules = { mode: 'ranked', assists: freezeForRound({ schoolmaster: true, widerWindow: false }) };

  it('requestGear: from the moment it went out the narrower of the patches\' gear and the requested one; before it the patches\' gear alone', () => {
    const narrowing = new ApproachWindow(context70);
    narrowing.setGear('extended', 1_000);
    narrowing.requestGear('gallop', 2_000);
    expect(narrowing.stateAt(1_999).gear).toBe('extended');
    expect(narrowing.stateAt(2_000).gear).toBe('gallop');
    expect(narrowing.windowAt(2_500).cleanMs).toBeCloseTo(CLEAN_70 * WINDOW_MODIFIERS.gallop, 9);
    const widening = new ApproachWindow(context70);
    widening.setGear('gallop', 1_000);
    widening.requestGear('collected', 2_000);
    expect(widening.stateAt(2_500).gear).toBe('gallop'); // the judge may still be in gallop
    const even = new ApproachWindow(context70);
    even.requestGear('extended', 2_000);
    expect(even.stateAt(2_500).gear).toBe('collected'); // the same window: the patches' gear is read
  });

  it('a patch settles in order: the gear it shows settles every press up to the newest that asked for it; a stale patch or a gear nobody asked for settles nothing', () => {
    const window = new ApproachWindow(context70);
    window.requestGear('extended', 1_000);
    window.requestGear('gallop', 1_100);
    window.setGear('collected', 1_150); // stale
    expect(window.stateAt(1_160).gear).toBe('gallop');
    window.setGear('extended', 1_200); // the first press arrived, the second not yet
    expect(window.stateAt(1_210).gear).toBe('gallop');
    window.requestGear('collected', 1_250);
    window.setGear('gallop', 1_300);
    expect(window.stateAt(1_310).gear).toBe('gallop');
    window.setGear('collected', 1_400); // the last press arrived: all settled
    expect(window.stateAt(1_400).gear).toBe('collected');
  });

  it("a gear the patches already showed is no news: a cycle of presses back to it settles only once the newest press asking for it is PACKET.maxAgeMs old", () => {
    const window = new ApproachWindow(context70);
    window.setGear('collected', 0);
    window.requestGear('extended', 1_000);
    window.requestGear('gallop', 1_050);
    window.requestGear('collected', 1_100);
    window.setGear('collected', 1_150); // stale — or the three already arrived: the client cannot tell
    expect(window.stateAt(1_200).gear).toBe('gallop');
    window.setGear('collected', 1_100 + PACKET.maxAgeMs - 1);
    expect(window.stateAt(1_100 + PACKET.maxAgeMs - 1).gear).toBe('gallop');
    window.setGear('collected', 1_100 + PACKET.maxAgeMs);
    expect(window.stateAt(1_100 + PACKET.maxAgeMs).gear).toBe('collected');
  });

  it('controlRegained: the presses sent before it are settled by the next patch whatever it shows; a press after it waits as usual', () => {
    const window = new ApproachWindow(context70);
    window.setGear('collected', 0);
    window.requestGear('gallop', 1_000); // lost with the old connection
    window.controlRegained();
    window.setGear('collected', 1_200);
    expect(window.stateAt(1_300).gear).toBe('collected');
    window.requestGear('gallop', 1_300);
    window.setGear('collected', 1_350); // stale
    expect(window.stateAt(1_400).gear).toBe('gallop');
  });

  it('forced collected wins over every gear: the schoolmaster, the autopilot, a wide turn until the fence is cleared; the presses count again once it ends', () => {
    const school = new ApproachWindow({ heightClass: 70, rules: schoolmaster });
    school.setGear('gallop', 0);
    school.requestGear('extended', 100);
    expect(school.stateAt(200).gear).toBe('collected');
    const window = new ApproachWindow(context70);
    window.setGear('extended', 0);
    window.requestGear('gallop', 100);
    window.setAutopilot(true);
    expect(window.stateAt(200).gear).toBe('collected');
    window.setAutopilot(false);
    expect(window.stateAt(200).gear).toBe('gallop');
    window.wideTurn();
    window.setHardTurn(true);
    expect(window.stateAt(200).gear).toBe('collected');
    window.clearedFence();
    expect(window.stateAt(200)).toMatchObject({ gear: 'gallop', recentHardTurn: false });
    window.wideTurn();
    window.controlRegained(); // the sync names no wide turn: none is assumed
    expect(window.stateAt(200).gear).toBe('gallop');
  });
});
