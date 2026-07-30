import type { PlayState } from "@successor/client/src/slice-core/gameState";
import type { WindowManager } from "../windows/windowManager";
import type { TradeCommandPort } from "./commands";
import { isTerminalTradeStage } from "./machine";
import { acknowledgeTradeClose, syncTradeChannelFromAuthority, tradeSession } from "./store";

/**
 * TRADE lifecycle — the composition-root seams, DOM-free.
 *
 * Everything the boot file (and the slash router) needs to wire the secure
 * trade lives here so the hot-file hunks stay one line each and none of it
 * drags the GL/DOM window graph into node-side tests:
 *  - `openTradeWith`      — initiator entry (radial TRADE / `/trade`);
 *  - `pollTradeLifecycle` — frame hook: channel sync + partner auto-open;
 *  - `wireTradeWindowLifecycle` — ✕/Esc on a live table declines (earlier sandbox design);
 *  - `tradeSlashLine`     — the `/trade` window-opening grammar.
 */

export const TRADE_WINDOW_ID = "trade";

// ── Module lifecycle state (converse-target pattern) ────────────────────────
/** Closing the window mid-trade declines; suppress auto-reopen for that id. */
let suppressedProposalId: number | null = null;
/** Set when WE requested a table — drives the "TABLE REQUESTED" empty state. */
let openRequestedAtMs = 0;

/** When the local player last requested a table (0 = none pending). */
export function tradeOpenRequestedAt(): number {
  return openRequestedAtMs;
}

/** A table arrived (or died) — the pending-open hint is spent. */
export function clearTradeOpenRequested(): void {
  openRequestedAtMs = 0;
}

/**
 * Initiator entry point (radial TRADE / `/trade`): queue the open command
 * and raise the window immediately — the table fills when the VM streams.
 */
export function openTradeWith(
  partnerActorId: string,
  commands: TradeCommandPort,
  windowManager: Pick<WindowManager, "open">,
): boolean {
  suppressedProposalId = null;
  const queued = commands.open(partnerActorId);
  if (queued) openRequestedAtMs = performance.now();
  windowManager.open(TRADE_WINDOW_ID);
  return queued;
}

/**
 * Composition-root frame hook: keeps the channel synced while the window is
 * CLOSED and auto-opens it when a live session appears (the partner side of
 * earlier sandbox design's auto-open). Skips a session we just declined by closing.
 */
export function pollTradeLifecycle(state: PlayState, windowManager: Pick<WindowManager, "open" | "isOpen">): void {
  syncTradeChannelFromAuthority(state);
  const session = tradeSession();
  if (!session || isTerminalTradeStage(session.stage)) return;
  if (session.proposalId === suppressedProposalId) return;
  if (suppressedProposalId !== null) suppressedProposalId = null; // fresh table clears the guard
  if (!windowManager.isOpen(TRADE_WINDOW_ID)) windowManager.open(TRADE_WINDOW_ID);
}

/**
 * Composition-root close hook: ✕/Esc on a LIVE table is a decline (earlier sandbox design
 * behavior — closing the window clears the table); on a terminal banner it
 * just acknowledges. Returns the unsubscribe.
 */
export function wireTradeWindowLifecycle(
  windowManager: Pick<WindowManager, "subscribeOpenChanged">,
  commands: TradeCommandPort,
): () => void {
  return windowManager.subscribeOpenChanged((id, open) => {
    if (id !== TRADE_WINDOW_ID || open) return;
    const session = tradeSession();
    if (session && !isTerminalTradeStage(session.stage)) {
      commands.decline(session.proposalId);
      suppressedProposalId = session.proposalId;
    }
    acknowledgeTradeClose();
  });
}

/**
 * `/trade` slash entry (slash-command parity — the GUI opener, not the power CLI).
 * Handles ONLY the window-opening grammar: bare `/trade` targets the current
 * selection; `/trade <name>` resolves a live player pawn by label or id.
 * Anything richer (`/trade propose … offer=…`) returns null and falls
 * through to the verb registry's curated ProposeTrade.
 */
export function tradeSlashLine(
  line: string,
  state: PlayState,
  commands: TradeCommandPort,
  windowManager: Pick<WindowManager, "open">,
): string | null {
  const match = /^\/trade(?:\s+(\S+))?\s*$/iu.exec(line.trim());
  if (!match) return null;
  const raw = match[1] ?? "";
  if (raw.toLowerCase() === "propose") return null; // power CLI keeps the verb
  const partnerId = resolveTradePartnerId(state, raw);
  if (!partnerId) {
    return raw.length === 0
      ? "TRADE DENIED — SELECT AN OPERATIVE OR /TRADE <NAME>"
      : `TRADE DENIED — NO OPERATIVE NAMED ${raw.toUpperCase()}`;
  }
  openTradeWith(partnerId, commands, windowManager);
  const label = state.serverAuthority.actors[partnerId]?.label ?? partnerId;
  return `TABLE REQUESTED — ${label.toUpperCase()}`;
}

/** Live player pawn by exact id or case-insensitive label; "" = selection. */
function resolveTradePartnerId(state: PlayState, raw: string): string | null {
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const tradable = (actorId: string): boolean => {
    const actor = state.serverAuthority.actors[actorId];
    return actorId !== meId
      && actor !== undefined
      && actor.lifeState === "alive"
      && (actor.role === "player" || actor.role === "agent_player");
  };
  if (raw.length === 0 || raw === "$target" || raw === "$selected") {
    const selected = state.selectedActorId;
    return selected && tradable(selected) ? selected : null;
  }
  if (tradable(raw)) return raw;
  const needle = raw.toLowerCase();
  for (const actorId in state.serverAuthority.actors) {
    if (!tradable(actorId)) continue;
    const label = state.serverAuthority.actors[actorId]?.label ?? "";
    if (label.toLowerCase() === needle) return actorId;
  }
  return null;
}
