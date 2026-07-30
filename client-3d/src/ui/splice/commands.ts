import {
  authorityIssuedAtServerTick,
  enqueueAuthorityGeneSampleCommand,
  enqueueAuthorityScanGenomeCommand,
  enqueueAuthoritySpliceAssembleCommand,
  enqueueAuthoritySpliceAssignSlotCommand,
  enqueueAuthoritySpliceBeginCommand,
  enqueueAuthoritySpliceCancelCommand,
  enqueueAuthoritySpliceChooseAlleleCommand,
  enqueueAuthoritySpliceClearSlotCommand,
  enqueueAuthoritySpliceExperimentLocusCommand,
  enqueueAuthoritySpliceMintCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";

/**
 * SPLICE command port — the gene-bench window's only way to speak to the
 * authority (mirror of the craft port). Every method returns whether the
 * command was QUEUED (house enqueue contract — acceptance arrives later as a
 * receipt). `createUnboundSpliceCommandPort` refuses every call so the deny
 * path stays honest before the composition root binds the live port.
 */
export interface SpliceCommandPort {
  /** ACQUIRE — bank a wild landrace of `species` as a seed (its own cooldown). */
  geneSample(species: string): boolean;
  /** ANALYZE — reveal a seed's genome (tier gated by the Sequencing track). */
  scanGenome(container: string, stackId: string, variantId: number): boolean;
  /** SPLICE — open a session at the bench for `species`. */
  begin(species: string): boolean;
  assignSlot(slotIndex: number, container: string, stackId: string, variantId: number): boolean;
  clearSlot(slotIndex: number): boolean;
  /** Directed segregation: which allele (index 0|1) to take from parent A|B. */
  chooseAllele(locus: number, fromParent: number, allele: number): boolean;
  assemble(): boolean;
  experiment(locus: number, points: number): boolean;
  mint(cultivarName: string | null): boolean;
  cancel(): boolean;
}

export function createUnboundSpliceCommandPort(): SpliceCommandPort {
  return {
    geneSample: () => false,
    scanGenome: () => false,
    begin: () => false,
    assignSlot: () => false,
    clearSlot: () => false,
    chooseAllele: () => false,
    assemble: () => false,
    experiment: () => false,
    mint: () => false,
    cancel: () => false,
  };
}

/** The live port over the authority command queue (DEF-6 splice command union). */
export function createLiveSpliceCommandPort(state: PlayState, slice: SliceSnapshot): SpliceCommandPort {
  const tick = () => authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  const queue = () => state.authorityCommands;
  return {
    geneSample: (species) => enqueueAuthorityGeneSampleCommand(queue(), species, tick()) !== null,
    scanGenome: (container, stackId, variantId) => enqueueAuthorityScanGenomeCommand(
      queue(),
      { container, stackId, variantId },
      tick(),
    ) !== null,
    begin: (species) => enqueueAuthoritySpliceBeginCommand(queue(), species, tick()) !== null,
    assignSlot: (slotIndex, container, stackId, variantId) => enqueueAuthoritySpliceAssignSlotCommand(
      queue(),
      { slotIndex, container, stackId, variantId },
      tick(),
    ) !== null,
    clearSlot: (slotIndex) => enqueueAuthoritySpliceClearSlotCommand(queue(), slotIndex, tick()) !== null,
    chooseAllele: (locus, fromParent, allele) => enqueueAuthoritySpliceChooseAlleleCommand(
      queue(),
      { locus, fromParent, allele },
      tick(),
    ) !== null,
    assemble: () => enqueueAuthoritySpliceAssembleCommand(queue(), tick()) !== null,
    experiment: (locus, points) => enqueueAuthoritySpliceExperimentLocusCommand(
      queue(),
      { locus, points },
      tick(),
    ) !== null,
    mint: (cultivarName) => enqueueAuthoritySpliceMintCommand(queue(), cultivarName, tick()) !== null,
    cancel: () => enqueueAuthoritySpliceCancelCommand(queue(), tick()) !== null,
  };
}

/** Splice command kinds — receipt scoping for the window's watcher. */
export const SPLICE_COMMAND_KINDS = [
  "GeneSample",
  "ScanGenome",
  "SpliceBegin",
  "SpliceAssignSlot",
  "SpliceClearSlot",
  "SpliceChooseAllele",
  "SpliceAssemble",
  "SpliceExperimentLocus",
  "SpliceMint",
  "SpliceCancel",
] as const;

export type SpliceCommandKind = (typeof SPLICE_COMMAND_KINDS)[number];

export interface SpliceReceipt {
  kind: SpliceCommandKind;
  accepted: boolean;
  reasonCode: string | null;
  /** Envelope flush time — lets a reopened window skip stale flashes. */
  sentAtMs: number | null;
}

export interface SpliceReceiptWatcher {
  /** All NEW splice-kind receipts since the last poll, oldest first. */
  poll(into: SpliceReceipt[]): void;
}

/**
 * Receipt watcher over `serverAuthority.receiptLog` (128-entry ring). One
 * frame can carry several splice receipts (e.g. a fill + auto-scan), so this
 * drains the log, not the single-slot `lastReceipt`. Kind resolution goes
 * through `sentCommandLog`, exactly like the craft watcher.
 */
export function createSpliceReceiptWatcher(state: PlayState): SpliceReceiptWatcher {
  let highWaterCommandId = state.serverAuthority.lastReceipt?.commandId ?? -1;
  return {
    poll(into: SpliceReceipt[]): void {
      const log = state.serverAuthority.receiptLog;
      let newHigh = highWaterCommandId;
      for (const receipt of log) {
        if (receipt.commandId <= highWaterCommandId) continue;
        if (receipt.commandId > newHigh) newHigh = receipt.commandId;
        const sent = state.serverAuthority.sentCommandLog.find(
          (entry) => entry.commandId === receipt.commandId,
        );
        if (!sent) continue;
        if (!(SPLICE_COMMAND_KINDS as readonly string[]).includes(sent.kind)) continue;
        into.push({
          kind: sent.kind as SpliceCommandKind,
          accepted: receipt.accepted,
          reasonCode: receipt.reasonCode ?? null,
          sentAtMs: sent.sentAtMs ?? null,
        });
      }
      highWaterCommandId = newHigh;
    },
  };
}
