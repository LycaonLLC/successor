import type { ActorSnapshot, PlayState, ServerAuthorityActorState, SliceSnapshot } from "./gameState";
import { isFarmableCreatureIdentity, isSocialNpc } from "./npcSystem";

export type ActorRelationToPlayer =
  | "same_player_organization"
  | "hostile"
  | "farmable_passive"
  | "friendly_player_like"
  | "social"
  | "neutral";

export const actorRelationColors = {
  samePlayerOrganization: "#b066ff",
  hostile: "#d33b32",
  farmablePassive: "#f1d06b",
  friendlyPlayerLike: "#4aa9ff",
  social: "#f8f7f1",
  neutral: "#d7d9d4",
} as const;

export type ActorRelationSubject = Pick<ActorSnapshot, "id"> & {
  label?: string | null;
  role?: string | null;
  sprite?: string | null;
  factionId?: string | null;
  aiAttitude?: ActorSnapshot["aiAttitude"] | null;
  /** Server-derived: does this actor auto-aggro (red) vs provoked-only (yellow). */
  willAutoAggro?: boolean | null;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
};

interface ResolvedActorRelationSubject {
  id: string;
  label: string;
  role: string;
  sprite: string;
  factionId: string | null;
  aiAttitude: ActorSnapshot["aiAttitude"] | null;
  willAutoAggro: boolean;
  playerOrganizationId: string | null;
  playerOrganizationTag: string | null;
}

export function actorRelationToPlayer(
  actor: ActorRelationSubject,
  slice: SliceSnapshot,
  state: PlayState,
): ActorRelationToPlayer {
  return relationForResolved(resolveRelationSubject(actor, slice, state), slice, state);
}

function relationForResolved(
  resolved: ResolvedActorRelationSubject,
  slice: SliceSnapshot,
  state: PlayState,
): ActorRelationToPlayer {
  if (resolved.aiAttitude === "hostile") return "hostile";

  const player = resolvePlayerRelationSubject(slice, state);
  const playerOrgId = normalizeRelationKey(player?.playerOrganizationId ?? null);
  const actorOrgId = normalizeRelationKey(resolved.playerOrganizationId);
  if (playerOrgId && actorOrgId) {
    if (playerOrgId === actorOrgId) return "same_player_organization";
    if (organizationsAreMutualEnemies(slice, playerOrgId, actorOrgId)) return "hostile";
  }

  // DEF-10 (2026-07-09): social identity outranks faction hostility — a
  // faction-carrying trainer/vendor/shopkeeper is a civilian, not a target
  // (`/target nearest hostile` was selecting trainers once they grew
  // factions). Safe above DEF-4: every rogue role is combat_npc in
  // npcSystem's role map, so no skirmisher can take this exit. An
  // attitude-hostile social (first clause) still reads hostile — the server
  // said it is fighting.
  if (isSocialNpc(resolved)) return "social";

  // DEF-4 (2026-07-08): faction hostility outranks aggro state — an idle or
  // merely-alerted rogue trooper is STILL a hostile (the TUI /target
  // selector and both minimaps ride this relation). The attitude clauses in
  // isFarmablePassiveNpc exist for passive wildlife: a creature reads farmable
  // while passive/alerted and goes hostile only when it retaliates. Before
  // this fix the farmable check ran first and swallowed
  // every passive/alerted FACTION enemy as farmable_passive.
  if (isHostileByFaction(resolved, player, slice)) return "hostile";
  if (isFarmablePassiveNpc(resolved)) return "farmable_passive";

  if (isPlayerLikeRole(resolved.role)) return "friendly_player_like";
  return "neutral";
}

export function actorMinimapColor(
  actor: ActorRelationSubject,
  slice: SliceSnapshot,
  state: PlayState,
): string {
  const resolved = resolveRelationSubject(actor, slice, state);
  return threatColorForRelation(relationForResolved(resolved, slice, state), resolved.willAutoAggro);
}

export function actorNameplateColor(
  actor: ActorRelationSubject,
  slice: SliceSnapshot,
  state: PlayState,
): string | undefined {
  const resolved = resolveRelationSubject(actor, slice, state);
  const relation = relationForResolved(resolved, slice, state);
  if (relation === "neutral") return undefined;
  return threatColorForRelation(relation, resolved.willAutoAggro);
}

// Threat legibility (owner ruling 2026-07-08): the nameplate + minimap dot
// split the DEF-4/DEF-10 "hostile" relation into RED (auto-aggro classes — will
// attack on sight) vs YELLOW (provoked-only — won't aggro unless attacked),
// keyed to the server-derived willAutoAggro. This is a COLOR read layered ON the
// relation; the relation itself (targeting, /target, selectors) is UNCHANGED.
// Provoked-only hostiles share the passive/attackable yellow with farmable wildlife;
// social/friendly/neutral/org are untouched. SEAM: faction-reputation thresholds
// will later feed willAutoAggro per observer.
function threatColorForRelation(relation: ActorRelationToPlayer, willAutoAggro: boolean): string {
  if (relation === "hostile" && !willAutoAggro) return actorRelationColors.farmablePassive;
  return colorForRelation(relation);
}

function colorForRelation(relation: ActorRelationToPlayer): string {
  switch (relation) {
    case "same_player_organization":
      return actorRelationColors.samePlayerOrganization;
    case "hostile":
      return actorRelationColors.hostile;
    case "farmable_passive":
      return actorRelationColors.farmablePassive;
    case "friendly_player_like":
      return actorRelationColors.friendlyPlayerLike;
    case "social":
      return actorRelationColors.social;
    case "neutral":
      return actorRelationColors.neutral;
  }
}

function resolveRelationSubject(
  actor: ActorRelationSubject,
  slice: SliceSnapshot,
  state: PlayState,
): ResolvedActorRelationSubject {
  const serverActor = state.serverAuthority?.actors?.[actor.id] ?? null;
  const localActor = slice.actors.find((candidate) => candidate.id === actor.id) ?? null;
  return relationSubjectFromSources(actor, serverActor, localActor);
}

function resolvePlayerRelationSubject(slice: SliceSnapshot, state: PlayState): ResolvedActorRelationSubject | null {
  const playerActorId = state.serverAuthority?.playerActorId ?? state.playerActorId ?? slice.camera.followActor;
  if (!playerActorId) return null;
  const serverActor = state.serverAuthority?.actors?.[playerActorId] ?? null;
  const localActor = slice.actors.find((candidate) => candidate.id === playerActorId) ?? null;
  if (!serverActor && !localActor) return null;
  return relationSubjectFromSources({ id: playerActorId }, serverActor, localActor);
}

function relationSubjectFromSources(
  actor: ActorRelationSubject,
  serverActor: ServerAuthorityActorState | null,
  localActor: ActorSnapshot | null,
): ResolvedActorRelationSubject {
  return {
    id: actor.id,
    label: normalizeDisplayString(actor.label ?? serverActor?.label ?? localActor?.label, actor.id),
    role: normalizeDisplayString(actor.role ?? serverActor?.role ?? localActor?.role, "remote_actor"),
    sprite: normalizeDisplayString(actor.sprite ?? serverActor?.sprite ?? localActor?.sprite, "adventurer-premium-male"),
    factionId: normalizeNullableString(actor.factionId ?? serverActor?.factionId ?? localActor?.factionId ?? null),
    aiAttitude: normalizeAiAttitude(actor.aiAttitude ?? serverActor?.aiAttitude ?? localActor?.aiAttitude ?? null),
    willAutoAggro: (actor.willAutoAggro ?? serverActor?.willAutoAggro) === true,
    playerOrganizationId: normalizeNullableString(actor.playerOrganizationId ?? serverActor?.playerOrganizationId ?? localActor?.playerOrganizationId ?? null),
    playerOrganizationTag: normalizeNullableString(actor.playerOrganizationTag ?? serverActor?.playerOrganizationTag ?? localActor?.playerOrganizationTag ?? null),
  };
}

function isFarmablePassiveNpc(actor: ResolvedActorRelationSubject): boolean {
  return actor.aiAttitude === "passive"
    || actor.aiAttitude === "alerted"
    || isFarmableCreatureIdentity(actor);
}

function isHostileByFaction(
  actor: ResolvedActorRelationSubject,
  player: ResolvedActorRelationSubject | null,
  slice: SliceSnapshot,
): boolean {
  const actorFactionId = normalizeRelationKey(actor.factionId);
  if (!actorFactionId) return false;
  if (actorFactionId === "rogue_troopers") return true;
  const playerFactionId = normalizeRelationKey(player?.factionId ?? null);
  if (!playerFactionId || playerFactionId === actorFactionId) return false;
  const factions = slice.factions ?? [];
  const actorFaction = factions.find((faction) => normalizeRelationKey(faction.id) === actorFactionId);
  const playerFaction = factions.find((faction) => normalizeRelationKey(faction.id) === playerFactionId);
  return relationListContains(actorFaction?.enemies, playerFactionId)
    || relationListContains(playerFaction?.enemies, actorFactionId);
}

function organizationsAreMutualEnemies(slice: SliceSnapshot, leftId: string, rightId: string): boolean {
  const organizations = slice.playerOrganizations ?? [];
  const left = organizations.find((organization) => normalizeRelationKey(organization.id) === leftId);
  const right = organizations.find((organization) => normalizeRelationKey(organization.id) === rightId);
  if (!left || !right) return false;
  return relationListContains(left.enemyOrganizationIds, rightId)
    && relationListContains(right.enemyOrganizationIds, leftId);
}

function relationListContains(values: string[] | undefined, expected: string): boolean {
  return (values ?? []).some((value) => normalizeRelationKey(value) === expected);
}

function isPlayerLikeRole(role: string): boolean {
  return role === "player" || role === "agent_player" || role === "scripted_player";
}

function normalizeDisplayString(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeAiAttitude(value: string | null | undefined): ActorSnapshot["aiAttitude"] | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "passive" || normalized === "alerted" || normalized === "hostile" ? normalized : null;
}

function normalizeRelationKey(value: string | null | undefined): string | null {
  const normalized = normalizeNullableString(value)?.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized ? normalized : null;
}
