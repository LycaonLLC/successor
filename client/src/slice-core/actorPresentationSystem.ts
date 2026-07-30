import { actorNameplateColor } from "./actorRelationSystem";
import type { ActorSnapshot, PlayState, SliceSnapshot } from "./gameState";
import type { Cell } from "./geometry";
import { isCombatNpc, isSocialNpc } from "./npcSystem";
import { actorWorldPosition, isObserverCameraGhostActor } from "./targetingSystem";

/**
 * Renderer-neutral actor projection used by the current 3D overlay.
 *
 * This module is limited to actor selection, nameplate policy, and overlay
 * text so the 3D client does not depend on a world renderer implementation.
 */
export interface ActorDrawEntry {
  actor: ActorSnapshot;
  pos: Cell;
}

export interface ActorVisibilityBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const denseActorNameplateThreshold = 24;
const denseNameplateBudget = 18;
const importantNameplateRadiusCells = 10;
const defaultNameplateMaxWidthPx = 240;
const corpseNameplateMaxWidthPx = 430;
const neutralAttackableNameplateColor = "#f4d35e";
const corpseNameplateColor = "#f8f7f1";

export function actorDrawEntries(
  slice: SliceSnapshot,
  state: PlayState,
  time: number,
  bounds: ActorVisibilityBounds | null = null,
): ActorDrawEntry[] {
  const authorityActors = state.serverAuthority?.actors;
  const serverAuthorityRenderable = Boolean(
    state.serverAuthority?.enabled
      && state.serverAuthority.sourceMatchesClient !== false
      && authorityActors,
  );

  return [...slice.actors, ...dynamicServerActors(slice, state)]
    .filter((actor) => {
      if (isObserverCameraGhostActor(actor, slice, state)) return false;
      if (actor.id === slice.camera.followActor) return true;
      const serverActor = serverAuthorityRenderable ? authorityActors?.[actor.id] : null;
      if (serverAuthorityRenderable) {
        return Boolean(serverActor && serverActor.lifeState !== "respawning" && serverActor.areaId === state.activeAreaId);
      }
      return actor.areaId === state.activeAreaId;
    })
    .map((actor) => ({
      actor,
      pos: actorWorldPosition(actor, slice, state, time),
    }))
    .filter((entry) => !bounds || (
      entry.pos.x >= bounds.minX
      && entry.pos.x <= bounds.maxX
      && entry.pos.y >= bounds.minY
      && entry.pos.y <= bounds.maxY
    ))
    .sort((left, right) => left.pos.y - right.pos.y);
}

function dynamicServerActors(slice: SliceSnapshot, state: PlayState): ActorSnapshot[] {
  if (!state.serverAuthority?.enabled || state.serverAuthority.sourceMatchesClient === false || !state.serverAuthority.connected) {
    return [];
  }

  const authoredActorIds = new Set(slice.actors.map((actor) => actor.id));
  const playerActorId = state.serverAuthority.playerActorId;
  return Object.entries(state.serverAuthority.actors)
    .filter(([actorId, actor]) => (
      actorId !== playerActorId
      && !authoredActorIds.has(actorId)
      && actor.lifeState !== "respawning"
      && actor.areaId === state.activeAreaId
    ))
    .map(([actorId, actor]) => ({
      id: actorId,
      entity: `server:${actorId}`,
      areaId: actor.areaId,
      label: actor.label,
      guildTag: actor.playerOrganizationTag ?? null,
      role: actor.role ?? "remote_actor",
      sprite: actor.sprite ?? "adventurer-premium-male",
      factionId: actor.factionId ?? null,
      socialGroup: actor.socialGroup ?? null,
      pvpStatus: actor.pvpStatus ?? null,
      aiAttitude: actor.aiAttitude,
      playerOrganizationId: actor.playerOrganizationId ?? null,
      playerOrganizationTag: actor.playerOrganizationTag ?? null,
      professionIds: actor.professions?.map((profession) => profession.id) ?? [],
      poseSet: "idle",
      direction: actor.direction,
      cell: { x: actor.x, y: actor.y },
      route: [],
    }));
}

export function actorNameplateFillStyle(
  actor: ActorSnapshot,
  dead: boolean,
  slice?: SliceSnapshot,
  state?: PlayState,
): string | undefined {
  if (dead) return corpseNameplateColor;
  if (slice && state) return actorNameplateColor(actor, slice, state);
  if (isCombatNpc(actor)) return neutralAttackableNameplateColor;
  if (isSocialNpc(actor)) return corpseNameplateColor;
  return undefined;
}

export function actorNameplateMaxWidth(dead: boolean): number {
  return dead ? corpseNameplateMaxWidthPx : defaultNameplateMaxWidthPx;
}

export function selectActorNameplateIds(
  entries: ActorDrawEntry[],
  state: PlayState,
  playerActorId: string,
): Set<string> {
  if (entries.length <= denseActorNameplateThreshold) {
    return new Set(entries.map((entry) => entry.actor.id));
  }

  const required = new Set<string>();
  const candidates: Array<{ id: string; score: number }> = [];
  for (const entry of entries) {
    const combat = state.actors[entry.actor.id] ?? null;
    const distance = Math.hypot(entry.pos.x - state.player.x, entry.pos.y - state.player.y);
    if (
      entry.actor.id === playerActorId
      || entry.actor.id === state.selectedActorId
      || entry.actor.id === state.examineActorId
      || Boolean((combat?.hitFlashMs ?? 0) > 0 || combat?.downed)
    ) {
      required.add(entry.actor.id);
      continue;
    }
    if (distance > importantNameplateRadiusCells) continue;
    const hunterScore = isCombatNpc(entry.actor) ? 650 : 0;
    const combatScore = (combat?.hitFlashMs ?? 0) > 0 || combat?.downed ? 700 : 0;
    candidates.push({
      id: entry.actor.id,
      score: hunterScore + combatScore + Math.max(0, importantNameplateRadiusCells - distance) * 100,
    });
  }

  candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  for (const candidate of candidates) {
    if (required.size >= denseNameplateBudget) break;
    required.add(candidate.id);
  }
  return required;
}
