import type { ActorVitals } from "./combatTypes";

export type ActorTraitKey = "body" | "spirit";

export interface ActorTraits {
  body: number;
  spirit: number;
}

export interface EffectiveActorStats {
  traits: ActorTraits;
  spawnVitals: ActorVitals;
  maxVitals: ActorVitals;
  regenRatesPerSecond: ActorVitals;
  movementSpeedMultiplier: number;
  aimStability: number;
  recoilRecoveryMultiplier: number;
  suppressionResistance: number;
  suppressionThreshold: number;
  panicThreshold: number;
  panicDurationMultiplier: number;
  bleedTolerance: number;
  woundTolerance: number;
  dodgeChance: number;
  cloneSicknessTolerance: number;
}

export interface EffectiveActorStatsInput {
  traits: ActorTraits;
  traitDeltas?: readonly Partial<ActorTraits>[];
}

export const actorTraitKeys = ["body", "spirit"] as const satisfies readonly ActorTraitKey[];

const baseCapacityFloor = 100;
const baseSuppressionThreshold = 24;
const actionRegenRateMultiplier = 10;

export function deriveEffectiveActorStats(input: EffectiveActorStatsInput): EffectiveActorStats {
  const baseTraits = normalizedActorTraits(input.traits);
  const traitDelta = effectiveTraitDelta(input.traitDeltas);
  const traits = addTraitDelta(baseTraits, traitDelta);
  const maxVitals = deriveMaxVitals(baseTraits, traitDelta);
  return {
    traits,
    spawnVitals: {
      health: clamp(roundStat(traits.body), 1, maxVitals.health),
      action: clamp(roundStat(actionCapacity(traits)), 1, maxVitals.action),
      spirit: clamp(roundStat(traits.spirit), 1, maxVitals.spirit),
    },
    maxVitals,
    regenRatesPerSecond: deriveRegenRates(traits),
    movementSpeedMultiplier: roundStat(clamp(0.75 + bodySpiritBlend(traits, 0.75) / 400, 0.55, 1)),
    aimStability: roundStat(clamp(0.5 + bodySpiritBlend(traits, 0.35) / 200, 0.4, 8)),
    recoilRecoveryMultiplier: roundStat(clamp(0.6 + bodySpiritBlend(traits, 0.7) / 250, 0.5, 8)),
    suppressionResistance: roundStat(clamp(traits.spirit / 100, 0.25, 10_000)),
    suppressionThreshold: roundStat(Math.max(1, baseSuppressionThreshold * clamp(traits.spirit / 100, 0.25, 10_000))),
    panicThreshold: roundStat(Math.max(1, baseSuppressionThreshold * clamp(traits.spirit / 100, 0.25, 10_000))),
    panicDurationMultiplier: roundStat(clamp(1.35 - traits.spirit / 250, 0.35, 1.25)),
    bleedTolerance: roundStat(clamp(0.55 + traits.body / 220, 0.45, 10_000)),
    woundTolerance: roundStat(clamp(0.55 + traits.body / 222, 0.45, 10_000)),
    dodgeChance: 0,
    cloneSicknessTolerance: roundStat(clamp(0.45 + (traits.body + traits.spirit) / 360, 0.45, 10_000)),
  };
}

export function effectiveActorTraits(
  baseTraits: ActorTraits,
  traitDeltas: readonly Partial<ActorTraits>[] = [],
): ActorTraits {
  return addTraitDelta(normalizedActorTraits(baseTraits), effectiveTraitDelta(traitDeltas));
}

export function cloneActorTraits(traits: ActorTraits): ActorTraits {
  return { body: traits.body, spirit: traits.spirit };
}

export function cloneEffectiveActorStats(stats: EffectiveActorStats): EffectiveActorStats {
  return {
    traits: cloneActorTraits(stats.traits),
    spawnVitals: cloneVitals(stats.spawnVitals),
    maxVitals: cloneVitals(stats.maxVitals),
    regenRatesPerSecond: cloneVitals(stats.regenRatesPerSecond),
    movementSpeedMultiplier: stats.movementSpeedMultiplier,
    aimStability: stats.aimStability,
    recoilRecoveryMultiplier: stats.recoilRecoveryMultiplier,
    suppressionResistance: stats.suppressionResistance,
    suppressionThreshold: stats.suppressionThreshold,
    panicThreshold: stats.panicThreshold,
    panicDurationMultiplier: stats.panicDurationMultiplier,
    bleedTolerance: stats.bleedTolerance,
    woundTolerance: stats.woundTolerance,
    dodgeChance: stats.dodgeChance,
    cloneSicknessTolerance: stats.cloneSicknessTolerance,
  };
}

function deriveMaxVitals(baseTraits: ActorTraits, traitDelta: ActorTraits): ActorVitals {
  return {
    health: roundStat(Math.max(1, Math.max(baseCapacityFloor, baseTraits.body) + traitDelta.body)),
    action: roundStat(Math.max(1, Math.max(baseCapacityFloor, actionCapacity(baseTraits)) + actionCapacity(traitDelta))),
    spirit: roundStat(Math.max(1, Math.max(baseCapacityFloor, baseTraits.spirit) + traitDelta.spirit)),
  };
}

function deriveRegenRates(traits: ActorTraits): ActorVitals {
  return {
    health: roundStat(clamp(0.3333 + traits.body * 0.0054167 + traits.spirit * 0.00125, 0.01, 10_000)),
    action: roundStat(clamp((0.45 + traits.body * 0.0195) * actionRegenRateMultiplier, 0.01, 10_000)),
    spirit: roundStat(clamp(0.15 + traits.body * 0.0055 + traits.spirit * 0.014, 0.01, 10_000)),
  };
}

function actionCapacity(traits: ActorTraits): number {
  return traits.body * 0.85 + traits.spirit * 0.15;
}

function bodySpiritBlend(traits: ActorTraits, bodyWeight: number): number {
  return traits.body * bodyWeight + traits.spirit * (1 - bodyWeight);
}

function normalizedActorTraits(traits: ActorTraits): ActorTraits {
  return {
    body: finiteTrait(traits.body, "body"),
    spirit: finiteTrait(traits.spirit, "spirit"),
  };
}

function effectiveTraitDelta(traitDeltas: readonly Partial<ActorTraits>[] = []): ActorTraits {
  let body = 0;
  let spirit = 0;
  for (const delta of traitDeltas) {
    body += finiteDelta(delta.body);
    spirit += finiteDelta(delta.spirit);
  }
  return { body: roundStat(body), spirit: roundStat(spirit) };
}

function addTraitDelta(baseTraits: ActorTraits, traitDelta: ActorTraits): ActorTraits {
  return {
    body: Math.max(1, roundStat(baseTraits.body + traitDelta.body)),
    spirit: Math.max(1, roundStat(baseTraits.spirit + traitDelta.spirit)),
  };
}

function finiteTrait(value: number, label: ActorTraitKey): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`actor trait ${label} must be a positive finite number`);
  }
  return value;
}

function finiteDelta(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cloneVitals(value: ActorVitals): ActorVitals {
  return { health: value.health, action: value.action, spirit: value.spirit };
}

function roundStat(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
