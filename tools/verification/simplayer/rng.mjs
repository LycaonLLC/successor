// Deterministic seeded-hash randomness for the behaviour brain. Matches the
// sim's existing pattern (client-tui/src/language/voice.ts mulberry32 + fnv1a
// string hash): integer state, one draw per decision, NO wall-clock, NO float
// accumulation. Given a seed the whole decision sequence is reproducible; only
// the shard's real-time execution timing varies run to run.

export function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32 — the sim's canonical 32-bit PRNG (one unit draw per call).
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    // raw unit float in [0,1)
    unit: next,
    // integer in [min, max] inclusive
    int(min, max) {
      const lo = Math.trunc(min);
      const hi = Math.trunc(max);
      if (hi <= lo) return lo;
      return lo + Math.trunc(next() * (hi - lo + 1));
    },
    // p is a milli-probability 0..1000 (integer discipline, no float thresholds)
    chanceMilli(pMilli) {
      return Math.trunc(next() * 1000) < Math.trunc(pMilli);
    },
    // pick one element
    pick(items) {
      if (!items || items.length === 0) return undefined;
      return items[Math.trunc(next() * items.length)];
    },
    // integer ms centred on base with +/- spread, biased by a 0..1000 skew
    // (skew>500 slower, <500 faster) — used for human reaction latency
    latency(baseMs, spreadMs, skewMilli = 500) {
      const roll = next(); // [0,1)
      const skew = Math.trunc(skewMilli) / 1000; // 0..1
      // blend toward the skew end deterministically
      const blended = roll * 0.6 + skew * 0.4;
      const delta = Math.trunc((blended * 2 - 1) * spreadMs);
      return Math.max(0, Math.trunc(baseMs) + delta);
    },
  };
}

// Derive a per-actor RNG stream from a base seed + a stable actor/stream key.
export function streamRng(baseSeed, ...keys) {
  let seed = baseSeed >>> 0;
  for (const key of keys) seed = (seed ^ fnv1a(key)) >>> 0;
  return makeRng(seed >>> 0);
}
