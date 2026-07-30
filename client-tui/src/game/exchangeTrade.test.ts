import { describe, expect, it } from "vitest";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import {
  createTradeNarrator,
  enqueueTradeCoin,
  enqueueTradeConfirm,
  enqueueTradeItemChange,
  isCarriedContainer,
  parseTradeLineItem,
  parseTradeProposal,
  renderTradeTable,
  resolveItem,
  tradeDeltaLines,
  type TradeLine,
} from "./exchangeTrade";
import type { ServerAuthorityTradeSessionState } from "@successor/client/src/slice-core/gameState";

function tradeVm(overrides: Partial<ServerAuthorityTradeSessionState> = {}): ServerAuthorityTradeSessionState {
  return {
    proposalId: 1,
    partnerActorId: "petra",
    mine: { actorId: "marlow", items: [{ itemId: 1001, variantId: 0, name: "Stimpak A", quantity: 2 }], coin: 0, locked: false, confirmed: false },
    theirs: { actorId: "petra", items: [{ itemId: 2001, variantId: 219954, name: "Iron Resource Container", quantity: 5 }], coin: 0, locked: false, confirmed: false },
    bothLocked: false,
    stage: "negotiating",
    closeReason: null,
    tick: 4500,
    ...overrides,
  };
}

const joined = (lines: TradeLine[]): string => lines.map((line) => line.text).join("\n");

describe("exchange + trade grammar", () => {
  it("carried gate: own + identity containers pass, exchange/corpse/foreign fail", () => {
    const { state, playerId, characterId } = createTuiPlayStateFixture();
    expect(isCarriedContainer(state, `${playerId}:field-pack`)).toBe(true);
    expect(isCarriedContainer(state, playerId)).toBe(true);
    expect(isCarriedContainer(state, `${characterId}:pouch`)).toBe(false); // identity id unknown to bare state…
    expect(isCarriedContainer(state, `${characterId}:pouch`, [characterId])).toBe(true); // …until the session supplies it
    expect(isCarriedContainer(state, "district-exchange")).toBe(false);
    expect(isCarriedContainer(state, "corpse:rogue-1")).toBe(false);
    expect(isCarriedContainer(state, "other-player:field-pack")).toBe(false);
  });

  it("resolveItem: exact name beats substring; numeric id beats both; filter applies", () => {
    const { state, characterId } = createTuiPlayStateFixture();
    const carried = (container: string): boolean => isCarriedContainer(state, container, [characterId]);
    expect(resolveItem(state, "stimpak a", (row) => carried(row.container))?.row.itemId).toBe(1001);
    expect(resolveItem(state, "stim", (row) => carried(row.container))?.row.itemId).toBe(1001);
    expect(resolveItem(state, "3001", (row) => carried(row.container))?.row.item).toBe("Survey Tool");
    // the plasma sword exists only in a foreign container — carried filter refuses it
    expect(resolveItem(state, "plasma", (row) => carried(row.container))).toBeNull();
  });

  it("parses the give/for grammar with ×|:|x quantities and echoes human labels", () => {
    const { state } = createTuiPlayStateFixture();
    const carried = (container: string): boolean => isCarriedContainer(state, container);
    const parsed = parseTradeProposal(state, ["Rusk", "give", "stimpak:2", "for", "1101×1"], carried);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.partnerToken).toBe("Rusk");
    expect(parsed.offer.items).toEqual([{ item_id: 1001, variant_id: 0, quantity: 2 }]);
    expect(parsed.offer.echo).toBe("Stimpak A ×2");
    expect(parsed.request.items[0]!.item_id).toBe(1101);
  });

  it("refuses malformed shapes with speakable errors", () => {
    const { state } = createTuiPlayStateFixture();
    const carried = (container: string): boolean => isCarriedContainer(state, container);
    expect(parseTradeProposal(state, [], carried)).toHaveProperty("error");
    expect(parseTradeProposal(state, ["Rusk", "stimpak:2"], carried)).toHaveProperty("error");
    expect(parseTradeProposal(state, ["Rusk", "give", "for", "x"], carried)).toHaveProperty("error");
    expect(parseTradeProposal(state, ["Rusk", "give", "unobtainium:1", "for", "1101"], carried)).toHaveProperty("error");
  });

  it("double-lock moves compose the car-5 wire shapes (proposal-id keyed)", () => {
    const { state, slice } = createTuiPlayStateFixture();
    const carried = (container: string): boolean => isCarriedContainer(state, container);
    const parsed = parseTradeLineItem(state, ["stimpak:2"], carried);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.echo).toBe("Stimpak A ×2");
    expect(enqueueTradeItemChange(state, slice, true, 7, parsed.item)).toBe(true);
    expect(enqueueTradeItemChange(state, slice, false, 7, parsed.item)).toBe(true);
    expect(enqueueTradeCoin(state, slice, 7, 25)).toBe(true);
    expect(enqueueTradeConfirm(state, slice, 7)).toBe(true);
    const kinds = state.authorityCommands.pending.map((envelope) => Object.keys(envelope.command)[0]);
    expect(kinds).toEqual(expect.arrayContaining(["AddTradeItem", "RemoveTradeItem", "SetTradeCoin", "ConfirmTrade"]));
    const add = state.authorityCommands.pending.find((envelope) => "AddTradeItem" in envelope.command);
    if (add && "AddTradeItem" in add.command) {
      expect(add.command.AddTradeItem).toEqual({ proposal_id: 7, item: { item_id: 1001, variant_id: 0, quantity: 2 } });
    }
  });

  it("double-lock guards: one item per move, 1-based ids, non-carried refused", () => {
    const { state, slice } = createTuiPlayStateFixture();
    const carried = (container: string): boolean => isCarriedContainer(state, container);
    expect(parseTradeLineItem(state, ["stimpak:1", "1101:1"], carried)).toHaveProperty("error");
    expect(parseTradeLineItem(state, ["plasma:1"], carried)).toHaveProperty("error");
    const parsed = parseTradeLineItem(state, ["stimpak:1"], carried);
    if ("error" in parsed) return;
    expect(enqueueTradeItemChange(state, slice, true, 0, parsed.item)).toBe(false);
    expect(enqueueTradeConfirm(state, slice, 0)).toBe(false);
    expect(enqueueTradeCoin(state, slice, 7, -3)).toBe(false);
  });

  it("table render: sides, states, id-taught moves; sealed tables close the help", () => {
    const open = renderTradeTable(tradeVm(), "Petra");
    expect(joined(open)).toContain("TRADE — offer 1 with «Petra» · NEGOTIATING");
    expect(joined(open)).toContain("yours  — Stimpak A ×2   [open]");
    expect(joined(open)).toContain("theirs — Iron Resource Container ×5   [open]");
    expect(joined(open)).toContain("/trade add|remove 1 <item:qty>");
    const sealed = renderTradeTable(tradeVm({ stage: "executed" }), "Petra");
    expect(joined(sealed)).toContain("Done and dusted");
    expect(joined(sealed)).not.toContain("/trade add|remove");
  });

  it("delivery diffs speak the table opening with the offer id", () => {
    const lines = tradeDeltaLines(null, tradeVm(), "Petra");
    expect(joined(lines)).toContain("«Petra» is at the table — offer 1");
    expect(joined(lines)).toContain("/trade accept 1 locks your side");
  });

  it("partner moves speak; own moves stay silent; their change pops the locks aloud", () => {
    const locked = tradeVm({
      mine: { ...tradeVm().mine, locked: true },
      theirs: { ...tradeVm().theirs, locked: true },
      bothLocked: true,
    });
    const popped = tradeVm({
      theirs: { ...tradeVm().theirs, coin: 5 },
    });
    const lines = tradeDeltaLines(locked, popped, "Petra");
    expect(joined(lines)).toContain("puts 5 credits on the table");
    expect(joined(lines)).toContain("the locks come off");
    const mineLocks = tradeVm({ mine: { ...tradeVm().mine, locked: true } });
    expect(tradeDeltaLines(tradeVm(), mineLocks, "Petra")).toEqual([]);
  });

  it("lock, both-locked hint, hand-down, and the executed handshake all beat", () => {
    const base = tradeVm({ mine: { ...tradeVm().mine, locked: true } });
    const theirsLock = tradeVm({
      mine: { ...tradeVm().mine, locked: true },
      theirs: { ...tradeVm().theirs, locked: true },
      bothLocked: true,
    });
    const locked = tradeDeltaLines(base, theirsLock, "Petra");
    expect(joined(locked)).toContain("«Petra» locks their side.");
    expect(joined(locked)).toContain("/trade confirm 1 seals it");
    const handDown = tradeDeltaLines(theirsLock, tradeVm({
      mine: { ...theirsLock.mine },
      theirs: { ...theirsLock.theirs, confirmed: true },
      bothLocked: true,
      stage: "confirm",
    }), "Petra");
    expect(joined(handDown)).toContain("«Petra»'s hand comes down.");
    const done = tradeDeltaLines(theirsLock, tradeVm({ stage: "executed" }), "Petra");
    expect(joined(done)).toContain("Hands shake — the trade is done.");
  });

  it("close reasons speak honestly; the narrator caches deliveries", () => {
    const range = tradeDeltaLines(tradeVm(), tradeVm({ stage: "declined", closeReason: "range" }), "Petra");
    expect(joined(range)).toContain("The table breaks — too far apart.");
    let current: ServerAuthorityTradeSessionState | null = tradeVm();
    const narrator = createTradeNarrator(() => current, () => "Petra");
    expect(joined(narrator.render())).toContain("is at the table");
    current = tradeVm({ theirs: { ...tradeVm().theirs, locked: true } });
    expect(joined(narrator.render())).toContain("locks their side");
    current = null;
    expect(joined(narrator.render())).toContain("The trade table is gone.");
  });
});
