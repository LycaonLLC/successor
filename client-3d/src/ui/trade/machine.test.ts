import { describe, expect, it } from "vitest";
import {
  fixtureCopperLine,
  fixtureHideLine,
  fixtureTradeBothLocked,
  fixtureTradeConfirming,
  fixtureTradeDeclined,
  fixtureTradeExecuted,
  fixtureTradeOffered,
  fixtureTradeOpen,
  fixtureTradeSealsBroken,
  fixtureTradeTheirsLocked,
  fixtureVibroswordLine,
} from "./fixtures";
import { reduceTradeSession, runTradeScript, type TradeMachineEvent } from "./machine";
import type { TradeSessionVM, TradeSideId } from "./types";

/**
 * The double-lock contract as executable truth. If the sim's transitions
 * diverge, update both the fixture oracle and this reducer together.
 */

const SIDES: readonly TradeSideId[] = ["mine", "theirs"];

function expectNoSeals(session: TradeSessionVM): void {
  expect(session.mine.locked).toBe(false);
  expect(session.theirs.locked).toBe(false);
  expect(session.mine.confirmed).toBe(false);
  expect(session.theirs.confirmed).toBe(false);
  expect(session.bothLocked).toBe(false);
  expect(session.stage).toBe("negotiating");
}

describe("offer staging", () => {
  it("upserts lines per (itemId, variantId) and treats identical re-adds as no-ops", () => {
    const open = fixtureTradeOpen();
    const once = reduceTradeSession(open, { kind: "addItem", side: "mine", line: fixtureHideLine(4) });
    expect(once.mine.items).toEqual([fixtureHideLine(4)]);
    // Identical upsert: same reference back (must NOT count as a change).
    expect(reduceTradeSession(once, { kind: "addItem", side: "mine", line: fixtureHideLine(4) })).toBe(once);
    // Quantity change replaces the line, not appends.
    const more = reduceTradeSession(once, { kind: "addItem", side: "mine", line: fixtureHideLine(9) });
    expect(more.mine.items).toEqual([fixtureHideLine(9)]);
  });

  it("removes only the named line and ignores absent lines", () => {
    const offered = fixtureTradeOffered();
    const removed = reduceTradeSession(offered, { kind: "removeItem", side: "mine", itemId: 2101, variantId: 210_777 });
    expect(removed.mine.items).toEqual([fixtureVibroswordLine()]);
    expect(reduceTradeSession(offered, { kind: "removeItem", side: "mine", itemId: 9999, variantId: 1 })).toBe(offered);
  });

  it("rejects garbage quantities and negative coin without touching state", () => {
    const offered = fixtureTradeOffered();
    expect(reduceTradeSession(offered, { kind: "addItem", side: "mine", line: fixtureHideLine(0) })).toBe(offered);
    expect(reduceTradeSession(offered, { kind: "setCoin", side: "mine", amount: -5 })).toBe(offered);
    expect(reduceTradeSession(offered, { kind: "setCoin", side: "theirs", amount: 250 })).toBe(offered); // no-op same amount
  });
});

describe("change unchecks BOTH (anti-abuse core — owner explicit)", () => {
  // Every mutation kind × every side, from the fully-sealed table: the
  // classic last-second switch must always break both seals and both OKs.
  const mutations: readonly [string, (side: TradeSideId) => TradeMachineEvent][] = [
    ["item add", (side) => ({ kind: "addItem", side, line: fixtureCopperLine(5) })],
    ["item remove", (side) => ({
      kind: "removeItem",
      side,
      itemId: side === "mine" ? 2101 : 2007,
      variantId: side === "mine" ? 210_777 : 220_118,
    })],
    ["coin change", (side) => ({ kind: "setCoin", side, amount: side === "mine" ? 25 : 200 })],
  ];

  for (const [label, eventFor] of mutations) {
    for (const side of SIDES) {
      it(`${label} by ${side} clears both locks and both confirms`, () => {
        const sealed = fixtureTradeBothLocked();
        expect(sealed.bothLocked).toBe(true);
        expectNoSeals(reduceTradeSession(sealed, eventFor(side)));
      });
    }
  }

  it("coin change during the confirm stage even revokes a given countersign", () => {
    const confirming = fixtureTradeConfirming();
    expect(confirming.theirs.confirmed).toBe(true);
    const broken = reduceTradeSession(confirming, { kind: "setCoin", side: "mine", amount: 1 });
    expectNoSeals(broken);
  });

  it("the seals-broken fixture is exactly this transition", () => {
    expectNoSeals(fixtureTradeSealsBroken());
    expect(fixtureTradeSealsBroken().theirs.coin).toBe(200);
  });
});

describe("dual-lock → OK gate", () => {
  it("one seal keeps the table negotiating; the second opens the confirm stage", () => {
    const one = fixtureTradeTheirsLocked();
    expect(one.theirs.locked).toBe(true);
    expect(one.bothLocked).toBe(false);
    expect(one.stage).toBe("negotiating");
    const both = reduceTradeSession(one, { kind: "accept", side: "mine" });
    expect(both.bothLocked).toBe(true);
    expect(both.stage).toBe("confirm");
  });

  it("accept is idempotent while already sealed", () => {
    const sealed = fixtureTradeBothLocked();
    expect(reduceTradeSession(sealed, { kind: "accept", side: "mine" })).toBe(sealed);
  });

  it("confirm before both seals is refused outright (gate holds per side)", () => {
    const open = fixtureTradeOffered();
    expect(reduceTradeSession(open, { kind: "confirm", side: "mine" })).toBe(open);
    const one = fixtureTradeTheirsLocked();
    expect(reduceTradeSession(one, { kind: "confirm", side: "theirs" })).toBe(one);
  });

  it("one countersign holds in confirm; the second executes", () => {
    const sealed = fixtureTradeBothLocked();
    const half = reduceTradeSession(sealed, { kind: "confirm", side: "theirs" });
    expect(half.stage).toBe("confirm");
    expect(half.theirs.confirmed).toBe(true);
    expect(half.mine.confirmed).toBe(false);
    const done = reduceTradeSession(half, { kind: "confirm", side: "mine" });
    expect(done.stage).toBe("executed");
  });
});

describe("terminal stages", () => {
  it("decline closes from any live stage with the close reason", () => {
    const declined = fixtureTradeDeclined();
    expect(declined.stage).toBe("declined");
    expect(declined.closeReason).toBe("declined");
    const fromOpen = reduceTradeSession(fixtureTradeOffered(), { kind: "decline", side: "mine", reason: "range" });
    expect(fromOpen.stage).toBe("declined");
    expect(fromOpen.closeReason).toBe("range");
  });

  it("terminals absorb every further event", () => {
    for (const terminal of [fixtureTradeExecuted(), fixtureTradeDeclined()]) {
      expect(reduceTradeSession(terminal, { kind: "addItem", side: "mine", line: fixtureHideLine(1) })).toBe(terminal);
      expect(reduceTradeSession(terminal, { kind: "accept", side: "theirs" })).toBe(terminal);
      expect(reduceTradeSession(terminal, { kind: "confirm", side: "mine" })).toBe(terminal);
      expect(reduceTradeSession(terminal, { kind: "decline", side: "theirs" })).toBe(terminal);
    }
  });

  it("the full happy-path script lands executed with both offers intact", () => {
    const done = fixtureTradeExecuted();
    expect(done.stage).toBe("executed");
    expect(done.mine.items).toEqual([fixtureHideLine(4), fixtureVibroswordLine()]);
    expect(done.theirs.items).toEqual([fixtureCopperLine(2)]);
    expect(done.theirs.coin).toBe(250);
  });

  it("re-seal after a broken table works (unlock → relock → execute)", () => {
    const done = runTradeScript(fixtureTradeSealsBroken(), [
      { kind: "accept", side: "mine" },
      { kind: "accept", side: "theirs" },
      { kind: "confirm", side: "theirs" },
      { kind: "confirm", side: "mine" },
    ]);
    expect(done.stage).toBe("executed");
    expect(done.theirs.coin).toBe(200);
  });
});
