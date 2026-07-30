import type {
  PlayState,
  ServerAuthorityTradeSessionState,
  ServerAuthorityTradeSideState,
} from "@successor/client/src/slice-core/gameState";
import { isTerminalTradeStage } from "./machine";
import type {
  TradeCloseReason,
  TradeItemLineVM,
  TradeSessionVM,
  TradeSideVM,
  TradeStage,
} from "./types";

/**
 * TRADE store — module-level accumulation of the trade-session channel
 * (craft-store pattern: one PlayState per page, reset with the page).
 *
 * Three surfaces feed it:
 *  - the authority receive path ingests the streamed `tradeSession` VM
 *    (TradeLockSim wire — one-tick terminal stage, then null);
 *  - commands optimistically change NOTHING here (server truth only);
 *  - the DEV fixture seam (`__successorTradeIngest`) drives every stage for
 *    tests, screenshots and the QA harness without a live sim.
 *
 * TERMINAL LATCH: the wire holds `executed`/`declined` for one tick before
 * clearing to null, and a peer's decline can even reach us as a bare null.
 * The store latches the last terminal VM (synthesizing a `declined` one for
 * a non-terminal → null transition) until the window acknowledges via
 * `acknowledgeTradeClose()` — so both players always SEE the closing banner.
 */

interface TradeStoreState {
  live: TradeSessionVM | null;
  latched: TradeSessionVM | null;
}

const store: TradeStoreState = { live: null, latched: null };

let storeVersion = 0;

/** Monotonic counter bumped on every ingest — cheap re-render detection. */
export function tradeStoreVersion(): number {
  return storeVersion;
}

/** The session the window renders: live wire state, else the terminal latch. */
export function tradeSession(): TradeSessionVM | null {
  return store.live ?? store.latched;
}

// ── Ingest (authority receive path + dev seam) ─────────────────────────────

export function ingestTradeSession(session: TradeSessionVM | null): void {
  if (session) {
    store.live = session;
    // A fresh table replaces any stale unacknowledged latch; a terminal VM
    // becomes the latch itself (the wire nulls it next tick).
    store.latched = isTerminalTradeStage(session.stage) ? session : null;
  } else {
    if (store.live && !isTerminalTradeStage(store.live.stage)) {
      // Wire vanished mid-session (instant-null close) — latch an honest
      // declined terminal so the banner never silently evaporates.
      store.latched = { ...store.live, stage: "declined", closeReason: store.live.closeReason ?? "declined" };
    }
    store.live = null;
  }
  storeVersion += 1;
}

/** CLOSE pressed on a terminal banner — the table is really gone now. */
export function acknowledgeTradeClose(): void {
  if (store.latched === null && store.live === null) return;
  store.latched = null;
  // A terminal live VM is spent the moment the player acknowledges it.
  if (store.live && isTerminalTradeStage(store.live.stage)) store.live = null;
  storeVersion += 1;
}

// ── Authority sync (live bind) ─────────────────────────────────────────────
// Normalizes the streamed tradeSession channel into the store. Called from
// the window's update path — identity-gated so identical wire objects cost
// nothing per frame. The composition root opts in (`enableTradeAuthoritySync`);
// fixture harnesses never enable it, so the two feeds can't fight.

let authoritySyncEnabled = false;
let syncedSession: unknown = Symbol("never");

/** Composition-root opt-in: the live client owns the store from here on. */
export function enableTradeAuthoritySync(): void {
  authoritySyncEnabled = true;
}

export function syncTradeChannelFromAuthority(state: PlayState): void {
  if (!authoritySyncEnabled) return;
  const wire = state.serverAuthority.tradeSession;
  if (wire === syncedSession) return;
  syncedSession = wire;
  ingestTradeSession(normalizeWireSession(wire, state));
}

const WIRE_STAGES: readonly TradeStage[] = ["negotiating", "confirm", "executed", "declined"];
const WIRE_CLOSE_REASONS: readonly TradeCloseReason[] = ["declined", "range", "death", "link"];

function normalizeWireSession(wire: ServerAuthorityTradeSessionState | null, state: PlayState): TradeSessionVM | null {
  if (!wire) return null;
  const stage = WIRE_STAGES.includes(wire.stage) ? wire.stage : null;
  const mine = normalizeWireSide(wire.mine, state);
  const theirs = normalizeWireSide(wire.theirs, state);
  if (!stage || !mine || !theirs) return null;
  const closeReason = WIRE_CLOSE_REASONS.includes(wire.closeReason as TradeCloseReason)
    ? wire.closeReason as TradeCloseReason
    : null;
  return {
    proposalId: Math.max(0, Math.trunc(wire.proposalId)),
    partnerActorId: wire.partnerActorId || theirs.actorId,
    mine,
    theirs,
    bothLocked: wire.bothLocked === true || (mine.locked && theirs.locked),
    stage,
    closeReason,
    tick: Math.max(0, Math.trunc(Number((wire as { tick?: unknown }).tick ?? 0))),
  };
}

function normalizeWireSide(wire: ServerAuthorityTradeSideState | undefined, state: PlayState): TradeSideVM | null {
  if (!wire || typeof wire.actorId !== "string" || wire.actorId.length === 0) return null;
  const side = wire;
  const lines = Array.isArray(side.items) ? side.items : [];
  const items: TradeItemLineVM[] = [];
  for (const raw of lines) {
    const line = (raw ?? {}) as { itemId?: unknown; variantId?: unknown; name?: unknown; quantity?: unknown };
    const itemId = Math.trunc(Number(line.itemId ?? 0));
    const quantity = Math.trunc(Number(line.quantity ?? 0));
    if (itemId <= 0 || quantity <= 0) continue;
    items.push({
      itemId,
      variantId: Math.trunc(Number(line.variantId ?? 0)),
      name: typeof line.name === "string" && line.name.length > 0 ? line.name : `Item ${itemId}`,
      quantity,
    });
  }
  // Display name is NOT on the wire — resolve from live actor state, the
  // same `label ?? actorId` convention the combat log uses.
  const label = state.serverAuthority.actors[side.actorId]?.label;
  return {
    actorId: side.actorId,
    name: typeof label === "string" && label.length > 0 ? label : side.actorId,
    items,
    coin: Math.max(0, Math.trunc(Number(side.coin ?? 0))),
    locked: side.locked === true,
    confirmed: side.confirmed === true,
  };
}

// ── Dev fixture seam ───────────────────────────────────────────────────────
// Matches __successorCraftIngest: lets the QA harness drive the window
// through every stage without the sim round-trip. DEV builds only.

export interface TradeIngestPayload {
  session?: TradeSessionVM | null;
  /** Clear an unacknowledged terminal latch (harness stage resets). */
  acknowledge?: boolean;
}

declare global {
  interface Window {
    __successorTradeIngest?: (payload: TradeIngestPayload) => number;
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__successorTradeIngest = (payload: TradeIngestPayload): number => {
    if (payload.acknowledge) acknowledgeTradeClose();
    if (payload.session !== undefined) ingestTradeSession(payload.session);
    return storeVersion;
  };
}
