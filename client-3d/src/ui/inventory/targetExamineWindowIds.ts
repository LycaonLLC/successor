import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";

/** Eager target-examine id + availability probe (frame loop; no preview GL). */
export const TARGET_EXAMINE_WINDOW_ID = "targetExamine";

/**
 * True while the current examine target still resolves the same way the
 * deferred examine pane does (server AOI actor or in-area local snapshot).
 * Full preview construction stays inside targetExamineWindow.ts.
 */
export function targetExamineActorAvailable(state: PlayState, slice: SliceSnapshot): boolean {
  const actorId = state.examineActorId;
  if (!actorId) return false;
  const localActor = slice.actors.find((actor) => actor.id === actorId) ?? null;
  const serverActor = state.serverAuthority.enabled ? state.serverAuthority.actors[actorId] ?? null : null;
  const serverAuthoritative = state.serverAuthority.connected
    || state.serverAuthority.receivedSnapshots > 0
    || state.serverAuthority.sourceMatchesClient === true;
  if (serverAuthoritative && !serverActor && !localActor) return false;
  if (serverActor) return true;
  if (!localActor) return false;
  if (localActor.id !== slice.camera.followActor && localActor.areaId !== state.activeAreaId) return false;
  return true;
}
