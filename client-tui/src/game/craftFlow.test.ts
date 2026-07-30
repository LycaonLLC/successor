import { describe, expect, it } from "vitest";

import { createMacroEngine } from "@successor/client/src/slice-core/macroEngine/index";
import { createVerbRegistry } from "@successor/client/src/slice-core/verbRegistry/index";
import { craftResultWord } from "@successor/client/src/slice-core/craftResultBands";
import type { ServerAuthorityCraftSessionState } from "@successor/client/src/slice-core/gameState";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { createArmedConfirm } from "./armedConfirm";
import { createContactTracker } from "./contacts";
import { createCraftNarrator, craftSessionVmFromState, routeCraftFlow } from "./craftFlow";
import { isCarriedContainer } from "./exchangeTrade";
import { createSurveyStore } from "./surveyStore";
import type { GameSession } from "./session";

function fakeSession(): GameSession {
  const { state, slice } = createTuiPlayStateFixture();
  const registry = createVerbRegistry({ state, slice });
  const session: GameSession = {
    state,
    slice,
    registry,
    macros: createMacroEngine({ registry }),
    survey: createSurveyStore(),
    tracker: createContactTracker(),
    chat: null,
    defineMacro() {},
    removeMacro: () => false,
    listMacroDefs: () => [],
    isCarried: (container) => isCarriedContainer(state, container),
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
  return session;
}

function browserState(): ServerAuthorityCraftSessionState {
  return {
    phase: "browser" as ServerAuthorityCraftSessionState["phase"],
    recipeId: null,
    recipes: [
      { recipeId: "extractor-battery", name: "Extractor Battery", category: "component", outputItemId: 3201, outputPreviewVariantId: 0, unlocked: true, requiredToolItemId: 3001, requiredProfession: "craftsman", handsCraftable: false, source: "trained" },
      { recipeId: "field-bandage", name: "Field Bandage", category: "supply", outputItemId: 1002, outputPreviewVariantId: 0, unlocked: true, requiredToolItemId: 3001, requiredProfession: "medic", handsCraftable: true, source: "trained" },
    ],
    detail: null,
    slotScreen: null,
    assembled: null,
    tick: 4500,
  };
}

function slotsState(): ServerAuthorityCraftSessionState {
  return {
    ...browserState(),
    phase: "slots",
    recipeId: "extractor-battery",
    detail: {
      recipeId: "extractor-battery",
      outputItemId: 3201,
      outputPreviewVariantId: 0,
      slots: [{ slotIndex: 0, symbol: "⚡", resourceKindLabel: "Conductor (copper)", requiredItemId: 2007, requiredFamily: "copper", requirementKind: "material_family", requiredItemName: "Copper", requiredQty: 4, craftRelevantStat: "conductivity" }],
      statLines: [{ lineId: 1, label: "Charge", capEstimateMilli: 618 }],
    },
    slotScreen: {
      recipeId: "extractor-battery",
      canAssemble: false,
      slots: [{
        slotIndex: 0,
        symbol: "⚡",
        resourceKindLabel: "Conductor (copper)",
        requiredQty: 4,
        requiredItemId: 2007,
        requiredFamily: "copper",
        requirementKind: "material_family",
        requiredItemName: "Copper",
        eligible: [
          { container: "observer:field-pack", stackId: "31", itemId: 2004, variantId: 225357, name: "Vexhollow copper", qtyAvailable: 8, craftRelevantStatValue: 997, recommended: true, stats: { conductivity: 997, malleability: 306, shock_resistance: 935, thermal_resistance: 859, chemical_purity: 0, density: 464, tensile_strength: 703, flexibility: 0, potency: 0, nutrition: 0, stability: 900, extraction_yield: 910 } },
        ],
        assigned: null,
      }],
    },
  };
}

function assembledState(points: number, chargeMilli: number): ServerAuthorityCraftSessionState {
  return {
    ...browserState(),
    phase: "assembled",
    recipeId: "extractor-battery",
    assembled: {
      recipeId: "extractor-battery",
      assemblyQualityMilli: 780,
      experimentationPointsRemaining: points,
      outputPreviewVariantId: 0,
      lines: [{ lineId: 1, label: "Charge", valueMilli: chargeMilli, capMilli: 618, canRaise: chargeMilli < 618 }],
    },
    tick: 4600,
  };
}

describe("craft flow over the streamed session state", () => {
  it("/craft list renders the streamed recipe ledger, numbered", () => {
    const session = fakeSession();
    const lines = routeCraftFlow(session, createArmedConfirm(), browserState, ["list"]);
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("1. Extractor Battery — component");
    expect(text).toContain("2. Field Bandage — supply · hands-craftable");
  });

  it("/craft begin 1 resolves the number to the streamed recipe id", () => {
    const session = fakeSession();
    routeCraftFlow(session, createArmedConfirm(), browserState, ["begin", "1"]);
    const begin = session.state.authorityCommands.pending.find((envelope) => "CraftBegin" in envelope.command);
    expect(begin).toBeDefined();
    if (begin && "CraftBegin" in begin.command) {
      expect(begin.command.CraftBegin).toEqual({ recipe_id: "extractor-battery" });
    }
  });

  it("/craft fill auto assigns the bench pick through the wire", () => {
    const session = fakeSession();
    const lines = routeCraftFlow(session, createArmedConfirm(), slotsState, ["fill", "auto"]);
    expect(lines[0]!.text).toMatch(/QUEUED/i);
    const assign = session.state.authorityCommands.pending.find((envelope) => "CraftAssignSlot" in envelope.command);
    expect(assign).toBeDefined();
    if (assign && "CraftAssignSlot" in assign.command) {
      expect(assign.command.CraftAssignSlot).toMatchObject({ slot_index: 0, stack_id: "31", variant_id: 225357 });
    }
  });

  it("/craft fill auto never guesses when no lot carries the bench flag", () => {
    const session = fakeSession();
    const noFlag = (): ServerAuthorityCraftSessionState => {
      const state = slotsState();
      const slot = state.slotScreen!.slots[0]!;
      return {
        ...state,
        slotScreen: {
          ...state.slotScreen!,
          slots: [{ ...slot, eligible: slot.eligible.map((option) => ({ ...option, recommended: false })) }],
        },
      };
    };
    const lines = routeCraftFlow(session, createArmedConfirm(), noFlag, ["fill", "auto"]);
    expect(lines[0]!.text).toContain("the bench offers no pick");
    expect(lines[0]!.text).toContain("/craft fill 1 <n>");
    expect(session.state.authorityCommands.pending.some((envelope) => "CraftAssignSlot" in envelope.command)).toBe(false);
  });

  it("adapter joins craftRelevantStat from the detail spec into slot fills", () => {
    const vm = craftSessionVmFromState(slotsState());
    expect(vm?.slotScreen?.slots[0]?.craftRelevantStat).toBe("conductivity");
  });

  it("narrator diffs refreshed assembled VMs into experiment-delta prose", () => {
    const session = fakeSession();
    let current = assembledState(7, 412);
    const narrator = createCraftNarrator(session, () => current);
    narrator.render(); // prime lastAssembled
    current = assembledState(5, 466);
    const lines = narrator.render();
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("You lean on CHARGE — 412 → 466. 2 points spent, 5 remain.");
    expect(text).toContain(`${craftResultWord(780)} work (quality 78%)`);
  });

  it("narrator wants renders only for session-shaping kinds", () => {
    const session = fakeSession();
    const narrator = createCraftNarrator(session, () => null);
    expect(narrator.wantsRender("CraftBegin")).toBe(true);
    expect(narrator.wantsRender("CraftExperiment")).toBe(true);
    expect(narrator.wantsRender("CraftFinalizePrototype")).toBe(false);
    expect(narrator.wantsRender("QueueCombatAction")).toBe(false);
  });
});
