import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { setSelectedTarget } from "@successor/client/src/slice-core/targetSelectionSystem";
import { setExplicitLockTarget } from "../combat/softLock";

/**
 * Shared ground-movement grammar for every surface that can issue a travel
 * order — world ground clicks (boot/input), radar taps (ui/hud/radar) and
 * datapad survey routes (ui/windows/defs/datapadMap).
 *
 * Two rules, one source of truth:
 *   · movement is for the living — downed/dead players keep their pointer
 *     but the order is ignored;
 *   · issuing a ground/waypoint move drops the current engagement focus
 *     (selected target, soft/explicit lock, examine pane) exactly the way a
 *     world ground click always has.
 */

/** Same gate as the world ground click: only the living issue moves. */
export function canIssueGroundMove(state: PlayState): boolean {
  return state.death.phase === "alive";
}

/** Drop selected target, soft/explicit lock and examine focus before a move. */
export function clearEngagementFocusForGroundMove(state: PlayState): void {
  setSelectedTarget(state, null, true);
  state.examineActorId = null;
  setExplicitLockTarget(null);
}
