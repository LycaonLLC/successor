import { baseActorMaxVitals, baseActorVitals } from "./actorArchetypes";
import type { CombatStatus } from "./combatReducer";
import type { ActorSnapshot, ActorTargetSummary, PlayState, SliceSnapshot } from "./gameState";
import { actorCorpseNameplateText, actorNameplateText, type ActorDisplayNameContext } from "./npcSystem";

export function selectedActor(slice: SliceSnapshot, state: PlayState): ActorSnapshot | null {
  if (!state.selectedActorId) return null;
  const localActor = slice.actors.find((actor) => actor.id === state.selectedActorId) ?? null;
  const serverActor = state.serverAuthority.enabled ? state.serverAuthority.actors[state.selectedActorId] : null;
  const serverSelectionAuthoritative = state.serverAuthority.connected
    || state.serverAuthority.receivedSnapshots > 0
    || state.serverAuthority.sourceMatchesClient === true;
  if (serverSelectionAuthoritative) {
    if (!serverActor) return null;
    return {
      id: state.selectedActorId,
      entity: localActor?.entity ?? `server:${state.selectedActorId}`,
      areaId: serverActor.areaId,
      label: serverActor.label,
      guildTag: serverActor.playerOrganizationTag ?? localActor?.guildTag ?? null,
      role: serverActor.role ?? localActor?.role ?? (state.selectedActorId === state.playerActorId ? "player" : "remote_actor"),
      sprite: localActor?.sprite ?? serverActor.sprite ?? serverOnlyActorFallbackSprite(),
      factionId: serverActor.factionId ?? localActor?.factionId ?? null,
      socialGroup: serverActor.socialGroup ?? localActor?.socialGroup ?? null,
      pvpStatus: serverActor.pvpStatus ?? localActor?.pvpStatus ?? null,
      playerOrganizationId: serverActor.playerOrganizationId ?? localActor?.playerOrganizationId ?? null,
      playerOrganizationTag: serverActor.playerOrganizationTag ?? localActor?.playerOrganizationTag ?? null,
      poseSet: localActor?.poseSet ?? "idle",
      direction: serverActor.direction,
      cell: { x: serverActor.x, y: serverActor.y },
      route: [],
    };
  }
  const inactiveLocalActor = slice.actors.find((actor) => (
    actor.id === state.selectedActorId &&
    (actor.id === slice.camera.followActor || actor.areaId === state.activeAreaId)
  ));
  return inactiveLocalActor ?? null;
}

export function serverOnlyActorFallbackSprite(): string {
  return "adventurer-premium-male";
}

export function actorNameplate(actor: ActorSnapshot, context?: ActorDisplayNameContext): string {
  return actorNameplateText(actor, context);
}

export function actorCorpseNameplate(actor: ActorSnapshot, context?: ActorDisplayNameContext): string {
  return actorCorpseNameplateText(actor, context);
}

export function actorTargetSummary(actor: ActorSnapshot, state: PlayState, slice?: SliceSnapshot): ActorTargetSummary {
  const combat = state.actors[actor.id];
  const serverActor = state.serverAuthority.enabled ? state.serverAuthority.actors[actor.id] : null;
  const serverStatuses = serverActor ? serverActor.statuses
    .map((status): CombatStatus => ({
      id: status.id as CombatStatus["id"],
      label: status.label,
      severity: status.severity,
      ttlMs: status.remainingMs,
      stacks: status.stacks,
      threshold: status.threshold,
    }))
    .filter((status) => (
      serverActor.lifeState !== "alive"
      || (status.id !== "dead" && status.id !== "downed" && status.id !== "evacuating")
    )) : [];
  const statuses = serverActor ? serverStatuses : combat?.statuses ?? [];
  const dead = statuses.some((status) => status.id === "dead");
  return {
    id: actor.id,
    name: dead ? actorCorpseNameplate(actor, slice) : actorNameplate(actor, slice),
    self: actor.id === state.playerActorId,
    role: actor.role.replaceAll("_", " "),
    entity: actor.entity,
    guildTag: actor.guildTag ?? actor.playerOrganizationTag ?? null,
    vitals: serverActor?.vitals ?? combat?.vitals ?? actor.vitals ?? baseActorVitals(actor),
    maxVitals: serverActor?.maxVitals ?? combat?.maxVitals ?? actor.maxVitals ?? baseActorMaxVitals(actor),
    lifeState: serverActor?.lifeState ?? combat?.lifeState ?? "alive",
    statuses,
  };
}
