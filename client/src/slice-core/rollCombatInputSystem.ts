import {
  authorityIssuedAtServerTick,
  enqueueAuthorityCancelAbilityQueueCommand,
  enqueueAuthorityQueueCombatActionCommand,
} from "./authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "./gameState";

function authorityInputBlockReason(state: PlayState): string | null {
  const authority = state.serverAuthority;
  if (!authority?.enabled) return null;
  if (authority.sourceMatchesClient === false) return "server authority source mismatch";
  if (!authority.connected || authority.status !== "connected") {
    return authority.status === "connecting" ? "server authority connecting" : "server authority disconnected";
  }
  return null;
}

/** Arm the server-owned repeat attack for the current soft-lock target. */
export function queueRollAttack(state: PlayState, slice: SliceSnapshot): void {
  if (authorityInputBlockReason(state) !== null) return;
  const targetId = state.softLockActorId;
  if (!targetId) {
    cancelRollAttackRepeat(state, slice);
    return;
  }
  if (state.rollRepeatTargetId === targetId) return;
  state.rollRepeatTargetId = targetId;
  enqueueAuthorityQueueCombatActionCommand(
    state.authorityCommands,
    "basic_shot",
    targetId,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
  );
}

/** Cancel only the held combat repeat; other queued actions stay intact. */
export function cancelRollAttackRepeat(state: PlayState, slice: SliceSnapshot): void {
  if (state.rollRepeatTargetId === null) return;
  state.rollRepeatTargetId = null;
  if (authorityInputBlockReason(state) !== null) return;
  enqueueAuthorityCancelAbilityQueueCommand(
    state.authorityCommands,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    { scope: "owner_repeat" },
  );
}
