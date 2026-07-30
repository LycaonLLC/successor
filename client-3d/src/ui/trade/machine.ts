import type {
  TradeCloseReason,
  TradeItemLineVM,
  TradeSessionVM,
  TradeSideId,
  TradeSideVM,
  TradeStage,
} from "./types";

/**
 * TRADE double-lock machine — the pure fixture oracle for the session
 * protocol TradeLockSim owns on the sim side.
 *
 * The window NEVER runs this against live play (server truth streams the VM;
 * the FE computes nothing). It exists so that:
 *  - the reducer TESTS encode the negotiated contract (change-unchecks-both
 *    on items AND coin, from EITHER side; dual-lock gates the OK step; both
 *    OKs execute) — if the sim's transitions ever diverge, these tests are
 *    the tripwire that forces an explicit re-negotiation;
 *  - fixtures and the dev-seam QA harness can drive a believable two-client
 *    session through every stage without a live sim.
 *
 * Reducer contract: returns the SAME reference for no-op/invalid events —
 * callers (and tests) can cheaply assert "this must not move the session".
 * Applied events return a fresh session (structural sharing elsewhere).
 */

export type TradeMachineEvent =
  | { kind: "addItem"; side: TradeSideId; line: TradeItemLineVM }
  | { kind: "removeItem"; side: TradeSideId; itemId: number; variantId: number }
  | { kind: "setCoin"; side: TradeSideId; amount: number }
  | { kind: "accept"; side: TradeSideId }
  | { kind: "confirm"; side: TradeSideId }
  | { kind: "decline"; side: TradeSideId; reason?: TradeCloseReason };

const TERMINAL_STAGES: readonly TradeStage[] = ["executed", "declined"];

export function isTerminalTradeStage(stage: TradeStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export function reduceTradeSession(session: TradeSessionVM, event: TradeMachineEvent): TradeSessionVM {
  if (isTerminalTradeStage(session.stage)) return session; // terminals absorb everything

  switch (event.kind) {
    case "addItem": {
      if (!Number.isInteger(event.line.quantity) || event.line.quantity <= 0) return session;
      const side = session[event.side];
      const existing = side.items.find((line) => line.itemId === event.line.itemId && line.variantId === event.line.variantId) ?? null;
      if (existing && existing.quantity === event.line.quantity && existing.name === event.line.name) {
        return session; // identical upsert — not a change, must NOT break seals
      }
      const items = existing
        ? side.items.map((line) => (line === existing ? { ...event.line } : line))
        : [...side.items, { ...event.line }];
      return invalidateLocks(session, event.side, { items });
    }
    case "removeItem": {
      const side = session[event.side];
      const existing = side.items.find((line) => line.itemId === event.itemId && line.variantId === event.variantId) ?? null;
      if (!existing) return session;
      const items = side.items.filter((line) => line !== existing);
      return invalidateLocks(session, event.side, { items });
    }
    case "setCoin": {
      if (!Number.isSafeInteger(event.amount) || event.amount < 0) return session;
      if (session[event.side].coin === event.amount) return session; // no-op keeps seals
      return invalidateLocks(session, event.side, { coin: event.amount });
    }
    case "accept": {
      if (session[event.side].locked) return session; // idempotent
      const next = withSide(session, event.side, { locked: true });
      const bothLocked = next.mine.locked && next.theirs.locked;
      next.bothLocked = bothLocked;
      next.stage = bothLocked ? "confirm" : "negotiating";
      return next;
    }
    case "confirm": {
      // Dual-lock gate: the countersign only exists once BOTH boxes sealed
      // (stage "confirm"). First OK stays in-stage; the second executes.
      if (!session.bothLocked) return session;
      if (session[event.side].confirmed) return session; // idempotent
      const next = withSide(session, event.side, { confirmed: true });
      next.stage = next.mine.confirmed && next.theirs.confirmed ? "executed" : "confirm";
      return next;
    }
    case "decline": {
      return {
        ...session,
        stage: "declined",
        closeReason: event.reason ?? "declined",
      };
    }
  }
}

/** Run a scripted exchange — fixtures and the QA harness read as a story. */
export function runTradeScript(session: TradeSessionVM, events: readonly TradeMachineEvent[]): TradeSessionVM {
  let current = session;
  for (const event of events) current = reduceTradeSession(current, event);
  return current;
}


/**
 * The anti-abuse core (owner explicit): ANY applied offer mutation — item
 * add/remove or coin change, by EITHER side — clears BOTH accept-locks AND
 * both final OKs, dropping the session back to `negotiating`.
 */
function invalidateLocks(
  session: TradeSessionVM,
  side: TradeSideId,
  patch: Partial<Pick<TradeSideVM, "items" | "coin">>,
): TradeSessionVM {
  const next = withSide(session, side, patch);
  next.mine = { ...next.mine, locked: false, confirmed: false };
  next.theirs = { ...next.theirs, locked: false, confirmed: false };
  next.bothLocked = false;
  next.stage = "negotiating";
  return next;
}

function withSide(session: TradeSessionVM, side: TradeSideId, patch: Partial<TradeSideVM>): TradeSessionVM {
  return {
    ...session,
    [side]: { ...session[side], ...patch },
  };
}
