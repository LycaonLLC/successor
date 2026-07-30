import {
  authorityIssuedAtServerTick,
  enqueueAuthorityAcceptTradeCommand,
  enqueueAuthorityAddTradeItemCommand,
  enqueueAuthorityConfirmTradeCommand,
  enqueueAuthorityDeclineTradeCommand,
  enqueueAuthorityProposeTradeCommand,
  enqueueAuthorityRemoveTradeItemCommand,
  enqueueAuthoritySetTradeCoinCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";

/**
 * TRADE command port — the window's only way to speak to the authority.
 *
 * The composition root (successor3dApp) builds the live port; every method
 * returns whether the command was QUEUED (house enqueue contract —
 * acceptance arrives later as a receipt). `createUnboundTradeCommandPort`
 * is the pre-registration stand-in: every call refuses, so the window's
 * deny path stays honest instead of pretending a dead link queued work.
 *
 * Wire (locked with TradeLockSim; landed at 1252d0e): the session OPENS via
 * the EXISTING ProposeTrade (empty offer/request), locks via the EXISTING
 * AcceptTrade (double-lock semantics), executes via ConfirmTrade, mutates
 * via AddTradeItem/RemoveTradeItem/SetTradeCoin — all typed binds.
 */

export interface TradeCommandPort {
  /** ProposeTrade with empty offer/request — opens the table both sides. */
  open(partnerActorId: string): boolean;
  addItem(proposalId: number, itemId: number, variantId: number, quantity: number): boolean;
  /** Wire carries the FULL line spec (contract doc: remove names the whole
   *  line — itemId/variantId/quantity of the line being withdrawn). */
  removeItem(proposalId: number, itemId: number, variantId: number, quantity: number): boolean;
  setCoin(proposalId: number, amount: number): boolean;
  /** AcceptTrade — latch my accept-lock (seal). */
  accept(proposalId: number): boolean;
  /** ConfirmTrade — the final countersign. */
  confirm(proposalId: number): boolean;
  decline(proposalId: number): boolean;
}

export function createUnboundTradeCommandPort(): TradeCommandPort {
  return {
    open: () => false,
    addItem: () => false,
    removeItem: () => false,
    setCoin: () => false,
    accept: () => false,
    confirm: () => false,
    decline: () => false,
  };
}

/** The live port over the authority command queue (wire tags 14-16, 63-66). */
export function createLiveTradeCommandPort(state: PlayState, slice: SliceSnapshot): TradeCommandPort {
  const tick = () => authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  const queue = () => state.authorityCommands;
  return {
    open: (partnerActorId) => enqueueAuthorityProposeTradeCommand(queue(), partnerActorId, [], [], tick()) !== null,
    addItem: (proposalId, itemId, variantId, quantity) => enqueueAuthorityAddTradeItemCommand(
      queue(),
      proposalId,
      { item_id: itemId, variant_id: variantId, quantity },
      tick(),
    ) !== null,
    removeItem: (proposalId, itemId, variantId, quantity) => enqueueAuthorityRemoveTradeItemCommand(
      queue(),
      proposalId,
      { item_id: itemId, variant_id: variantId, quantity },
      tick(),
    ) !== null,
    setCoin: (proposalId, amount) => enqueueAuthoritySetTradeCoinCommand(queue(), proposalId, amount, tick()) !== null,
    accept: (proposalId) => enqueueAuthorityAcceptTradeCommand(queue(), proposalId, tick()) !== null,
    confirm: (proposalId) => enqueueAuthorityConfirmTradeCommand(queue(), proposalId, tick()) !== null,
    decline: (proposalId) => enqueueAuthorityDeclineTradeCommand(queue(), proposalId, tick()) !== null,
  };
}

/** Trade command kinds — receipt scoping for the window's watcher. */
export const TRADE_COMMAND_KINDS = [
  "ProposeTrade",
  "AcceptTrade",
  "DeclineTrade",
  "AddTradeItem",
  "RemoveTradeItem",
  "SetTradeCoin",
  "ConfirmTrade",
] as const;

export type TradeCommandKind = (typeof TRADE_COMMAND_KINDS)[number];

export interface TradeReceipt {
  kind: TradeCommandKind;
  accepted: boolean;
  reasonCode: string | null;
  /** Envelope flush time — lets a reopened window skip stale flashes. */
  sentAtMs: number | null;
}

export interface TradeReceiptWatcher {
  /** All NEW receipts of trade kinds since the last poll, oldest first. */
  poll(into: TradeReceipt[]): void;
}

/**
 * Receipt watcher over `serverAuthority.receiptLog` (craft-window pattern —
 * the single-slot `lastReceipt` would drop receipts when one frame carries
 * several; a drag-drop burst queues AddTradeItem + SetTradeCoin together).
 * Kind resolution goes through `sentCommandLog`, string-widened so the four
 * kinds joining the union at TradeLockSim's landing compile on both sides.
 */
export function createTradeReceiptWatcher(state: PlayState): TradeReceiptWatcher {
  let highWaterCommandId = state.serverAuthority.lastReceipt?.commandId ?? -1;
  return {
    poll(into: TradeReceipt[]): void {
      const log = state.serverAuthority.receiptLog;
      let newHigh = highWaterCommandId;
      for (const receipt of log) {
        if (receipt.commandId <= highWaterCommandId) continue;
        if (receipt.commandId > newHigh) newHigh = receipt.commandId;
        const sent = state.serverAuthority.sentCommandLog.find(
          (entry) => entry.commandId === receipt.commandId,
        );
        if (!sent) continue;
        if (!(TRADE_COMMAND_KINDS as readonly string[]).includes(sent.kind)) continue;
        into.push({
          kind: sent.kind as TradeCommandKind,
          accepted: receipt.accepted,
          reasonCode: receipt.reasonCode ?? null,
          sentAtMs: sent.sentAtMs ?? null,
        });
      }
      highWaterCommandId = newHigh;
    },
  };
}
