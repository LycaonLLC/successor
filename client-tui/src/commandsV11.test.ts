import { describe, expect, it } from "vitest";

import { createMacroEngine } from "@successor/client/src/slice-core/macroEngine/index";
import { createVerbRegistry } from "@successor/client/src/slice-core/verbRegistry/index";
import type { ServerAuthorityPlacedExtractorState } from "@successor/client/src/slice-core/gameState";

import { TUI_FIXTURE_CHARACTER_ID, createTuiPlayStateFixture } from "../test/fixtures/playState";
import { routeLine, type RouterContext } from "./commands";
import { createArmedConfirm } from "./game/armedConfirm";
import { createContactTracker } from "./game/contacts";
import { createConverseSession } from "./game/converse";
import { EXTRACTOR_BATTERY_ITEM_ID } from "./game/extractors";
import { createPursuitController } from "./game/pursue";
import { createSurveyStore } from "./game/surveyStore";
import { isCarriedContainer } from "./game/exchangeTrade";
import type { GameSession } from "./game/session";

function rig(overrides: Partial<ServerAuthorityPlacedExtractorState>): ServerAuthorityPlacedExtractorState {
  return {
    extractorId: "rig-1",
    areaId: "open-desert",
    cellX: 40,
    cellY: 44,
    mode: "idle",
    biome: "desert",
    hopperPct: 0,
    collectableUnits: 0,
    batteryPct: 0,
    isOwner: true,
    familyLabel: "Iron",
    ...overrides,
  };
}
function liveContext(): { context: RouterContext; session: GameSession } {
  const { state, slice } = createTuiPlayStateFixture();
  const registry = createVerbRegistry({ state, slice });
  const macroLibrary = new Map<string, { name: string; body: string }>();
  const session: GameSession = {
    state,
    slice,
    registry,
    macros: createMacroEngine({ registry }),
    survey: createSurveyStore(),
    tracker: createContactTracker(),
    chat: null,
    defineMacro(name, body) {
      macroLibrary.set(name.toLowerCase(), { name, body });
    },
    removeMacro: (name) => macroLibrary.delete(name.toLowerCase()),
    listMacroDefs: () => [...macroLibrary.values()],
    isCarried: (container) => isCarriedContainer(state, container, [TUI_FIXTURE_CHARACTER_ID]),
    async start() {},
    async dispose() {},
    onEvent: () => () => {},
    estimatedTick: () => 4512,
    executeVerb: (line) => registry.executeLine(line),
    sendChat() {},
    holdDirection() {},
    walk() {},
    stopMovement() {},
    moving: () => false,
    queueEventsSince: (seq) => ({ seq, events: [] }),
  };
  session.tracker.update(state);
  return {
    context: {
      session,
      quitRequested: () => {},
      converse: createConverseSession(state, slice, session.isCarried),
      confirm: createArmedConfirm(),
      pursue: createPursuitController(session),
      craftSession: () => null,
      groupView: () => ({ group: null, members: [], pendingInvite: null }),
      tradeSession: () => null,
    },
    session,
  };
}

describe("v1.1 router families", () => {
  it("/extractors lists rigs; /extractor crank targets by number", () => {
    const { context, session } = liveContext();
    session.state.serverAuthority.placedExtractors = [rig({ mode: "idle", hopperPct: 12 })];
    const listing = routeLine(context, "/extractors");
    expect(listing.lines[0]!.text).toContain("your iron extractor");
    const before = session.state.authorityCommands.pending.length;
    const crank = routeLine(context, "/extractor crank 1");
    expect(crank.lines[0]!.text).toMatch(/take hold of the crank/);
    expect(session.state.authorityCommands.pending.length).toBe(before + 1);
  });

  it("/extractor packup with held yield arms, then confirms on repeat", () => {
    const { context, session } = liveContext();
    session.state.serverAuthority.placedExtractors = [rig({ hopperPct: 40 })];
    const first = routeLine(context, "/extractor packup 1");
    expect(first.lines[0]!.register).toBe("reject");
    expect(first.lines[0]!.text).toMatch(/forfeits the hopper \(40% held\)/);
    expect(session.state.authorityCommands.pending.length).toBe(0);
    const second = routeLine(context, "/extractor packup 1");
    expect(second.lines[0]!.text).toMatch(/breaking the rig down/);
    expect(session.state.authorityCommands.pending.length).toBe(1);
  });

  it("an unrelated command between packup attempts disarms the confirm", () => {
    const { context, session } = liveContext();
    session.state.serverAuthority.placedExtractors = [rig({ hopperPct: 40 })];
    routeLine(context, "/extractor packup 1");
    routeLine(context, "/where");
    const again = routeLine(context, "/extractor packup 1");
    expect(again.lines[0]!.text).toMatch(/forfeits the hopper/); // re-armed, not confirmed
    expect(session.state.authorityCommands.pending.length).toBe(0);
  });

  it("/extractor battery refuses honestly without a charged carried cell, then seats one", () => {
    const { context, session } = liveContext();
    const playerId = session.state.serverAuthority.playerActorId!;
    session.state.serverAuthority.placedExtractors = [rig({})];
    const dry = routeLine(context, "/extractor battery 1");
    expect(dry.lines[0]!.text).toMatch(/NO BATTERY/);
    session.state.inventory.push({
      container: `${playerId}:field-pack`,
      item: "Battery",
      itemId: EXTRACTOR_BATTERY_ITEM_ID,
      variantId: 32_000_000 + 3_600,
      quantity: 1,
      reserved: 0,
      available: 1,
      stackId: 9,
    });
    const wet = routeLine(context, "/extractor battery 1");
    expect(wet.lines[0]!.text).toMatch(/1h battery/);
    expect(session.state.authorityCommands.pending.some((envelope) => "InsertBattery" in envelope.command)).toBe(true);
  });

  it("/exchange stores carried stacks and retrieves ledger rows by number", () => {
    const { context, session } = liveContext();
    const store = routeLine(context, "/exchange store stimpak 2");
    expect(store.lines[0]!.text).toMatch(/hand Stimpak A ×2 across the counter/);
    const list = routeLine(context, "/exchange list");
    expect(list.lines.map((line) => line.text).join("\n")).toContain("Mission Chit");
    const retrieve = routeLine(context, "/exchange retrieve 1");
    expect(retrieve.lines[0]!.text).toMatch(/call Mission Chit ×1 back/);
    const kinds = session.state.authorityCommands.pending.map((envelope) => Object.keys(envelope.command)[0]);
    expect(kinds).toEqual(["StoreToExchange", "RetrieveFromExchange"]);
  });

  it("/trade propose composes escrow readback against a scoped contact", () => {
    const { context, session } = liveContext();
    const outcome = routeLine(context, "/trade propose rogue give stimpak:2 for 1101:1");
    expect(outcome.lines[0]!.text).toMatch(/You offer Rogue trooper: Stimpak A ×2 — asking Rogue Carbine ×1/);
    const proposal = session.state.authorityCommands.pending.find((envelope) => "ProposeTrade" in envelope.command);
    expect(proposal).toBeDefined();
  });

  it("/trade with plain words talks the trade channel instead", () => {
    const { context } = liveContext();
    const outcome = routeLine(context, "/trade selling iron cheap");
    expect(outcome.lines).toEqual([]); // routed to chat, no local echo
  });

  it("/trade double-lock family: accept speaks lock truth; add/coin/confirm compose the car-5 wire", () => {
    const { context, session } = liveContext();
    expect(routeLine(context, "/trade accept 7").lines[0]!.text).toMatch(/lock your side .*confirm seals it/i);
    expect(routeLine(context, "/trade add 7 stimpak:1").lines[0]!.text).toMatch(/set Stimpak A ×1 on the table — both locks clear/);
    expect(routeLine(context, "/trade credits 7 25").lines[0]!.text).toMatch(/put 25 credits on the table/);
    expect(routeLine(context, "/trade confirm 7").lines[0]!.text).toMatch(/bring your hand down/);
    expect(routeLine(context, "/trade confirm 0").lines[0]!.text).toMatch(/Which offer\?/);
    const kinds = session.state.authorityCommands.pending.map((envelope) => Object.keys(envelope.command)[0]);
    expect(kinds).toEqual(expect.arrayContaining(["AcceptTrade", "AddTradeItem", "SetTradeCoin", "ConfirmTrade"]));
  });

  it("/travel list names the fixture terminal and its distance", () => {
    const { context } = liveContext();
    const outcome = routeLine(context, "/travel list");
    const text = outcome.lines.map((line) => line.text).join("\n");
    expect(text).toContain("No travel catalog on this shard.");
    expect(text).toContain("Travel terminal");
  });
});
