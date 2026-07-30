import type { ActorTraits } from "./actorEffectiveStats";
import type { CertificateId } from "./combatTypes";
import progressionSpecPayload from "./specs/progression.v1.json";

export type ProfessionId = "marksman" | "craftsman" | "medic" | "scout" | "brawler" | "bioengineer" | "commando";
export type AbilityId =
  | "ability_leg_shot"
  | "ability_quick_reload"
  | "ability_medic_prep"
  | "ability_entertainer_session"
  | "ability_healdamage"
  | "ability_stopbleeding";
export type EffectId = "medic-prep" | "entertainer-session" | "clone-sickness";
export type EffectKind = "buff" | "debuff";

export interface ProfessionProgress {
  id: ProfessionId;
  label: string;
  xp: number;
  rank: number;
}

export interface SkillNodeState {
  id: string;
  profession: ProfessionId;
  label: string;
  unlocked: boolean;
  grants: string[];
  /** Player-facing names for authority weapon equip gates satisfied by this box. */
  weaponCertifications?: string[];
  /** Player-facing names for authority crafting recipes unlocked by this box. */
  craftingSchematics?: string[];
  /** Player-facing authority actions/capabilities first made available by this box. */
  abilities?: string[];
  /** Exact Rust authority capability IDs behind the player-facing ability names. */
  authorityCapabilities?: string[];
  row?: number;
  column?: number;
  xpCost?: number;
  skillPointCost?: number;
  creditCost?: number;
  phase?: number;
  track?: string;
  title?: string;
  prerequisites?: string[];
  description?: string;
}

export interface ProgressionState {
  professions: Record<ProfessionId, ProfessionProgress>;
  skillNodes: SkillNodeState[];
  certificates: CertificateId[];
  abilities: AbilityId[];
}

export interface EffectDefinition {
  id: EffectId;
  label: string;
  kind: EffectKind;
  sourceProfession: ProfessionId;
  durationMs: number;
  traitDelta: Partial<ActorTraits>;
  description: string;
}

export interface ActiveEffect {
  id: number;
  definitionId: EffectId;
  label: string;
  kind: EffectKind;
  sourceProfession: ProfessionId;
  appliedAtMs: number;
  expiresAtMs: number;
  traitDelta: Partial<ActorTraits>;
}

interface ProgressionSpecPayload {
  schema: "successor.progression-specs.v1";
  professionRankXp: number;
  sessionBuffDurationMs: number;
  professions: Record<ProfessionId, string>;
  skillNodes: SkillNodeState[];
  effects: Record<EffectId, EffectDefinition>;
}

const progressionSpecs = parseProgressionSpecs(progressionSpecPayload);

export const professionRankXp = progressionSpecs.professionRankXp;
export const professionDefinitions = progressionSpecs.professions;
export const skillNodeDefinitions = progressionSpecs.skillNodes;
export const effectDefinitions = progressionSpecs.effects;

function parseProgressionSpecs(payload: unknown): ProgressionSpecPayload {
  const parsed = payload as Partial<ProgressionSpecPayload>;
  if (parsed.schema !== "successor.progression-specs.v1") {
    throw new Error("progression spec schema mismatch");
  }
  if (typeof parsed.professionRankXp !== "number" || !Number.isFinite(parsed.professionRankXp) || parsed.professionRankXp <= 0) {
    throw new Error("progression spec professionRankXp must be positive");
  }
  if (typeof parsed.sessionBuffDurationMs !== "number" || !Number.isFinite(parsed.sessionBuffDurationMs) || parsed.sessionBuffDurationMs <= 0) {
    throw new Error("progression spec sessionBuffDurationMs must be positive");
  }
  const professionRankXp = parsed.professionRankXp;
  const sessionBuffDurationMs = parsed.sessionBuffDurationMs;
  const professions = parsed.professions;
  if (!professions) throw new Error("progression spec missing professions");
  for (const profession of ["marksman", "craftsman", "medic", "scout", "brawler"] as const) {
    if (!professions[profession]) throw new Error(`progression spec missing profession: ${profession}`);
  }
  const skillNodes = parsed.skillNodes ?? [];
  if (!Array.isArray(skillNodes) || skillNodes.length === 0) throw new Error("progression spec missing skill nodes");
  for (const node of skillNodes) {
    if (
      !node.id
      || !professions[node.profession]
      || !validStringList(node.grants)
      || !validOptionalStringList(node.weaponCertifications)
      || !validOptionalStringList(node.craftingSchematics)
      || !validOptionalStringList(node.abilities)
      || !validOptionalStringList(node.authorityCapabilities)
    ) {
      throw new Error(`progression spec invalid skill node: ${node.id ?? "unknown"}`);
    }
  }
  const effects = parsed.effects;
  if (!effects) throw new Error("progression spec missing effects");
  for (const effectId of ["medic-prep", "entertainer-session", "clone-sickness"] as const) {
    const effect = effects[effectId];
    if (!effect || effect.id !== effectId) throw new Error(`progression spec missing effect: ${effectId}`);
    if (!professions[effect.sourceProfession] || !Number.isFinite(effect.durationMs) || effect.durationMs <= 0 || !validTraitDelta(effect.traitDelta)) {
      throw new Error(`progression spec invalid effect: ${effectId}`);
    }
  }
  return {
    schema: parsed.schema,
    professionRankXp,
    sessionBuffDurationMs,
    professions,
    skillNodes,
    effects,
  };
}

function validStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function validOptionalStringList(value: unknown): value is string[] | undefined {
  return value === undefined || validStringList(value);
}

function validTraitDelta(value: unknown): value is Partial<ActorTraits> {
  const delta = value as Partial<ActorTraits> | null | undefined;
  if (!delta) return false;
  for (const key of ["body", "spirit"] as const) {
    const traitValue = delta[key];
    if (traitValue !== undefined && (typeof traitValue !== "number" || !Number.isFinite(traitValue))) return false;
  }
  return true;
}
