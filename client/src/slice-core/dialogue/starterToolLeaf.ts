import {
  authorityIssuedAtServerTick,
  enqueueAuthorityRequestStarterToolCommand,
} from "../authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "../gameState";

/**
 * RequestStarterTool seam — the ONLY place the converse window touches the
 * starter-tool command.
 *
 * LIVE: wire payload `{ RequestStarterTool: { trainer_actor_id } }`; authority
 * grants whichever part of the starter bundle is missing — Field Multitool
 * (3001) and Mineral Survey Tool (3008) — across carried inventory plus an
 * exchange that is currently inside the actor's interaction footprint.
 * Rejects: trainer_unavailable, tool_already_held, starter_tool_cooldown,
 * actor_not_alive. Receipts remain the deny authority; the tree only phrases them.
 */

export const STARTER_TOOL_CONTRACT_LIVE = true;

/** Honest gate note should the contract ever regress to pending. */
export const STARTER_TOOL_PENDING_NOTE = "Requisition line pending";

export interface StarterToolEnqueueResult {
  /** Envelope command id when queued; null when nothing was sent. */
  commandId: number | null;
}

export function enqueueStarterToolRequest(state: PlayState, slice: SliceSnapshot, trainerActorId: string): StarterToolEnqueueResult {
  const queued = enqueueAuthorityRequestStarterToolCommand(
    state.authorityCommands,
    trainerActorId,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
  );
  return { commandId: queued?.command_id ?? null };
}
