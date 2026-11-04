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

describe("ApproachWindow — the rider's own pace presses (K1.1 code audit r1, finding 1; since r2 settled by the server's answers alone)", () => {
  const schoolmaster: RoundRules = { mode: 'ranked', assists: freezeForRound({ schoolmaster: true, widerWindow: false }) };
  const answer = (seq: number, at: number, requestedGear: 'collected' | 'extended' | 'gallop') => ({ seq, at, requestedGear, line: 'center' as const });

  it("sent: from the moment it went out the narrower of the log's gear and the requested one; before it the log's gear alone", () => {
    const narrowing = new ApproachWindow(context70);
    narrowing.setGear('extended', 1_000);
    narrowing.sent(1, { gear: 'gallop' }, 2_000);
    expect(narrowing.stateAt(1_999).gear).toBe('extended');
    expect(narrowing.stateAt(2_000).gear).toBe('gallop');
    expect(narrowing.windowAt(2_500).cleanMs).toBeCloseTo(CLEAN_70 * WINDOW_MODIFIERS.gallop, 9);
    const widening = new ApproachWindow(context70);
    widening.setGear('gallop', 1_000);
    widening.sent(1, { gear: 'collected' }, 2_000);
    expect(widening.stateAt(2_500).gear).toBe('gallop'); // the judge may still be in gallop
    const even = new ApproachWindow(context70);
    even.sent(1, { gear: 'extended' }, 2_000);
    expect(even.stateAt(2_500).gear).toBe('collected'); // the same window: the log's gear is read
  });

  it("the server's answers settle in order, each command at its own moment; an entry of the log that no answer brought settles nothing", () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'extended' }, 1_000);
    window.sent(2, { gear: 'gallop' }, 1_100);
    window.setGear('collected', 1_150); // an entry of the log: the gallop is still in flight
    expect(window.stateAt(1_160).gear).toBe('gallop');
    window.applied(answer(1, 1_190, 'extended')); // the first press arrived, the second not yet
    expect(window.stateAt(1_210).gear).toBe('gallop');
    window.sent(3, { gear: 'collected' }, 1_250);
    window.applied(answer(2, 1_290, 'gallop'));
    expect(window.stateAt(1_310).gear).toBe('gallop');
    window.applied(answer(3, 1_400, 'collected')); // the last press arrived: all settled
    expect(window.stateAt(1_400).gear).toBe('collected');
    expect(window.stateAt(1_399).gear).toBe('gallop'); // the server held the gallop until then
  });

  it("a cycle of presses back to the log's gear is no proof of anything: gallop's window however long it lasts — no PACKET.maxAgeMs rule — until the server's answers", () => {
    const window = new ApproachWindow(context70);
    window.setGear('collected', 0);
    window.sent(1, { gear: 'extended' }, 1_000);
    window.sent(2, { gear: 'gallop' }, 1_050);
    window.sent(3, { gear: 'collected' }, 1_100);
    expect(window.stateAt(1_200).gear).toBe('gallop');
    expect(window.stateAt(1_100 + PACKET.maxAgeMs).gear).toBe('gallop');
    expect(window.stateAt(60_000).gear).toBe('gallop');
    window.applied(answer(1, 1_040, 'extended'));
    window.applied(answer(2, 1_090, 'gallop'));
    window.applied(answer(3, 1_140, 'collected'));
    expect(window.stateAt(1_139).gear).toBe('gallop');
    expect(window.stateAt(1_140).gear).toBe('collected');
  });

  it("synced: the presses of a lost connection are settled by the sync's controls from its moment; a press after it waits for its own answer", () => {
    const window = new ApproachWindow(context70);
    window.setGear('collected', 0);
    window.sent(1, { gear: 'gallop' }, 1_000); // lost with the old connection
    window.connectionLost();
    window.synced({ at: 1_200, requestedGear: 'collected', line: 'center' });
    expect(window.stateAt(1_300).gear).toBe('collected');
    window.sent(2, { gear: 'gallop' }, 1_300);
    expect(window.stateAt(1_400).gear).toBe('gallop');
  });

  it('forced collected wins over every gear: the schoolmaster, the autopilot, a wide turn until the fence is cleared; the presses count again once it ends', () => {
    const school = new ApproachWindow({ heightClass: 70, rules: schoolmaster });
    school.setGear('gallop', 0);
    school.sent(1, { gear: 'extended' }, 100);
    expect(school.stateAt(200).gear).toBe('collected');
    const window = new ApproachWindow(context70);
    window.setGear('extended', 0);
    window.sent(1, { gear: 'gallop' }, 100);
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
    window.synced(null); // the sync names no wide turn: none is assumed
    expect(window.stateAt(200).gear).toBe('gallop');
  });
});

describe('ApproachWindow — the server\'s controls log and the commands it has not answered yet (K1.1 code audit r2)', () => {
  /** 70 cm, collected or extended, straight: ±157.5 ms clean; gallop ±78.75; the sharp line ±126. */
  const GALLOP_70 = CLEAN_70 * WINDOW_MODIFIERS.gallop;
  const ANGLE_70 = CLEAN_70 * WINDOW_MODIFIERS.sharpAngle;
  const answer = (seq: number | null, at: number, requestedGear: 'collected' | 'extended' | 'gallop', line: 'center' | 'angle' = 'center') => ({ seq, at, requestedGear, line });

  it("Codex's Pace cycle: extended, gallop, collected, extended in flight — gallop's window until the server's answer rules the gallop out, exactly from that answer's moment", () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'extended' }, 1_000);
    window.sent(2, { gear: 'gallop' }, 1_100);
    window.sent(3, { gear: 'collected' }, 1_200);
    window.sent(4, { gear: 'extended' }, 1_300);
    expect(window.windowAt(1_050).cleanMs).toBeCloseTo(CLEAN_70, 9); // only extended may be in force yet
    expect(window.windowAt(1_425).cleanMs).toBeCloseTo(GALLOP_70, 9); // the first extended patch would arrive now: nothing settled
    window.applied(answer(1, 1_150, 'extended'));
    window.applied(answer(2, 1_260, 'gallop'));
    expect(window.windowAt(1_425).cleanMs).toBeCloseTo(GALLOP_70, 9);
    window.applied(answer(3, 1_380, 'collected'));
    expect(window.stateAt(1_379).gear).toBe('gallop'); // the server's log: gallop until 1 380
    expect(window.windowAt(1_380).cleanMs).toBeCloseTo(CLEAN_70, 9); // collected or the extended still in flight
    window.applied(answer(4, 1_470, 'extended'));
    expect(window.stateAt(1_470).gear).toBe('extended');
    expect(window.stateAt(1_200).gear).toBe('extended'); // the log keeps every moment: extended from 1 150 to 1 260
  });

  it('a command is never in force before the log\'s newest moment: the server applies commands in order', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'extended' }, 1_000);
    window.sent(2, { gear: 'gallop' }, 1_010);
    window.applied(answer(1, 1_200, 'extended'));
    expect(window.windowAt(1_100).cleanMs).toBeCloseTo(CLEAN_70, 9); // before 1 200 the server held collected, and gallop came after it
    expect(window.windowAt(1_200).cleanMs).toBeCloseTo(GALLOP_70, 9);
  });

  it('no timeout is proof of anything: an unanswered command is a possible state ten seconds on', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'gallop' }, 1_000);
    window.sent(2, { gear: 'collected' }, 1_100);
    expect(window.windowAt(11_000).cleanMs).toBeCloseTo(GALLOP_70, 9);
  });

  it('a refused command was never applied: it is dropped, and the commands after it are read without it', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'gallop' }, 1_000);
    window.sent(2, { line: 'angle' }, 1_100);
    expect(window.stateAt(1_200)).toMatchObject({ gear: 'gallop', angleSharp: true }); // both applied: the narrowest of all
    expect(window.stateAt(1_050)).toMatchObject({ gear: 'gallop', angleSharp: false }); // the line had not gone out yet
    window.refused(1);
    expect(window.stateAt(1_200)).toMatchObject({ gear: 'collected', angleSharp: true });
    expect(window.windowAt(1_200).cleanMs).toBeCloseTo(ANGLE_70, 9);
    window.refused(2);
    expect(window.windowAt(1_200).cleanMs).toBeCloseTo(CLEAN_70, 9);
  });

  it('the line shares the mechanism: angle → center keeps the sharp line until the answer, and exactly from the answer\'s moment the centre (finding 3)', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { line: 'angle' }, 1_000);
    expect(window.stateAt(999).angleSharp).toBe(false); // before it went out
    expect(window.stateAt(1_000).angleSharp).toBe(true); // from the send on the judge may have it
    window.applied(answer(1, 1_050, 'collected', 'angle'));
    window.sent(2, { line: 'center' }, 2_000);
    expect(window.windowAt(2_140).cleanMs).toBeCloseTo(ANGLE_70, 9); // a tap 140 ms in: a run-out for the judge, never clean
    window.applied(answer(2, 2_150, 'collected', 'center'));
    expect(window.stateAt(2_140).angleSharp).toBe(true); // the server had the angle until 2 150
    expect(window.stateAt(2_150).angleSharp).toBe(false);
  });

  it('an answer for a later command settles an earlier one never answered: possible until that answer\'s moment, ruled out from it', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'gallop' }, 1_000);
    window.sent(2, { gear: 'collected' }, 1_100);
    window.applied(answer(2, 1_300, 'collected'));
    expect(window.windowAt(1_250).cleanMs).toBeCloseTo(GALLOP_70, 9);
    expect(window.windowAt(1_300).cleanMs).toBeCloseTo(CLEAN_70, 9);
  });

  it('a lost connection and the sync: its commands possible until the sync\'s moment, the sync\'s controls from it, the new connection\'s commands on top', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'gallop' }, 1_000);
    window.connectionLost();
    window.sent(2, { line: 'angle' }, 2_500); // went out on the new connection, before its sync arrived
    window.synced({ at: 2_400, requestedGear: 'collected', line: 'center' }); // the gallop never reached the server
    expect(window.windowAt(2_300).cleanMs).toBeCloseTo(GALLOP_70, 9); // before the sync's moment it may have
    expect(window.stateAt(2_450)).toMatchObject({ gear: 'collected', angleSharp: false });
    expect(window.stateAt(2_600)).toMatchObject({ gear: 'collected', angleSharp: true }); // the new command stays pending
    window.applied(answer(2, 2_620, 'collected', 'angle'));
    expect(window.stateAt(2_610).angleSharp).toBe(false);
    expect(window.stateAt(2_620).angleSharp).toBe(true);
  });

  it('a sync whose controls say the old command arrived: from its moment the server\'s gallop', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'gallop' }, 1_000);
    window.connectionLost();
    window.synced({ at: 2_400, requestedGear: 'gallop', line: 'center' });
    expect(window.windowAt(2_400).cleanMs).toBeCloseTo(GALLOP_70, 9);
    expect(window.windowAt(9_000).cleanMs).toBeCloseTo(GALLOP_70, 9);
  });

  it('negative: a sync without controls rules nothing out — the old commands stay possible', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'gallop' }, 1_000);
    window.connectionLost();
    window.synced(null);
    expect(window.windowAt(5_000).cleanMs).toBeCloseTo(GALLOP_70, 9);
  });

  it('forced collected is the shared rule: once the autopilot is off or the wide turn spent, the requested gear the server told applies at once (finding 2)', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'gallop' }, 1_000);
    window.applied(answer(1, 1_050, 'gallop'));
    window.setAutopilot(true);
    expect(window.stateAt(2_000).gear).toBe('collected');
    window.setAutopilot(false);
    expect(window.stateAt(2_000).gear).toBe('gallop');
    window.wideTurn();
    expect(window.stateAt(2_000).gear).toBe('collected');
    window.clearedFence();
    expect(window.stateAt(2_000).gear).toBe('gallop');
    window.setAutopilot(true);
    window.synced(null); // control handed back: the autopilot is off
    expect(window.stateAt(2_000).gear).toBe('gallop');
  });

  it('the schoolmaster is the frozen rules\' alone: configured on, collected whatever the server holds; configured off, the server\'s gallop', () => {
    const window = new ApproachWindow(context70);
    window.applied(answer(null, 1_000, 'gallop'));
    window.configure({ heightClass: 70, rules: { mode: 'ranked', assists: freezeForRound({ schoolmaster: true, widerWindow: false }) } });
    expect(window.stateAt(2_000).gear).toBe('collected');
    window.configure(context70);
    expect(window.stateAt(2_000).gear).toBe('gallop');
  });

  it('the moments are read on the server\'s clock at the time asked: a device moment is translated by the clock, and without a translation every state of the log counts', () => {
    let offset: number | null = 500; // server − device
    const window = new ApproachWindow(context70, { toServer: (clientTime) => (offset === null ? null : clientTime + offset) });
    window.applied(answer(null, 1_500, 'gallop')); // server ms
    window.applied(answer(null, 2_500, 'collected'));
    expect(window.stateAt(999).gear).toBe('collected');
    expect(window.stateAt(1_000).gear).toBe('gallop'); // device 1 000 = server 1 500
    expect(window.stateAt(2_000).gear).toBe('collected');
    offset = 400; // a refined offset moves the reading with it
    expect(window.stateAt(1_099).gear).toBe('collected');
    expect(window.stateAt(1_100).gear).toBe('gallop');
    offset = null;
    expect(window.stateAt(9_000).gear).toBe('gallop'); // which entry? any of them: the narrowest
  });

  it('negative: the patches play no part — there is no way in for a state patch\'s gear, and setGear is an exact entry of the log, nothing more', () => {
    const window = new ApproachWindow(context70);
    window.sent(1, { gear: 'gallop' }, 1_000);
    window.setGear('collected', 1_200); // an exact entry: the server held collected from 1 200 — the gallop is still in flight
    expect(window.windowAt(1_300).cleanMs).toBeCloseTo(GALLOP_70, 9);
    expect('settle' in window).toBe(false);
    expect('requestGear' in window).toBe(false);
  });
});
