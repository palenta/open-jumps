// Matrix row 10 (plan 1.10): pranks only on the flat, one at a time, 8 s immunity, opt-out at once, charges.
import { describe, expect, it } from 'vitest';
import { PRANK, applyPrank, canPrank, cancelPrankEffects, type PrankContext } from '../src/rules/pranks.js';

const NOW = 50_000;

function ctx(over: {
  now?: number;
  attacker?: Partial<PrankContext['attacker']>;
  victim?: Partial<PrankContext['victim']>;
} = {}): PrankContext {
  return {
    now: over.now ?? NOW,
    attacker: {
      eliminated: false,
      chargesLeft: { snort: 3, carrot: 2, bump: Number.POSITIVE_INFINITY },
      ...over.attacker,
    },
    victim: {
      stridesToFence: 10,
      strideMs: 500,
      airborne: false,
      optOut: false,
      immuneUntil: 0,
      effectUntil: 0,
      effectKind: null,
      remountedAt: null,
      ...over.victim,
    },
  };
}

describe('constants', () => {
  it('8 s immunity, 3-stride lockout, 2 s remount grace, every effect under 3 s', () => {
    expect(PRANK.immunityMs).toBe(8000);
    expect(PRANK.lockoutStrides).toBe(3);
    expect(PRANK.remountGraceMs).toBe(2000);
    for (const ms of Object.values(PRANK.effectMs)) expect(ms).toBeLessThanOrEqual(3000);
    expect(PRANK.chargesPerRound.snort).toBe(3);
    expect(PRANK.chargesPerRound.carrot).toBe(2);
    expect(PRANK.chargesPerRound.bump).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('canPrank', () => {
  it('allows a snort on the flat with charges left', () => {
    expect(canPrank('snort', ctx())).toEqual({ ok: true });
  });

  it('an eliminated attacker cannot prank', () => {
    expect(canPrank('snort', ctx({ attacker: { eliminated: true } }))).toEqual({ ok: false, reason: 'attacker-eliminated' });
  });

  it('no charges → rejected; bumps never run out', () => {
    const noCharges = ctx({ attacker: { chargesLeft: { snort: 0, carrot: 0, bump: Number.POSITIVE_INFINITY } } });
    expect(canPrank('snort', noCharges)).toEqual({ ok: false, reason: 'no-charges' });
    expect(canPrank('carrot', noCharges)).toEqual({ ok: false, reason: 'no-charges' });
    expect(canPrank('bump', noCharges)).toEqual({ ok: true });
  });

  it('the private opt-out blocks snort and carrot but not bumps', () => {
    const opted = ctx({ victim: { optOut: true } });
    expect(canPrank('snort', opted)).toEqual({ ok: false, reason: 'victim-opted-out' });
    expect(canPrank('carrot', opted)).toEqual({ ok: false, reason: 'victim-opted-out' });
    expect(canPrank('bump', opted)).toEqual({ ok: true });
  });

  it('an immune victim cannot be pranked by anyone', () => {
    expect(canPrank('bump', ctx({ victim: { immuneUntil: NOW + 1 } }))).toEqual({ ok: false, reason: 'victim-immune' });
  });

  it('a victim under an effect cannot receive another (no stacking)', () => {
    expect(canPrank('snort', ctx({ victim: { effectUntil: NOW + 200, effectKind: 'carrot' } }))).toEqual({ ok: false, reason: 'victim-under-effect' });
  });

  it('fence zone: nothing inside the last three strides', () => {
    expect(canPrank('bump', ctx({ victim: { stridesToFence: 2.9 } }))).toEqual({ ok: false, reason: 'fence-zone' });
  });

  it('fence zone covers the whole effect: a 1 s snort at 0.5 s per stride needs 5 strides, a 1.5 s carrot needs 6', () => {
    expect(canPrank('snort', ctx({ victim: { stridesToFence: 4.9 } }))).toEqual({ ok: false, reason: 'fence-zone' });
    expect(canPrank('snort', ctx({ victim: { stridesToFence: 5 } }))).toEqual({ ok: true });
    expect(canPrank('carrot', ctx({ victim: { stridesToFence: 5.9 } }))).toEqual({ ok: false, reason: 'fence-zone' });
    expect(canPrank('carrot', ctx({ victim: { stridesToFence: 6 } }))).toEqual({ ok: true });
  });

  it('nothing in the air', () => {
    expect(canPrank('bump', ctx({ victim: { airborne: true, stridesToFence: 10 } }))).toEqual({ ok: false, reason: 'airborne' });
  });

  it('nothing in the first two seconds after a remount', () => {
    expect(canPrank('snort', ctx({ victim: { remountedAt: NOW - 1999 } }))).toEqual({ ok: false, reason: 'remount-grace' });
    expect(canPrank('snort', ctx({ victim: { remountedAt: NOW - 2000 } }))).toEqual({ ok: true });
  });
});

describe('applyPrank', () => {
  it('starts one effect of the kind\'s duration, records its kind, grants 8 s immunity from now and spends a charge', () => {
    const applied = applyPrank('carrot', ctx());
    expect(applied).toEqual({ effectUntil: NOW + 1500, effectKind: 'carrot', immuneUntil: NOW + 8000, attackerChargesLeft: 1 });
  });

  it('bumps do not consume charges', () => {
    const applied = applyPrank('bump', ctx());
    expect(applied.attackerChargesLeft).toBe(Number.POSITIVE_INFINITY);
    expect(applied.effectKind).toBe('bump');
  });
});

describe('series from several attackers (row 10)', () => {
  const after = (applied: ReturnType<typeof applyPrank>, now = NOW) =>
    ctx({ now, victim: { immuneUntil: applied.immuneUntil, effectUntil: applied.effectUntil, effectKind: applied.effectKind } });

  it('three attackers in turn: only the first lands, the victim is immune for 8 s, then free again', () => {
    const first = applyPrank('snort', ctx());
    expect(canPrank('carrot', after(first))).toEqual({ ok: false, reason: 'victim-immune' });
    expect(canPrank('bump', after(first))).toEqual({ ok: false, reason: 'victim-immune' });
    expect(canPrank('bump', after(first, first.immuneUntil))).toEqual({ ok: true });
  });

  it('simultaneous attacks: the server serialises them, so the second sees the immunity and is rejected', () => {
    const first = applyPrank('snort', ctx());
    expect(canPrank('snort', after(first))).toEqual({ ok: false, reason: 'victim-immune' });
  });

  it('the effect is never extended by a later prank', () => {
    const first = applyPrank('snort', ctx());
    expect(canPrank('carrot', after(first, NOW + 500)).ok).toBe(false);
    expect(first.effectUntil).toBe(NOW + 1000);
  });
});

describe('opt-out acts immediately (cancelPrankEffects)', () => {
  it('a running snort ends now and its kind is cleared', () => {
    const victim = ctx({ victim: { effectUntil: NOW + 900, effectKind: 'snort', optOut: true, immuneUntil: NOW + 7900 } }).victim;
    const cancelled = cancelPrankEffects(victim, NOW);
    expect(cancelled.effectUntil).toBe(NOW);
    expect(cancelled.effectKind).toBeNull();
  });

  it('a running carrot ends now as well', () => {
    const victim = ctx({ victim: { effectUntil: NOW + 1400, effectKind: 'carrot', optOut: true } }).victim;
    const cancelled = cancelPrankEffects(victim, NOW);
    expect(cancelled.effectUntil).toBe(NOW);
    expect(cancelled.effectKind).toBeNull();
  });

  it('a running bump keeps its original end: bumps cannot be opted out of', () => {
    const victim = ctx({ victim: { effectUntil: NOW + 700, effectKind: 'bump', optOut: true } }).victim;
    const cancelled = cancelPrankEffects(victim, NOW);
    expect(cancelled.effectUntil).toBe(NOW + 700);
    expect(cancelled.effectKind).toBe('bump');
  });

  it('immunity already granted is never reset by the opt-out', () => {
    const victim = ctx({ victim: { effectUntil: NOW + 900, effectKind: 'snort', optOut: true, immuneUntil: NOW + 7900 } }).victim;
    expect(cancelPrankEffects(victim, NOW).immuneUntil).toBe(NOW + 7900);
  });

  it('after the cancel, new snorts are still refused by the opt-out', () => {
    const victim = ctx({ victim: { effectUntil: NOW + 900, effectKind: 'snort', optOut: true } }).victim;
    expect(canPrank('snort', ctx({ victim: cancelPrankEffects(victim, NOW) })).ok).toBe(false);
  });
});
