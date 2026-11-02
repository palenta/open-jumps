// Pranks and victim protection (plan 1.10): cheap, symmetric, never near a fence, never stacked.

export type PrankKind = 'snort' | 'carrot' | 'bump';

export const PRANK = {
  /** Victim immunity to every prank from everyone after one lands. */
  immunityMs: 8000,
  /** No prank may start if any part of it would fall inside the last strides before a fence. */
  lockoutStrides: 3,
  /** No prank in the first seconds after remounting. */
  remountGraceMs: 2000,
  /** Effect durations; all under the 3 s rule. */
  effectMs: { snort: 1000, carrot: 1500, bump: 800 } as Record<PrankKind, number>,
  /** Charges per round; bump is unlimited (it is the game). */
  chargesPerRound: { snort: 3, carrot: 2, bump: Number.POSITIVE_INFINITY } as Record<PrankKind, number>,
} as const;

export interface PrankContext {
  now: number;
  attacker: {
    eliminated: boolean;
    chargesLeft: Record<PrankKind, number>;
  };
  victim: {
    /** Strides left to the next fence (fractional allowed). */
    stridesToFence: number;
    /** Current stride duration in ms (to convert effect duration into strides). */
    strideMs: number;
    airborne: boolean;
    /** Private opt-out: no snort, no carrot; bumps cannot be opted out of. */
    optOut: boolean;
    immuneUntil: number;
    /** End of the running effect (0 or past = none) and which prank it is (null = none). */
    effectUntil: number;
    effectKind: PrankKind | null;
    remountedAt: number | null;
  };
}

export type PrankRejection =
  | 'attacker-eliminated'
  | 'no-charges'
  | 'victim-opted-out'
  | 'victim-immune'
  | 'victim-under-effect'
  | 'fence-zone'
  | 'airborne'
  | 'remount-grace';

export type PrankCheck = { ok: true } | { ok: false; reason: PrankRejection };

/** Pranks the private opt-out switches off; bumps are part of the game and cannot be opted out of. */
function optOutApplies(kind: PrankKind): boolean {
  return kind !== 'bump';
}

/** Can this prank start now? Pure check of every rule in plan 1.10. */
export function canPrank(kind: PrankKind, ctx: PrankContext): PrankCheck {
  const { now, attacker, victim } = ctx;
  if (attacker.eliminated) return { ok: false, reason: 'attacker-eliminated' };
  if (attacker.chargesLeft[kind] < 1) return { ok: false, reason: 'no-charges' };
  if (victim.optOut && optOutApplies(kind)) return { ok: false, reason: 'victim-opted-out' };
  if (victim.immuneUntil > now) return { ok: false, reason: 'victim-immune' };
  if (victim.effectUntil > now) return { ok: false, reason: 'victim-under-effect' };
  if (victim.airborne) return { ok: false, reason: 'airborne' };
  const effectStrides = PRANK.effectMs[kind] / victim.strideMs;
  if (victim.stridesToFence - effectStrides < PRANK.lockoutStrides) return { ok: false, reason: 'fence-zone' };
  if (victim.remountedAt !== null && now - victim.remountedAt < PRANK.remountGraceMs) {
    return { ok: false, reason: 'remount-grace' };
  }
  return { ok: true };
}

export interface PrankApplied {
  effectUntil: number;
  effectKind: PrankKind;
  immuneUntil: number;
  attackerChargesLeft: number;
}

/** Apply a prank that passed canPrank: one effect of that kind, immunity from now, one charge spent. */
export function applyPrank(kind: PrankKind, ctx: PrankContext): PrankApplied {
  const charges = ctx.attacker.chargesLeft[kind];
  return {
    effectUntil: ctx.now + PRANK.effectMs[kind],
    effectKind: kind,
    immuneUntil: ctx.now + PRANK.immunityMs,
    attackerChargesLeft: Number.isFinite(charges) ? charges - 1 : charges,
  };
}

/**
 * The private opt-out acts at once on the server: a running snort or carrot ends now (effectKind cleared);
 * a running bump keeps its end (bumps cannot be opted out of); immunity already granted is never reset.
 */
export function cancelPrankEffects(victim: PrankContext['victim'], now: number): PrankContext['victim'] {
  if (victim.effectKind !== null && optOutApplies(victim.effectKind) && victim.effectUntil > now) {
    return { ...victim, effectUntil: now, effectKind: null };
  }
  return { ...victim };
}
