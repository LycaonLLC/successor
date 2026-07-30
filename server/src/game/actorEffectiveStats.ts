import type { GameActorVitals } from "./protocol.js";

export type ActorTraitKey = "body" | "spirit";

export interface ActorTraits {
  body: number;
  spirit: number;
}

export interface EffectiveActorStats {
  traits: ActorTraits;
  maxVitals: GameActorVitals;
  spawnVitals: GameActorVitals;
  regenRatesPerSecond: GameActorVitals;
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

const baseCapacityFloor = 100;
const baseSuppressionThreshold = 24;
const defaultTraits: ActorTraits = { body: 75, spirit: 75 };

const roleTraits: Record<string, ActorTraits> = {
  player: { body: 100, spirit: 100 },
  agent_player: { body: 100, spirit: 100 },
  public_shopkeeper: { body: 92, spirit: 86 },
  scripted_player: { body: 88, spirit: 82 },
  creature: { body: 58, spirit: 42 },
  skirmisher: { body: 74, spirit: 68 },
  skirmisher_assault: { body: 80, spirit: 58 },
  skirmisher_anchor: { body: 86, spirit: 82 },
  skirmisher_flanker: { body: 72, spirit: 76 },
  skirmisher_deadeye: { body: 68, spirit: 92 },
  skirmisher_brawler: { body: 124, spirit: 62 },
};

export function actorTraitsForRole(role: string | undefined): ActorTraits {
  const traits = role ? roleTraits[role] : undefined;
  return cloneTraits(traits ?? defaultTraits);
}

export function deriveEffectiveActorStatsForRole(role: string | undefined): EffectiveActorStats {
  return {
    ...deriveEffectiveActorStats(actorTraitsForRole(role)),
    dodgeChance: isPlayerLikeRole(role) ? 0.1 : 0,
  };
}

export function deriveEffectiveActorStats(traits: ActorTraits): EffectiveActorStats {
  const normalized = normalizeTraits(traits);
  const maxVitals = deriveMaxVitals(normalized);
  return {
    traits: normalized,
    spawnVitals: deriveSpawnVitals(normalized, maxVitals),
    maxVitals,
    regenRatesPerSecond: deriveRegenRates(normalized),
    movementSpeedMultiplier: roundStat(clamp(0.75 + bodySpiritBlend(normalized, 0.75) / 400, 0.55, 1)),
    aimStability: roundStat(clamp(0.5 + bodySpiritBlend(normalized, 0.35) / 200, 0.4, 8)),
    recoilRecoveryMultiplier: roundStat(clamp(0.6 + bodySpiritBlend(normalized, 0.7) / 250, 0.5, 8)),
    suppressionResistance: roundStat(clamp(normalized.spirit / 100, 0.25, 10_000)),
    suppressionThreshold: roundStat(Math.max(1, baseSuppressionThreshold * clamp(normalized.spirit / 100, 0.25, 10_000))),
    panicThreshold: roundStat(Math.max(1, baseSuppressionThreshold * clamp(normalized.spirit / 100, 0.25, 10_000))),
    panicDurationMultiplier: roundStat(clamp(1.35 - normalized.spirit / 250, 0.35, 1.25)),
    bleedTolerance: roundStat(clamp(0.55 + normalized.body / 220, 0.45, 10_000)),
    woundTolerance: roundStat(clamp(0.55 + normalized.body / 222, 0.45, 10_000)),
    dodgeChance: 0,
    cloneSicknessTolerance: roundStat(clamp(0.45 + (normalized.body + normalized.spirit) / 360, 0.45, 10_000)),
  };
}

function isPlayerLikeRole(role: string | undefined): boolean {
  return role === "player" || role === "agent_player";
}

function deriveMaxVitals(traits: ActorTraits): GameActorVitals {
  return {
    health: roundStat(Math.max(baseCapacityFloor, traits.body)),
    action: roundStat(Math.max(baseCapacityFloor, actionCapacity(traits))),
    spirit: roundStat(Math.max(baseCapacityFloor, traits.spirit)),
  };
}

function deriveSpawnVitals(traits: ActorTraits, maxVitals: GameActorVitals): GameActorVitals {
  return {
    health: clamp(roundStat(traits.body), 1, maxVitals.health),
    action: clamp(roundStat(actionCapacity(traits)), 1, maxVitals.action),
    spirit: clamp(roundStat(traits.spirit), 1, maxVitals.spirit),
  };
}

function deriveRegenRates(traits: ActorTraits): GameActorVitals {
  return {
    health: roundStat(clamp(0.3333 + traits.body * 0.0054167 + traits.spirit * 0.00125, 0.01, 10_000)),
    action: roundStat(clamp(0.45 + traits.body * 0.0195, 0.01, 10_000)),
    spirit: roundStat(clamp(0.15 + traits.body * 0.0055 + traits.spirit * 0.014, 0.01, 10_000)),
  };
}

function actionCapacity(traits: ActorTraits): number {
  return traits.body * 0.85 + traits.spirit * 0.15;
}

function bodySpiritBlend(traits: ActorTraits, bodyWeight: number): number {
  return traits.body * bodyWeight + traits.spirit * (1 - bodyWeight);
}

function normalizeTraits(traits: ActorTraits): ActorTraits {
  return {
    body: normalizeTrait(traits.body),
    spirit: normalizeTrait(traits.spirit),
  };
}

function normalizeTrait(value: number): number {
  return Number.isFinite(value) && value > 0 ? roundStat(value) : 1;
}

function cloneTraits(traits: ActorTraits): ActorTraits {
  return { body: traits.body, spirit: traits.spirit };
}

function roundStat(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
