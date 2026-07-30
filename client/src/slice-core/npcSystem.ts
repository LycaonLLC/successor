import type { ActorSnapshot, SliceSnapshot } from "./gameState";
import { isProfessionTrainerActor } from "./professionTrainerSystem";

export type ActorKind = "player" | "combat_npc" | "social_npc";

interface ActorRoleProfile {
  kind: ActorKind;
  designation: string | null;
  usesRifleRun?: boolean;
  usesSocialIdle?: boolean;
}

export type ActorDisplayNameContext = SliceSnapshot | string;
// Keep NPC semantics centralized here. Roles drive player/combat/social
// classification, classic sandbox-MMO nameplate text, and pose affordances; server
// snapshots remain the source of combat truth.

const actorRoleProfiles: Record<string, ActorRoleProfile> = {
  player: { kind: "player", designation: null },
  agent_player: { kind: "player", designation: null, usesRifleRun: true },
  creature: { kind: "combat_npc", designation: null },
  skirmisher: { kind: "combat_npc", designation: "skirmisher", usesRifleRun: true },
  skirmisher_assault: { kind: "combat_npc", designation: "skirmisher assault", usesRifleRun: true },
  skirmisher_anchor: { kind: "combat_npc", designation: "skirmisher anchor", usesRifleRun: true },
  skirmisher_flanker: { kind: "combat_npc", designation: "skirmisher flanker", usesRifleRun: true },
  skirmisher_deadeye: { kind: "combat_npc", designation: "skirmisher deadeye", usesRifleRun: true },
  skirmisher_brawler: { kind: "combat_npc", designation: "rogue brawler" },
  range_guard: { kind: "combat_npc", designation: "range guard", usesRifleRun: true },
  scripted_player: { kind: "social_npc", designation: null },
  public_shopkeeper: { kind: "social_npc", designation: "shopkeeper", usesSocialIdle: true },
  profession_trainer: { kind: "social_npc", designation: "profession trainer", usesSocialIdle: true },
};

export function actorKind(actor: Pick<ActorSnapshot, "role" | "id" | "sprite">): ActorKind {
  if (actor.role === "player" || actor.role === "agent_player") return "player";
  if (isProfessionTrainerActor(actor)) return "social_npc";
  return actorRoleProfiles[actor.role]?.kind ?? "social_npc";
}

export function isCombatNpc(actor: Pick<ActorSnapshot, "role" | "id" | "sprite">): boolean {
  return actorKind(actor) === "combat_npc";
}

export function isSocialNpc(actor: Pick<ActorSnapshot, "role" | "id" | "sprite">): boolean {
  return actorKind(actor) === "social_npc";
}

/** Gaia wildlife is the single farmable-creature identity. */
export function isFarmableCreatureIdentity(actor: Pick<ActorSnapshot, "role">): boolean {
  return actor.role === "creature";
}

/** Exact Gaia adult sprite registry (mirrors the sim's species table). */
const gaiaSpeciesBySprite: Record<string, string> = {
  "creature-bellback-adult": "bellback",
  "creature-pebblehorn-adult": "pebblehorn",
  "creature-snufflefin-adult": "snufflefin",
  "creature-pocketclod-adult": "pocketclod",
  "creature-mossmuff-adult": "mossmuff",
  "creature-dapplepod-adult": "dapplepod",
};

export function gaiaSpeciesForSprite(sprite: string | null | undefined): string | null {
  return (sprite && gaiaSpeciesBySprite[sprite]) || null;
}

export function usesRifleRunPose(actor: Pick<ActorSnapshot, "role" | "id" | "sprite">): boolean {
  return Boolean(actorRoleProfiles[actor.role]?.usesRifleRun);
}

export function usesSocialIdlePose(actor: Pick<ActorSnapshot, "role" | "id" | "sprite">): boolean {
  return Boolean(actorRoleProfiles[actor.role]?.usesSocialIdle);
}

export function actorDesignation(actor: Pick<ActorSnapshot, "role" | "id" | "sprite">): string | null {
  return actorRoleProfiles[actor.role]?.designation ?? null;
}

export function actorDisplayName(
  actor: Pick<ActorSnapshot, "id" | "label" | "role" | "sprite"> & Partial<Pick<ActorSnapshot, "areaId">>,
  _context?: ActorDisplayNameContext,
): string {
  // The CLEAN name only. The actor descriptor ("a rogue drifter") lives in the
  // server `descriptor` field and is rendered as the nameplate/examine SECONDARY
  // line (see actorSecondaryLine) — NEVER composed into the name here. Composing
  // it double-printed under the plate's own type line and drifted from the
  // authoritative descriptor (creatures still resolve to their species name).
  return actor.label;
}

/** Local fallback type line (no article prefix stripped) when no server
 *  descriptor is available (offline / pure-slice render). Mirrors the sim's
 *  derive_actor_descriptor register for the shapes a client can see. */
function localTypeLine(
  actor: Pick<ActorSnapshot, "id" | "role" | "sprite"> & Partial<Pick<ActorSnapshot, "areaId">>,
): string | null {
  if ((actor.role ?? "") === "creature") {
    const species = gaiaSpeciesForSprite(actor.sprite);
    return species ? `a ${species}` : "a creature";
  }
  const designation = actorDesignation(actor);
  return designation ? `${articleFor(designation)} ${designation}` : null;
}

/** Nameplate/examine SECONDARY line (parenthesized actor descriptor). Prefers the
 *  server-authoritative descriptor, then a player's profession title, then a
 *  local fallback designation. Returns null when there is no type read. */
export function actorSecondaryLine(
  serverDescriptor: string | null | undefined,
  activeTitleLabel: string | null | undefined,
  fallbackActor?: Pick<ActorSnapshot, "id" | "role" | "sprite"> & Partial<Pick<ActorSnapshot, "areaId">>,
): string | null {
  const descriptor = serverDescriptor?.trim();
  if (descriptor) return `(${descriptor})`;
  const title = activeTitleLabel?.trim();
  if (title) return `(${title})`;
  if (fallbackActor) {
    const local = localTypeLine(fallbackActor);
    if (local) return `(${local})`;
  }
  return null;
}

/** The server-authoritative primary nameplate name, or null when absent. */
export function serverAuthorityDisplayName(displayName: string | null | undefined): string | null {
  const name = displayName?.trim();
  if (!name) return null;
  return name;
}

export function actorNameplateText(
  actor: Pick<ActorSnapshot, "id" | "label" | "role" | "sprite" | "guildTag"> & Partial<Pick<ActorSnapshot, "areaId" | "playerOrganizationTag">>,
  context?: ActorDisplayNameContext,
): string {
  const name = actorDisplayName(actor, context);
  const tag = actor.guildTag ?? actor.playerOrganizationTag ?? null;
  return tag ? `${name} <${tag}>` : name;
}

export function actorCorpseNameplateText(
  actor: Pick<ActorSnapshot, "id" | "label" | "role" | "sprite" | "guildTag"> & Partial<Pick<ActorSnapshot, "areaId" | "playerOrganizationTag">>,
  context?: ActorDisplayNameContext,
): string {
  return `Corpse of ${actorNameplateText(actor, context)}`;
}

function articleFor(designation: string): "a" | "an" {
  const first = designation[0];
  if (first && /^[A-Z]/u.test(first)) {
    return "AEFHILMNORSX".includes(first) ? "an" : "a";
  }
  return /^[aeiou]/iu.test(designation) ? "an" : "a";
}
