import type { PlayState } from "./gameState";
import { isMeleeWeaponPresentation, type WeaponId } from "./weaponSystem";

const rangedFireAnimationMs = 120;
const meleeFireAnimationMs = 420;
const rangedReloadAnimationMs = 640;

export function triggerWeaponFireAnimation(
  state: Pick<PlayState, "weaponFireAnimations" | "worldTimeMs"> & Partial<Pick<PlayState, "actorWeaponIds">>,
  actorId: string,
  weaponId: WeaponId,
): void {
  state.weaponFireAnimations[actorId] = {
    weaponId,
    kind: "fire",
    startedAtMs: state.worldTimeMs,
    durationMs: isMeleeWeaponPresentation(weaponId) ? meleeFireAnimationMs : rangedFireAnimationMs,
  };
  if (state.actorWeaponIds) state.actorWeaponIds[actorId] = weaponId;
}

export function triggerWeaponReloadAnimation(
  state: Pick<PlayState, "weaponFireAnimations" | "worldTimeMs"> & Partial<Pick<PlayState, "actorWeaponIds">>,
  actorId: string,
  weaponId: WeaponId,
  durationMs = rangedReloadAnimationMs,
): void {
  state.weaponFireAnimations[actorId] = {
    weaponId,
    kind: "reload",
    startedAtMs: state.worldTimeMs,
    durationMs: Math.max(1, Math.round(durationMs)),
  };
  if (state.actorWeaponIds) state.actorWeaponIds[actorId] = weaponId;
}

export function expireWeaponFireAnimations(
  state: Pick<PlayState, "weaponFireAnimations" | "worldTimeMs">,
): void {
  for (const [actorId, animation] of Object.entries(state.weaponFireAnimations)) {
    if (state.worldTimeMs - animation.startedAtMs >= animation.durationMs) {
      delete state.weaponFireAnimations[actorId];
    }
  }
}
