import type { TradeCloseReason } from "./types";

/**
 * TRADE copy — every player-facing string for the secure-trade flow.
 *
 * DESIGN.md copy law: no dev strings reach a player; server reasonCodes get
 * player-language lines; chrome text is minimal short nouns; explanations
 * live on hover. Voice: the requisition office notarizing a field exchange —
 * seals, countersignatures, dry ink.
 */

// ── Reason codes (REASONS_TRADE + queue denials) ───────────────────────────
// Keys normalized (lowercase, separators stripped) so the same line answers
// `TargetUnavailable`, `target_unavailable` and `TARGET UNAVAILABLE`.

const REASON_LINES: Readonly<Record<string, string>> = {
  targetunavailable: "Your trade partner is out of reach.",
  itemunavailable: "That side can't cover its offer any more.",
  wrongplayer: "That trade isn't yours to answer.",
  unknownactor: "No such trader here.",
  actornotalive: "Not while you're down.",
  actorbusy: "Finish what you're doing first.",
  notradesession: "No trade on the table.",
  tradesessionactive: "You're already mid-trade — close it first.",
  tradenotlocked: "Both seals first, then the countersign.",
  tradelinelimit: "The table only holds so many lines.",
  insufficientcredits: "Credits you don't hold can't change hands.",
  queuefull: "Command queue is full — ease off.",
};

/** Player-language line for a server reject reasonCode. Never dev-cased. */
export function tradeReasonLine(reasonCode: string | null | undefined): string {
  if (!reasonCode) return "Refused by the field office.";
  const key = reasonCode.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (REASON_LINES[key]) return REASON_LINES[key];
  const words = reasonCode
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim()
    .toLowerCase();
  return words.length > 0 ? `Refused — ${words}.` : "Refused by the field office.";
}

// ── Close reasons → banner lines ───────────────────────────────────────────

const CLOSE_LINES: Readonly<Record<TradeCloseReason, string>> = {
  declined: "The table was cleared. Nothing changed hands.",
  range: "You drifted apart. Nothing changed hands.",
  death: "A trader went down. Nothing changed hands.",
  link: "Link lost. Nothing changed hands.",
};

export function tradeCloseLine(reason: TradeCloseReason | null | undefined): string {
  return CLOSE_LINES[reason ?? "declined"] ?? CLOSE_LINES.declined;
}

// ── Fixed flow copy (short nouns / honest gates) ───────────────────────────

export const TRADE_COPY = {
  windowTitle: "TRADE",
  mineTitle: "YOUR OFFER",
  stage: {
    negotiating: "NEGOTIATING",
    confirm: "SEALED — AWAITING COUNTERSIGNS",
    executed: "TRADE COMPLETE",
    declined: "TRADE CLOSED",
  },
  grid: {
    /** Empty-cell hint on MY column (hover). */
    dropHint: "Drag items from your pack",
    /** Remove chip aria/hover on my filled cells. */
    remove: "Withdraw from the table",
    theirEmpty: "Nothing offered yet",
  },
  coin: {
    label: "CREDITS",
    held: (amount: number) => `HELD ${amount.toLocaleString("en-US")}`,
    editHint: "Credits on the table — Enter commits",
  },
  seal: {
    /** Stamp across a locked column. */
    locked: "SEALED",
    /** Stamp across a confirmed column (confirm stage). */
    confirmed: "COUNTERSIGNED",
    /** Flash when a change breaks existing seals (server cleared locks). */
    broken: "SEALS BROKEN — OFFER CHANGED",
  },
  cta: {
    accept: "ACCEPT",
    acceptHint: "Seal your side. Any change re-opens both.",
    acceptSealed: "SEALED · AWAITING PARTNER",
    confirm: "CONFIRM",
    confirmHint: "Final countersign — both confirm and the swap is done.",
    confirmGiven: "Countersigned — awaiting partner",
    decline: "DECLINE",
    declineHint: "Clear the table. Nothing moves.",
    close: "CLOSE",
  },
  preview: {
    empty: "SELECT AN ITEM",
    emptyHint: "Click any offered item for a closer look.",
    qty: (count: number) => (count > 1 ? `QTY ${count.toLocaleString("en-US")}` : "QTY 1"),
  },
  executed: {
    title: "TRADE COMPLETE",
    line: "Goods exchanged and logged. Check your pack.",
  },
  declinedTitle: "TRADE CLOSED",
  empty: "NO TABLE OPEN",
  emptyHint: "Right-click an operative → TRADE",
  emptyRequested: "TABLE REQUESTED — waiting for the field office.",
  deny: "DENIED",
} as const;
