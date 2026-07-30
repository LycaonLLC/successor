import {
  authorityIssuedAtServerTick,
  enqueueAuthorityCraftAssembleCommand,
  enqueueAuthorityCraftAssignSlotCommand,
  enqueueAuthorityCraftBeginCommand,
  enqueueAuthorityCraftCancelCommand,
  enqueueAuthorityCraftClearSlotCommand,
  enqueueAuthorityCraftDraftSchematicCommand,
  enqueueAuthorityCraftExperimentCommand,
  enqueueAuthorityCraftFinalizePracticeCommand,
  enqueueAuthorityCraftFinalizePrototypeCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";

/**
 * CRAFT command port — the window's only way to speak to the authority.
 *
 * The composition root (successor3dApp) builds the live port; every method
 * returns whether the command was QUEUED (house enqueue contract —
 * acceptance arrives later as a receipt). `createUnboundCraftCommandPort`
 * is the pre-registration stand-in: every call refuses, so the window's
 * deny path stays honest instead of pretending a dead link queued work.
 */
export interface CraftCommandPort {
  begin(recipeId: string): boolean;
  assignSlot(slotIndex: number, container: string, stackId: string, variantId: number): boolean;
  clearSlot(slotIndex: number): boolean;
  assemble(): boolean;
  experiment(lineId: number, points: number): boolean;
  /** Empty customName keeps the canonical recipe name (server fallback). */
  finalizePrototype(customName: string): boolean;
  /** Training pass — +5% base XP, materials spent, no item (§A owner canon). */
  finalizePractice(): boolean;
  draftSchematic(maxUses: number): boolean;
  cancel(): boolean;
}

export function createUnboundCraftCommandPort(): CraftCommandPort {
  return {
    begin: () => false,
    assignSlot: () => false,
    clearSlot: () => false,
    assemble: () => false,
    experiment: () => false,
    finalizePrototype: () => false,
    finalizePractice: () => false,
    draftSchematic: () => false,
    cancel: () => false,
  };
}

/** The live port over the authority command queue (contracts 48–56). */
export function createLiveCraftCommandPort(state: PlayState, slice: SliceSnapshot): CraftCommandPort {
  const tick = () => authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  const queue = () => state.authorityCommands;
  return {
    begin: (recipeId) => enqueueAuthorityCraftBeginCommand(queue(), recipeId, tick()) !== null,
    assignSlot: (slotIndex, container, stackId, variantId) => enqueueAuthorityCraftAssignSlotCommand(
      queue(),
      { slotIndex, container, stackId, variantId },
      tick(),
    ) !== null,
    clearSlot: (slotIndex) => enqueueAuthorityCraftClearSlotCommand(queue(), slotIndex, tick()) !== null,
    assemble: () => enqueueAuthorityCraftAssembleCommand(queue(), tick()) !== null,
    experiment: (lineId, points) => enqueueAuthorityCraftExperimentCommand(queue(), lineId, points, tick()) !== null,
    finalizePrototype: (customName) => enqueueAuthorityCraftFinalizePrototypeCommand(queue(), tick(), customName) !== null,
    finalizePractice: () => enqueueAuthorityCraftFinalizePracticeCommand(queue(), tick()) !== null,
    draftSchematic: (maxUses) => enqueueAuthorityCraftDraftSchematicCommand(queue(), maxUses, tick()) !== null,
    cancel: () => enqueueAuthorityCraftCancelCommand(queue(), tick()) !== null,
  };
}

/** Craft command kinds — receipt scoping for the window's watcher. */
export const CRAFT_COMMAND_KINDS = [
  "CraftBegin",
  "CraftAssignSlot",
  "CraftClearSlot",
  "CraftAssemble",
  "CraftExperiment",
  "CraftFinalizePrototype",
  "CraftFinalizePractice",
  "CraftDraftSchematic",
  "FactoryManufacture",
  "CraftCancel",
] as const;

export type CraftCommandKind = (typeof CRAFT_COMMAND_KINDS)[number];

export interface CraftReceipt {
  kind: CraftCommandKind;
  accepted: boolean;
  reasonCode: string | null;
  /** Envelope flush time — lets a reopened window skip stale flashes. */
  sentAtMs: number | null;
}

export interface CraftReceiptWatcher {
  /** All NEW receipts of craft kinds since the last poll, oldest first. */
  poll(into: CraftReceipt[]): void;
}

/**
 * Receipt watcher over `serverAuthority.receiptLog` (128-entry push-ordered
 * ring). The single-slot `lastReceipt` pattern the other windows use would
 * drop receipts when one frame carries several — the experiment APPLY sends
 * one CraftExperiment per marked line, so this window needs the log. Kind
 * resolution goes through `sentCommandLog`, same as commandReceipts.
 */
export function createCraftReceiptWatcher(state: PlayState): CraftReceiptWatcher {
  let highWaterCommandId = state.serverAuthority.lastReceipt?.commandId ?? -1;
  return {
    poll(into: CraftReceipt[]): void {
      const log = state.serverAuthority.receiptLog;
      let newHigh = highWaterCommandId;
      for (const receipt of log) {
        if (receipt.commandId <= highWaterCommandId) continue;
        if (receipt.commandId > newHigh) newHigh = receipt.commandId;
        const sent = state.serverAuthority.sentCommandLog.find(
          (entry) => entry.commandId === receipt.commandId,
        );
        if (!sent) continue;
        // String-widened membership: the craft kinds join the authority
        // command union at CONTRACTS-LIVE; this watcher must compile on
        // both sides of that landing.
        if (!(CRAFT_COMMAND_KINDS as readonly string[]).includes(sent.kind)) continue;
        const kind = sent.kind as CraftCommandKind;
        into.push({
          kind,
          accepted: receipt.accepted,
          reasonCode: receipt.reasonCode ?? null,
          sentAtMs: sent.sentAtMs ?? null,
        });
      }
      highWaterCommandId = newHigh;
    },
  };
}
