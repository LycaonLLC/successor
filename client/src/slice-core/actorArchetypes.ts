import type { ActorVitals, BodyZone } from "./combatTypes";
import type { ActorBodyZoneState } from "./combatReducer";
import {
  actorTraitKeys,
  cloneActorTraits,
  cloneEffectiveActorStats,
  deriveEffectiveActorStats,
  type ActorTraits,
  type EffectiveActorStats,
} from "./actorEffectiveStats";
import actorArchetypePayload from "./specs/actor-archetypes.v1.json";

type ArmorKey = "head" | "torso" | "arms" | "legs";

interface ActorArchetypeSpec {
  schema: "successor.actor-archetypes.v1";
  bodyZones: Record<BodyZone, { hp: number; armorKey?: ArmorKey }>;
  defaults: ActorArchetypeRoleSpec;
  roles: Record<string, Partial<ActorArchetypeRoleSpec>>;
}

interface ActorArchetypeRoleSpec {
  traits: ActorTraits;
  armor: Record<ArmorKey, number>;
}

interface ResolvedActorArchetypeRole {
  traits: ActorTraits;
  stats: EffectiveActorStats;
  armor: Record<ArmorKey, number>;
}

export interface ActorArchetypeRef {
  role: string;
}

const actorArchetypes = parseActorArchetypes(actorArchetypePayload);

export const actorArchetypeSchema = actorArchetypes.schema;
export const actorArchetypeRoleIds = Object.keys(actorArchetypes.roles).sort();

export function baseActorTraits(actor: ActorArchetypeRef): ActorTraits {
  return cloneActorTraits(resolveRole(actor.role).traits);
}

export function baseActorEffectiveStats(actor: ActorArchetypeRef): EffectiveActorStats {
  return cloneEffectiveActorStats(resolveRole(actor.role).stats);
}

export function baseActorVitals(actor: ActorArchetypeRef): ActorVitals {
  return cloneVitals(resolveRole(actor.role).stats.spawnVitals);
}

export function baseActorMaxVitals(actor: ActorArchetypeRef): ActorVitals {
  return cloneVitals(resolveRole(actor.role).stats.maxVitals);
}

export function baseActorRegenRates(actor: ActorArchetypeRef): ActorVitals {
  return cloneVitals(resolveRole(actor.role).stats.regenRatesPerSecond);
}

export function createBodyZones(actor: ActorArchetypeRef): Record<BodyZone, ActorBodyZoneState> {
  const role = resolveRole(actor.role);
  const zones: Partial<Record<BodyZone, ActorBodyZoneState>> = {};
  for (const zone of ["head", "torso", "left_arm", "right_arm", "legs"] as const) {
    const zoneSpec = actorArchetypes.bodyZones[zone];
    const armorKey = zoneSpec.armorKey ?? defaultArmorKeyForZone(zone);
    zones[zone] = {
      zone,
      hp: zoneSpec.hp,
      maxHp: zoneSpec.hp,
      armor: role.armor[armorKey],
      woundTolerance: role.stats.woundTolerance,
    };
  }
  return zones as Record<BodyZone, ActorBodyZoneState>;
}

function defaultArmorKeyForZone(zone: BodyZone): ArmorKey {
  return zone === "left_arm" || zone === "right_arm" ? "arms" : zone;
}

function resolveRole(role: string): ResolvedActorArchetypeRole {
  const override = actorArchetypes.roles[role] ?? {};
  const traits = cloneActorTraits(override.traits ?? actorArchetypes.defaults.traits);
  const stats = deriveEffectiveActorStats({ traits });
  applyRoleEffectiveStatOverrides(role, stats);
  return {
    traits,
    stats,
    armor: {
      ...actorArchetypes.defaults.armor,
      ...(override.armor ?? {}),
    },
  };
}

function applyRoleEffectiveStatOverrides(role: string, stats: EffectiveActorStats) {
  if (role === "agent_player") {
    stats.movementSpeedMultiplier = Math.max(stats.movementSpeedMultiplier, 1);
  } else if (role === "skirmisher") {
    stats.movementSpeedMultiplier = Math.min(stats.movementSpeedMultiplier, 0.9);
  }
}

function parseActorArchetypes(payload: unknown): ActorArchetypeSpec {
  const parsed = payload as Partial<ActorArchetypeSpec>;
  if (parsed.schema !== "successor.actor-archetypes.v1") {
    throw new Error("actor archetype schema mismatch");
  }
  if (!parsed.bodyZones || !parsed.defaults || !parsed.roles) {
    throw new Error("actor archetype spec missing section");
  }
  for (const zone of ["head", "torso", "left_arm", "right_arm", "legs"] as const) {
    const zoneSpec = parsed.bodyZones[zone];
    if (!zoneSpec) throw new Error(`actor archetype missing body zone ${zone}`);
    assertPositive(zoneSpec.hp, `bodyZones.${zone}.hp`);
    if (zoneSpec.armorKey && !["head", "torso", "arms", "legs"].includes(zoneSpec.armorKey)) {
      throw new Error(`bodyZones.${zone}.armorKey invalid`);
    }
  }
  assertRoleSpec(parsed.defaults, "defaults", true);
  for (const [role, spec] of Object.entries(parsed.roles)) {
    assertRoleSpec(spec, `roles.${role}`, false);
  }
  return parsed as ActorArchetypeSpec;
}

function assertRoleSpec(spec: Partial<ActorArchetypeRoleSpec>, label: string, required: boolean) {
  if (required || spec.traits) assertTraits(spec.traits, `${label}.traits`);
  if (required || spec.armor) {
    if (!spec.armor) throw new Error(`${label}.armor missing`);
    for (const key of ["head", "torso", "arms", "legs"] as const) {
      assertNonNegative(spec.armor[key], `${label}.armor.${key}`);
    }
  }
}

function assertTraits(value: unknown, label: string): asserts value is ActorTraits {
  const traits = value as Partial<ActorTraits> | null | undefined;
  if (!traits) throw new Error(`${label} missing`);
  for (const key of actorTraitKeys) {
    assertPositive(traits[key], `${label}.${key}`);
  }
}

function assertPositive(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function assertNonNegative(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
}

function cloneVitals(value: ActorVitals): ActorVitals {
  return { health: value.health, action: value.action, spirit: value.spirit };
}
