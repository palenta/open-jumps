// Code audit round 1, P2: one shared judging path that honours the round mode and the frozen assist settings,
// so the training-only wider window reaches the judge without a second judge or a changed BASE_WINDOW.
import { describe, expect, it } from 'vitest';
import {
  WIDER_WINDOW_FACTOR,
  freezeForRound,
  schoolmasterGear,
  schoolmasterReferenceWindow,
  schoolmasterTapOffset,
  type RoundRules,
} from '../src/rules/assists.js';
import { RANKED_NO_ASSISTS, judgeAttempt, windowForAttempt } from '../src/rules/judging.js';
import { BASE_WINDOW, NO_TAP_LIMIT_MS, judgeTakeoff, takeoffWindow, type ApproachState } from '../src/rules/takeoff.js';

const good = (over: Partial<ApproachState> = {}): ApproachState => ({
  gear: 'collected',
  heightClass: 60,
  angleSharp: false,
  recentHardTurn: false,
  spooked: false,
  leadHorseBonus: false,
  ...over,
});
const lucky = () => 0.99;

const trainingWider: RoundRules = { mode: 'training', assists: freezeForRound({ schoolmaster: false, widerWindow: true }) };
const rankedWider: RoundRules = { mode: 'ranked', assists: freezeForRound({ schoolmaster: false, widerWindow: true }) };
const trainingPlain: RoundRules = { mode: 'training', assists: freezeForRound({ schoolmaster: false, widerWindow: false }) };
const trainingBoth: RoundRules = { mode: 'training', assists: freezeForRound({ schoolmaster: true, widerWindow: true }) };

describe('windowForAttempt: the approach window passed through the round rules', () => {
  it('training with the wider-window setting widens both tiers by the factor', () => {
    expect(windowForAttempt(good(), trainingWider)).toEqual({
      cleanMs: BASE_WINDOW.cleanMs * WIDER_WINDOW_FACTOR,
      perfectMs: BASE_WINDOW.perfectMs * WIDER_WINDOW_FACTOR,
    });
  });

  it('ranked ignores the setting; training without the setting changes nothing', () => {
    expect(windowForAttempt(good(), rankedWider)).toEqual(takeoffWindow(good()));
    expect(windowForAttempt(good(), trainingPlain)).toEqual(takeoffWindow(good()));
  });

  it('RANKED_NO_ASSISTS is the plain approach window', () => {
    expect(windowForAttempt(good({ spooked: true }), RANKED_NO_ASSISTS)).toEqual(takeoffWindow(good({ spooked: true })));
  });
});

describe('judgeAttempt: the same tap, different round rules', () => {
  it('+200 ms on a good collected 60 cm approach: clean in training with the setting, chip (4) otherwise', () => {
    expect(judgeAttempt(good(), 200, lucky, trainingWider)).toMatchObject({ kind: 'clean', faults: 0 });
    expect(judgeAttempt(good(), 200, lucky, rankedWider)).toMatchObject({ kind: 'chip', faults: 4 });
    expect(judgeAttempt(good(), 200, lucky, trainingPlain)).toMatchObject({ kind: 'chip', faults: 4 });
  });

  it('the perfect tier widens too: +97 ms is perfect in training with the setting and clean in ranked', () => {
    expect(judgeAttempt(good(), 97, lucky, trainingWider).kind).toBe('perfect');
    expect(judgeAttempt(good(), 98, lucky, trainingWider).kind).toBe('clean');
    expect(judgeAttempt(good(), 97, lucky, rankedWider).kind).toBe('clean');
  });

  it('the "no tap" boundary stays ±400 ms whatever the window', () => {
    expect(judgeAttempt(good(), NO_TAP_LIMIT_MS + 1, lucky, trainingWider)).toEqual(judgeAttempt(good(), null, lucky, trainingWider));
    expect(judgeAttempt(good(), NO_TAP_LIMIT_MS, lucky, trainingWider).kind).toBe('chip');
    expect(judgeAttempt(good(), -NO_TAP_LIMIT_MS, lucky, trainingWider).kind).toBe('long');
  });

  it('judgeTakeoff is judgeAttempt under RANKED_NO_ASSISTS: one judge, not two', () => {
    for (const offset of [null, 0, 64, 66, 174, 176, 300, -176, 400, 401]) {
      expect(judgeTakeoff(good(), offset, lucky)).toEqual(judgeAttempt(good(), offset, lucky, RANKED_NO_ASSISTS));
      expect(judgeTakeoff(good({ gear: 'gallop' }), offset, lucky)).toEqual(
        judgeAttempt(good({ gear: 'gallop' }), offset, lucky, RANKED_NO_ASSISTS),
      );
    }
  });
});

describe('schoolmaster with both assists on in training still never scores perfect', () => {
  const ride = (approach: ApproachState, round: RoundRules, roll: () => number) => {
    const collected: ApproachState = { ...approach, gear: schoolmasterGear(approach.gear, true) };
    const offset = schoolmasterTapOffset(schoolmasterReferenceWindow(collected, round), roll);
    return { offset, outcome: judgeAttempt(collected, offset, lucky, round) };
  };

  it('the reference window follows the round rules: widened in training with the setting', () => {
    expect(schoolmasterReferenceWindow(good(), trainingBoth)).toEqual(windowForAttempt(good(), trainingBoth));
    expect(schoolmasterReferenceWindow(good(), RANKED_NO_ASSISTS)).toEqual(takeoffWindow(good()));
    expect(schoolmasterReferenceWindow(good())).toEqual(takeoffWindow(good()));
  });

  it('roll 0 lands just outside the widened perfect tier, so the outcome is clean', () => {
    const { offset, outcome } = ride(good(), trainingBoth, () => 0);
    expect(Math.abs(offset)).toBeGreaterThan(BASE_WINDOW.perfectMs * WIDER_WINDOW_FACTOR);
    expect(outcome).toMatchObject({ kind: 'clean', faults: 0 });
  });

  it('for every roll, with or without the lead-horse bonus: clean, never perfect', () => {
    for (const approach of [good(), good({ leadHorseBonus: true }), good({ gear: 'gallop' })]) {
      for (const roll of [0, 0.01, 0.1, 0.5, 0.999999]) {
        const { outcome } = ride(approach, trainingBoth, () => roll);
        expect(outcome.kind).toBe('clean');
        expect(outcome.faults).toBe(0);
      }
    }
  });

  it('keeps the approach risk: a spooked approach with an unlucky roll is a chip or long, never a fall', () => {
    const { outcome } = ride(good({ spooked: true }), trainingBoth, () => 0.999999);
    expect(['chip', 'long']).toContain(outcome.kind);
    expect(outcome.faults).toBe(4);
  });
});
