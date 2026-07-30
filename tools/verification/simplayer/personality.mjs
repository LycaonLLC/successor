// PERSONALITY SEEDS — deterministic per-actor parameter vectors so a population
// feels varied and each run is reproducible from one base seed. Traits are
// integer milli (0..1000); archetype presets bias the base, the per-actor RNG
// stream jitters them so two hunters are not clones. HUMAN PACING is derived
// here (reaction latency, idle gaps, decision cadence, chat frequency) so the
// same seed → the same behaviour timeline (only wall-clock execution varies).
import { streamRng } from "./rng.mjs";

export const TRAITS = ["aggression", "greed", "chattiness", "diligence", "caution", "sociability", "wanderlust"];

// Archetype presets. Each entry is the trait CENTRE (milli); the per-actor RNG
// jitters +/- jitterMilli so a 10-player population is varied.
const ARCHETYPES = {
  hunter: {
    label: "hunter",
    centres: { aggression: 780, greed: 520, chattiness: 380, diligence: 600, caution: 340, sociability: 520, wanderlust: 640 },
    // weighted solo activity menu (weights are integer)
    menu: { patrolAndHunt: 60, chatSmalltalk: 12, campRest: 8, trainerVisit: 6, sellRun: 8, idle: 6 },
  },
  "crafter-farmer": {
    label: "crafter-farmer",
    centres: { aggression: 300, greed: 620, chattiness: 480, diligence: 820, caution: 640, sociability: 520, wanderlust: 300 },
    menu: { surveyMineCraft: 58, chatSmalltalk: 14, campRest: 12, trainerVisit: 8, idle: 8 },
  },
  "trader-socialite": {
    label: "trader-socialite",
    centres: { aggression: 260, greed: 760, chattiness: 820, diligence: 520, caution: 560, sociability: 860, wanderlust: 520 },
    menu: { tradeErrand: 40, chatSmalltalk: 34, trainerVisit: 8, campRest: 6, idle: 12 },
  },
};

export function archetypeNames() {
  return Object.keys(ARCHETYPES);
}

export function buildPersonality({ baseSeed, actorId, archetype }) {
  const preset = ARCHETYPES[archetype];
  if (!preset) throw new Error(`unknown archetype ${archetype}; have ${Object.keys(ARCHETYPES).join(", ")}`);
  const rng = streamRng(baseSeed, "personality", actorId);
  const traits = {};
  for (const trait of TRAITS) {
    const centre = preset.centres[trait] ?? 500;
    // +/-140 milli jitter, clamped 40..980, integer
    traits[trait] = clampMilli(centre + rng.int(-140, 140));
  }
  return {
    archetype,
    label: preset.label,
    traits,
    menu: { ...preset.menu },
    pacing: derivePacing(traits),
  };
}

// HUMAN PACING derived deterministically from traits. Reaction latency lands in
// the owner's 200-900ms band; diligent/aggressive players react toward the fast
// end, cautious players toward the slow end. Idle gaps + decision cadence scale
// with wanderlust/diligence. All integer ms.
function derivePacing(traits) {
  // skew<500 => faster reactions. diligence+aggression pull faster; caution slower.
  const reactionSkew = clampMilli(500 - (traits.diligence - 500) / 3 - (traits.aggression - 500) / 6 + (traits.caution - 500) / 3);
  return {
    reactionBaseMs: 550,          // centre of the 200-900 band
    reactionSpreadMs: 350,        // => ~200..900
    reactionSkewMilli: reactionSkew,
    // gap between finishing one activity loop and starting the next (a human
    // pause / look-around). diligent + low-wanderlust => shorter gaps.
    idleGapBaseMs: 2600 + Math.trunc((traits.caution - 500) * 2) - Math.trunc((traits.diligence - 500) * 1.4),
    idleGapSpreadMs: 2200,
    // occasional longer "AFK moment"
    afkChanceMilli: clampMilli(70 + (500 - traits.diligence) / 6),
    afkBaseMs: 8000,
    afkSpreadMs: 6000,
    // command cadence inside a loop (a beat between deliberate commands)
    stepGapBaseMs: 480 + Math.trunc((traits.caution - 500) / 4),
    stepGapSpreadMs: 320,
  };
}

// Weighted deterministic activity pick from the archetype menu, RNG-driven.
export function pickActivity(rng, menu, allowed = null) {
  const entries = Object.entries(menu).filter(([name]) => !allowed || allowed.includes(name));
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return "idle";
  let roll = rng.int(0, total - 1);
  for (const [name, weight] of entries) {
    if (roll < weight) return name;
    roll -= weight;
  }
  return entries[0][0];
}

function clampMilli(value) {
  return Math.max(40, Math.min(980, Math.trunc(value)));
}
