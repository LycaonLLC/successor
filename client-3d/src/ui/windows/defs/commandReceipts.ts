import type { AuthorityClientCommandKind } from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState } from "@successor/client/src/slice-core/gameState";

/**
 * Per-window watcher over `state.serverAuthority.lastReceipt` that surfaces
 * ONLY rejections belonging to this window's command kinds — a rejected fire
 * command must never flash as a skills/datapad denial. Kind resolution goes
 * through `sentCommandLog` (256-entry ring the authority client keeps for
 * every flushed envelope).
 */
export interface RejectWatcher {
  /** Non-null exactly once per NEW rejected receipt of a watched kind. */
  poll(): string | null;
}

export function createRejectWatcher(state: PlayState, kinds: readonly AuthorityClientCommandKind[]): RejectWatcher {
  let lastCommandId = state.serverAuthority.lastReceipt?.commandId ?? -1;
  return {
    poll(): string | null {
      const receipt = state.serverAuthority.lastReceipt;
      if (!receipt || receipt.commandId === lastCommandId) return null;
      lastCommandId = receipt.commandId;
      if (receipt.accepted) return null;
      const sent = state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === receipt.commandId);
      if (!sent || !kinds.includes(sent.kind)) return null;
      return `DENIED · ${(receipt.reasonCode ?? "unspecified").replaceAll("_", " ").toUpperCase()}`;
    },
  };
}
