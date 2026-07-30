import { describe, expect, it } from "vitest";
import {
  clampTradeCoin,
  composeTradeView,
  TRADE_GRID_COLUMNS,
  TRADE_GRID_MIN_ROWS,
} from "./composers";
import { TRADE_COPY } from "./copy";
import {
  FIXTURE_PARTNER_NAME,
  fixtureHideLine,
  fixtureTradeBothLocked,
  fixtureTradeConfirming,
  fixtureTradeDeclined,
  fixtureTradeExecuted,
  fixtureTradeOffered,
  fixtureTradeOpen,
  fixtureTradeSealsBroken,
  fixtureTradeTheirsLocked,
} from "./fixtures";
import { runTradeScript } from "./machine";

const NO_SELECTION = { selection: null, heldCoin: 1_250 };

describe("columns", () => {
  it("renders a closed view for a null session", () => {
    const view = composeTradeView(null, NO_SELECTION);
    expect(view.open).toBe(false);
    expect(view.ctas.accept.visible).toBe(false);
    expect(view.ctas.decline.label).toBe(TRADE_COPY.cta.close);
  });

  it("squares each grid to the 3×2 minimum and titles theirs by partner name", () => {
    const view = composeTradeView(fixtureTradeOffered(), NO_SELECTION);
    expect(view.mine.title).toBe(TRADE_COPY.mineTitle);
    expect(view.theirs.title).toBe(FIXTURE_PARTNER_NAME.toUpperCase());
    expect(view.mine.cells.length + view.mine.emptyCount).toBe(TRADE_GRID_COLUMNS * TRADE_GRID_MIN_ROWS);
    expect(view.theirs.cells.length + view.theirs.emptyCount).toBe(TRADE_GRID_COLUMNS * TRADE_GRID_MIN_ROWS);
    // Overflow grows by whole rows.
    const stuffed = runTradeScript(fixtureTradeOffered(), [
      { kind: "addItem", side: "mine", line: { itemId: 1001, variantId: 0, name: "Stimpak A", quantity: 2 } },
      { kind: "addItem", side: "mine", line: { itemId: 2001, variantId: 210_218, name: "Daxmire Iron", quantity: 6 } },
      { kind: "addItem", side: "mine", line: { itemId: 2003, variantId: 216_100, name: "Scrub Flora", quantity: 3 } },
      { kind: "addItem", side: "mine", line: { itemId: 3001, variantId: 0, name: "Field Multitool", quantity: 1 } },
      { kind: "addItem", side: "mine", line: { itemId: 2103, variantId: 0, name: "Clodbone", quantity: 7 } },
    ]);
    const grown = composeTradeView(stuffed, NO_SELECTION);
    expect(grown.mine.cells.length).toBe(7);
    expect((grown.mine.cells.length + grown.mine.emptyCount) % TRADE_GRID_COLUMNS).toBe(0);
  });

  it("marks my cells removable and coin editable — theirs read-only", () => {
    const view = composeTradeView(fixtureTradeOffered(), NO_SELECTION);
    expect(view.mine.cells.every((cell) => cell.removable)).toBe(true);
    expect(view.theirs.cells.every((cell) => !cell.removable)).toBe(true);
    expect(view.mine.coinEditable).toBe(true);
    expect(view.theirs.coinEditable).toBe(false);
    expect(view.mine.heldLine).toBe(TRADE_COPY.coin.held(1_250));
    expect(view.theirs.heldLine).toBeNull();
    expect(view.theirs.coinText).toBe("250");
  });

  it("count badges only on stacks above one", () => {
    const view = composeTradeView(fixtureTradeOffered(), NO_SELECTION);
    const hide = view.mine.cells.find((cell) => cell.itemId === 2101)!;
    const sword = view.mine.cells.find((cell) => cell.itemId === 3103)!;
    expect(hide.countText).toBe("\u00d74");
    expect(sword.countText).toBeNull();
  });

  it("nothing is removable and coin goes read-only once the table closes", () => {
    const view = composeTradeView(fixtureTradeExecuted(), NO_SELECTION);
    expect(view.mine.cells.every((cell) => !cell.removable)).toBe(true);
    expect(view.mine.coinEditable).toBe(false);
  });
});

describe("selection → preview", () => {
  it("resolves the selected line into the preview cell", () => {
    const view = composeTradeView(fixtureTradeOffered(), {
      selection: { side: "theirs", itemId: 2007, variantId: 220_118 },
      heldCoin: 0,
    });
    expect(view.previewCell?.name).toBe("Ashfall Copper");
    expect(view.previewCell?.side).toBe("theirs");
    expect(view.selection).toEqual({ side: "theirs", itemId: 2007, variantId: 220_118 });
  });

  it("drops a selection whose line left the table", () => {
    const view = composeTradeView(fixtureTradeOpen(), {
      selection: { side: "mine", itemId: 2101, variantId: 210_777 },
      heldCoin: 0,
    });
    expect(view.selection).toBeNull();
    expect(view.previewCell).toBeNull();
  });
});

describe("lock-state CTAs (the double-lock rendered)", () => {
  it("negotiating: ACCEPT armed, no CONFIRM", () => {
    const view = composeTradeView(fixtureTradeOffered(), NO_SELECTION);
    expect(view.ctas.accept).toMatchObject({ visible: true, enabled: true, stateLine: null });
    expect(view.ctas.confirm.visible).toBe(false);
    expect(view.ctas.decline.label).toBe(TRADE_COPY.cta.decline);
    expect(view.stageLine).toBe(TRADE_COPY.stage.negotiating);
  });

  it("my seal disables ACCEPT with the awaiting line; their seal shows the stamp", () => {
    const mineSealed = runTradeScript(fixtureTradeOffered(), [{ kind: "accept", side: "mine" }]);
    const view = composeTradeView(mineSealed, NO_SELECTION);
    expect(view.ctas.accept).toMatchObject({ visible: true, enabled: false, stateLine: TRADE_COPY.cta.acceptSealed });
    expect(view.mine.sealText).toBe(TRADE_COPY.seal.locked);
    expect(view.theirs.sealText).toBeNull();

    const theirsSealed = composeTradeView(fixtureTradeTheirsLocked(), NO_SELECTION);
    expect(theirsSealed.theirs.sealText).toBe(TRADE_COPY.seal.locked);
    expect(theirsSealed.ctas.accept.enabled).toBe(true);
  });

  it("both sealed: CONFIRM replaces ACCEPT (the dual-lock gate rendered)", () => {
    const view = composeTradeView(fixtureTradeBothLocked(), NO_SELECTION);
    expect(view.ctas.accept.visible).toBe(false);
    expect(view.ctas.confirm).toMatchObject({ visible: true, enabled: true });
    expect(view.mine.sealText).toBe(TRADE_COPY.seal.locked);
    expect(view.theirs.sealText).toBe(TRADE_COPY.seal.locked);
  });

  it("their countersign stamps their column; mine disables CONFIRM once given", () => {
    const half = composeTradeView(fixtureTradeConfirming(), NO_SELECTION);
    expect(half.theirs.sealText).toBe(TRADE_COPY.seal.confirmed);
    expect(half.ctas.confirm.enabled).toBe(true);
    const givenMine = runTradeScript(fixtureTradeBothLocked(), [{ kind: "confirm", side: "mine" }]);
    const view = composeTradeView(givenMine, NO_SELECTION);
    expect(view.ctas.confirm).toMatchObject({ enabled: false, stateLine: TRADE_COPY.cta.confirmGiven });
  });

  it("a broken table renders with no seals and ACCEPT re-armed", () => {
    const view = composeTradeView(fixtureTradeSealsBroken(), NO_SELECTION);
    expect(view.mine.sealText).toBeNull();
    expect(view.theirs.sealText).toBeNull();
    expect(view.ctas.accept).toMatchObject({ visible: true, enabled: true });
  });

  it("terminal banners: executed and declined with reason line, CTA collapses to CLOSE", () => {
    const done = composeTradeView(fixtureTradeExecuted(), NO_SELECTION);
    expect(done.banner).toMatchObject({ kind: "executed", title: TRADE_COPY.executed.title });
    expect(done.ctas.accept.visible).toBe(false);
    expect(done.ctas.confirm.visible).toBe(false);
    expect(done.ctas.decline.label).toBe(TRADE_COPY.cta.close);

    const closed = composeTradeView(fixtureTradeDeclined(), NO_SELECTION);
    expect(closed.banner.kind).toBe("declined");
    expect(closed.banner.line.length).toBeGreaterThan(0);
  });
});

describe("coin clamp", () => {
  it("stages only whole, non-negative, wallet-covered coin", () => {
    expect(clampTradeCoin(250.9, 1_000)).toBe(250);
    expect(clampTradeCoin(-4, 1_000)).toBe(0);
    expect(clampTradeCoin(Number.NaN, 1_000)).toBe(0);
    expect(clampTradeCoin(5_000, 1_250)).toBe(1_250);
  });
});

describe("machine ↔ composer seam", () => {
  it("adding a line while sealed re-renders as a fresh negotiating table", () => {
    const changed = runTradeScript(fixtureTradeBothLocked(), [
      { kind: "addItem", side: "theirs", line: fixtureHideLine(1) },
    ]);
    const view = composeTradeView(changed, NO_SELECTION);
    expect(view.stageLine).toBe(TRADE_COPY.stage.negotiating);
    expect(view.theirs.cells.some((cell) => cell.itemId === 2101)).toBe(true);
    expect(view.ctas.accept.enabled).toBe(true);
  });
});
