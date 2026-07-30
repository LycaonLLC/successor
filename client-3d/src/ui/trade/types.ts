/**
 * Trade window view-model contract for the secure double-lock session.
 *
 * The wire is PERSPECTIVE-RELATIVE: the sim streams `mine`/`theirs` already
 * flipped for this client, every tick, to both participants — the FE never
 * learns proposer-vs-partner and computes nothing the server already knows.
 * Wallet credits use the dedicated per-side `coin` field (never an item line).
 *
 * Lock protocol carried by the shapes (anti-abuse — owner explicit):
 *   ACCEPT latches `locked` (visible to both) → ANY offer change by EITHER
 *   side clears BOTH `locked` + `confirmed` → both locked gates the final
 *   OK (`confirmed`) → both confirmed executes the atomic all-or-nothing
 *   swap (existing re-validate-at-accept machinery).
 */

/** Wire channel: `state.serverAuthority.tradeSession`. */
export type TradeSideId = "mine" | "theirs";

/**
 * Session stages:
 *   `negotiating` — editing offers (not both locked);
 *   `confirm`     — both accept-locks latched, awaiting the dual OK
 *                   (per-side `confirmed` flags carry the countersigns);
 *   `executed` / `declined` — terminal, streamed for one tick with
 *                   `closeReason`, then the VM clears to null. The store
 *                   latches terminals so the window survives the null.
 */
export type TradeStage = "negotiating" | "confirm" | "executed" | "declined";

/** Why a declined session closed — feeds the banner line. */
export type TradeCloseReason = "declined" | "range" | "death" | "link";

export interface TradeItemLineVM {
  itemId: number;
  variantId: number;
  /** Display name streamed with the line — the receiving client may not own
   *  the variant's taxonomy locally. */
  name: string;
  quantity: number;
}

export interface TradeSideVM {
  actorId: string;
  /** Column-header display name — NOT on the wire (TradeSideVM streams
   *  actorId only); the store resolves it from live actor state at ingest. */
  name: string;
  items: TradeItemLineVM[];
  /** Wallet credits offered by this side (u64 on the wire; safe-integer here). */
  coin: number;
  /** Accept-lock latched (the SEALED stamp on both clients). */
  locked: boolean;
  /** Final OK given — meaningful once both sides are locked. */
  confirmed: boolean;
}

export interface TradeSessionVM {
  proposalId: number;
  partnerActorId: string;
  mine: TradeSideVM;
  theirs: TradeSideVM;
  /** Server-computed convenience — true iff mine.locked && theirs.locked. */
  bothLocked: boolean;
  stage: TradeStage;
  /** Set when stage is `declined`. */
  closeReason?: TradeCloseReason | null;
  /** Authority tick the VM was published at. */
  tick: number;
}

/** Window-local selection: which offered line feeds the turntable preview. */
export interface TradeSelection {
  side: TradeSideId;
  itemId: number;
  variantId: number;
}

/** Credit Chip: physical currency item; quantity = redeemable credit value. */
export const CREDIT_CHIP_ITEM_ID = 9002;
