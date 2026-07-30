import { runTradeScript, type TradeMachineEvent } from "./machine";
import type { TradeItemLineVM, TradeSessionVM } from "./types";

/**
 * TRADE fixtures — the waystation deal as data. One coherent story used by
 * the composer tests AND the dev ingest seam (`__successorTradeIngest`):
 * Operative Seven puts 4 Creature Hide and a Vibrosword on the table;
 * Vex Marrow answers with 2 Ashfall Copper and 250 credits; seals go on,
 * a countersign lands, and the swap executes — with detours for the decline
 * and the classic last-second coin switch (seals must break).
 *
 * Every stage is produced by RUNNING THE REDUCER over events from the open
 * table — the fixtures exercise the same machine the tests gate, so a
 * semantics drift breaks both, loudly.
 */

export const FIXTURE_PARTNER_NAME = "Vex Marrow";

export function fixtureHideLine(quantity = 4): TradeItemLineVM {
  return { itemId: 2101, variantId: 210_777, name: "Creature Hide", quantity };
}

export function fixtureVibroswordLine(): TradeItemLineVM {
  return { itemId: 3103, variantId: 0, name: "Vibrosword", quantity: 1 };
}

export function fixtureCopperLine(quantity = 2): TradeItemLineVM {
  return { itemId: 2007, variantId: 220_118, name: "Ashfall Copper", quantity };
}

/** Stage 1 — table just opened, nothing offered. */
export function fixtureTradeOpen(): TradeSessionVM {
  return {
    proposalId: 11,
    partnerActorId: "vex-marrow",
    mine: { actorId: "operative-7", name: "Operative Seven", items: [], coin: 0, locked: false, confirmed: false },
    theirs: { actorId: "vex-marrow", name: FIXTURE_PARTNER_NAME, items: [], coin: 0, locked: false, confirmed: false },
    bothLocked: false,
    stage: "negotiating",
    tick: 4_200,
  };
}

const OFFER_EVENTS: readonly TradeMachineEvent[] = [
  { kind: "addItem", side: "mine", line: fixtureHideLine() },
  { kind: "addItem", side: "mine", line: fixtureVibroswordLine() },
  { kind: "addItem", side: "theirs", line: fixtureCopperLine() },
  { kind: "setCoin", side: "theirs", amount: 250 },
];

/** Stage 2 — both offers on the table, no seals. */
export function fixtureTradeOffered(): TradeSessionVM {
  return runTradeScript(fixtureTradeOpen(), OFFER_EVENTS);
}

/** Stage 3 — partner sealed first; my side still open. */
export function fixtureTradeTheirsLocked(): TradeSessionVM {
  return runTradeScript(fixtureTradeOffered(), [{ kind: "accept", side: "theirs" }]);
}

/** Stage 4 — both sealed; the countersign step is armed. */
export function fixtureTradeBothLocked(): TradeSessionVM {
  return runTradeScript(fixtureTradeTheirsLocked(), [{ kind: "accept", side: "mine" }]);
}

/** Stage 5 — partner countersigned; waiting on mine. */
export function fixtureTradeConfirming(): TradeSessionVM {
  return runTradeScript(fixtureTradeBothLocked(), [{ kind: "confirm", side: "theirs" }]);
}

/** Stage 6 — both countersigned: executed (terminal). */
export function fixtureTradeExecuted(): TradeSessionVM {
  return runTradeScript(fixtureTradeConfirming(), [{ kind: "confirm", side: "mine" }]);
}

/** Decline detour — partner clears the sealed table (terminal). */
export function fixtureTradeDeclined(): TradeSessionVM {
  return runTradeScript(fixtureTradeBothLocked(), [{ kind: "decline", side: "theirs", reason: "declined" }]);
}

/** Anti-abuse detour — the last-second coin switch: both seals must break. */
export function fixtureTradeSealsBroken(): TradeSessionVM {
  return runTradeScript(fixtureTradeBothLocked(), [{ kind: "setCoin", side: "theirs", amount: 200 }]);
}
