// Deterministic randomness (plan 2.3): a round seed, and chance outcomes derived from seed + fence + attempt.

/** FNV-1a 32-bit hash of a string, so string seeds map to generator states. */
function hashString(text: string): number {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seedToState(seed: number | string): number {
  if (typeof seed === 'number') {
    return Number.isFinite(seed) ? Math.floor(seed) >>> 0 : hashString(String(seed));
  }
  return hashString(seed);
}

/** A seeded generator (mulberry32) returning numbers in [0, 1); the same seed always gives the same sequence. */
export function createRng(seed: number | string): () => number {
  let state = seedToState(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChanceKey {
  roundSeed: number | string;
  fence: number;
  attempt: number;
}

/** A chance outcome that depends only on the key and the probability (reproducible from the stored seed). */
export function chance(key: ChanceKey, probability: number): boolean {
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  const roll = createRng(`${String(key.roundSeed)}|fence:${key.fence}|attempt:${key.attempt}`)();
  return roll < probability;
}
