/**
 * The variation engine — how the MUD keeps its voice fresh without lying.
 *
 * Composers assemble candidate sentences and call `pickVariant`: a seeded
 * choice that refuses the most recently used variants for that situation
 * key. Deterministic under a fixed seed (tests), varied in play (seed =
 * world tick), and never a spam loop — the same situation twice in a row
 * cannot speak the same sentence while alternatives exist.
 */

export interface VoiceMemory {
  /** situation key → most-recent variant indexes (newest last). */
  recent: Map<string, number[]>;
}

export function createVoiceMemory(): VoiceMemory {
  return { recent: new Map() };
}

/** Deterministic 32-bit PRNG (mulberry32) — one draw per pick. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NO_REPEAT_WINDOW = 2;

export function pickVariant(memory: VoiceMemory, situation: string, variants: readonly string[], seed: number): string {
  if (variants.length === 0) return "";
  if (variants.length === 1) return variants[0]!;
  const used = memory.recent.get(situation) ?? [];
  const blocked = new Set(used.slice(-Math.min(NO_REPEAT_WINDOW, variants.length - 1)));
  const candidates: number[] = [];
  for (let i = 0; i < variants.length; i += 1) {
    if (!blocked.has(i)) candidates.push(i);
  }
  const pool = candidates.length > 0 ? candidates : [...variants.keys()];
  const index = pool[Math.floor(seededRandom(seed ^ hashKey(situation))() * pool.length)]!;
  used.push(index);
  if (used.length > 8) used.splice(0, used.length - 8);
  memory.recent.set(situation, used);
  return variants[index]!;
}

/** FNV-1a over the situation key — stable seed spreading per situation. */
export function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Rate gate for chatty registers: at most one line per `intervalMs` per key;
 * callers coalesce what they would have said into the next allowed beat.
 */
export interface RateGate {
  nextAllowedAtMs: Map<string, number>;
}

export function createRateGate(): RateGate {
  return { nextAllowedAtMs: new Map() };
}

export function rateGateAllows(gate: RateGate, key: string, nowMs: number, intervalMs: number): boolean {
  const next = gate.nextAllowedAtMs.get(key) ?? 0;
  if (nowMs < next) return false;
  gate.nextAllowedAtMs.set(key, nowMs + intervalMs);
  return true;
}
