import type { LaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import type { SliceSnapshot } from "@successor/client/src/slice-core/gameState";

export function launchActorIdFromSearch(
  launchIdentity: LaunchIdentity,
  search: string,
): string {
  const params = new URLSearchParams(search);
  return params.get("actorId") ?? launchIdentity.characterId ?? launchIdentity.playerId;
}

export function characterStorageKeyFromLaunchIdentity(
  launchIdentity: LaunchIdentity,
  launchActorId: string,
): string {
  return launchIdentity.characterId ?? launchIdentity.playerId ?? launchActorId;
}

export function initialCameraFocus(
  search: string,
  fallback: { x: number; y: number },
  authoritativePlayer: { x: number; y: number } | null,
): { x: number; z: number } {
  if (authoritativePlayer) {
    return { x: authoritativePlayer.x, z: authoritativePlayer.y };
  }
  const params = new URLSearchParams(search);
  const requestedX = Number(params.get("spawnX") ?? fallback.x);
  const requestedZ = Number(params.get("spawnY") ?? fallback.y);
  return {
    x: Number.isFinite(requestedX) ? requestedX : fallback.x,
    z: Number.isFinite(requestedZ) ? requestedZ : fallback.y,
  };
}

export function applyLaunchIdentity(
  slice: SliceSnapshot,
  launchIdentity: LaunchIdentity,
  launchActorId: string,
): SliceSnapshot {
  const actorExists = slice.actors.some((actor) => actor.id === launchActorId);
  const identityActorId = actorExists ? launchActorId : slice.camera.followActor;
  // Persistent characters do not exist in the authored slice. Re-key its
  // camera pawn instead of leaving the local presentation on the durable
  // `player` placeholder, which may belong to another link-dead character.
  const rekeyIdentityActor = !actorExists
    && slice.actors.some((actor) => actor.id === identityActorId);
  const followActor = rekeyIdentityActor ? launchActorId : identityActorId;
  const selectedVariantId = launchIdentity.selectedVariantId;
  return {
    ...slice,
    camera: {
      ...slice.camera,
      followActor,
    },
    actors: slice.actors.map((actor) => (
      actor.id === identityActorId
        ? {
            ...actor,
            id: followActor,
            label: launchIdentity.displayName,
            guildTag: launchIdentity.guildTag ?? actor.guildTag ?? actor.playerOrganizationTag ?? null,
            sprite: isAdventurerPremiumVariantId(actor.sprite) && !isAdventurerPremiumVariantId(selectedVariantId)
              ? actor.sprite
              : selectedVariantId ?? actor.sprite,
          }
        : actor
    )),
  };
}

function isAdventurerPremiumVariantId(value: string | null | undefined): boolean {
  return value?.startsWith("adventurer-premium-") ?? false;
}
