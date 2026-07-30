import { describe, expect, it } from "vitest";

import type { ServerAuthorityPlacedExtractorState } from "@successor/client/src/slice-core/gameState";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import {
  EXTRACTOR_BATTERY_ITEM_ID,
  batteryRuntimeSeconds,
  bestBatteryRow,
  enqueueExtractorOrder,
  extractorLine,
  listExtractors,
  resolveExtractor,
} from "./extractors";
import { isCarriedContainer } from "./exchangeTrade";

function rig(overrides: Partial<ServerAuthorityPlacedExtractorState>): ServerAuthorityPlacedExtractorState {
  return {
    extractorId: "rig-1",
    areaId: "open-desert",
    cellX: 41,
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

describe("extractor surface", () => {
  it("lists own rigs first with full telemetry; foreign rigs stay scenery", () => {
    const { state } = createTuiPlayStateFixture();
    state.serverAuthority.placedExtractors = [
      rig({ extractorId: "far-own", cellX: 60, cellY: 60, mode: "battery", hopperPct: 42, collectableUnits: 7, batteryPct: 67 }),
      rig({ extractorId: "near-foreign", cellX: 41, cellY: 44, isOwner: false }),
    ];
    const views = listExtractors(state);
    expect(views.map((view) => view.extractor.extractorId)).toEqual(["far-own", "near-foreign"]);
    expect(extractorLine(views[0]!)).toContain("your iron extractor");
    expect(extractorLine(views[0]!)).toContain("7 units (42%)");
    expect(extractorLine(views[0]!)).toContain("battery 67%");
    const foreign = extractorLine(views[1]!);
    expect(foreign).toContain("another prospector's");
    expect(foreign).not.toContain("hopper");
  });

  it("resolves by number, by id, and bare → nearest OWN rig", () => {
    const { state } = createTuiPlayStateFixture();
    state.serverAuthority.placedExtractors = [
      rig({ extractorId: "foreign", isOwner: false, cellX: 41, cellY: 44 }),
      rig({ extractorId: "mine", cellX: 44, cellY: 47 }),
    ];
    expect(resolveExtractor(state, undefined)?.extractor.extractorId).toBe("mine");
    expect(resolveExtractor(state, "2")?.extractor.extractorId).toBe("foreign");
    expect(resolveExtractor(state, "mine")?.extractor.extractorId).toBe("mine");
    expect(resolveExtractor(state, "nope")).toBeNull();
  });

  it("ignores extractors streamed from other areas", () => {
    const { state } = createTuiPlayStateFixture();
    state.serverAuthority.placedExtractors = [rig({ areaId: "elsewhere" })];
    expect(listExtractors(state)).toEqual([]);
  });

  it("picks the highest-charge carried battery and skips unnameable stacks", () => {
    const { state, playerId } = createTuiPlayStateFixture();
    const carried = (container: string): boolean => isCarriedContainer(state, container);
    state.inventory.push(
      { container: `${playerId}:field-pack`, item: "Battery", itemId: EXTRACTOR_BATTERY_ITEM_ID, variantId: 32_000_000 + 600, quantity: 1, reserved: 0, available: 1, stackId: 41 },
      { container: `${playerId}:field-pack`, item: "Battery", itemId: EXTRACTOR_BATTERY_ITEM_ID, variantId: 32_000_000 + 7_200, quantity: 1, reserved: 0, available: 1, stackId: 42 },
      // no stackId → cannot be named in InsertBattery → skipped
      { container: `${playerId}:field-pack`, item: "Battery", itemId: EXTRACTOR_BATTERY_ITEM_ID, variantId: 32_000_000 + 86_400, quantity: 1, reserved: 0, available: 1 },
      // dead cell (no runtime encoded) → skipped
      { container: `${playerId}:field-pack`, item: "Battery", itemId: EXTRACTOR_BATTERY_ITEM_ID, variantId: 12, quantity: 1, reserved: 0, available: 1, stackId: 43 },
      // not carried (corpse loot) → skipped
      { container: "corpse:rogue-1", item: "Battery", itemId: EXTRACTOR_BATTERY_ITEM_ID, variantId: 32_000_000 + 9_999, quantity: 1, reserved: 0, available: 1, stackId: 44 },
    );
    const best = bestBatteryRow(state, carried);
    expect(best?.stackId).toBe(42);
    expect(batteryRuntimeSeconds(best!.variantId)).toBe(7_200);
  });

  it("enqueues the full command family onto the shared wire queue", () => {
    const { state, slice } = createTuiPlayStateFixture();
    state.serverAuthority.placedExtractors = [rig({})];
    const view = listExtractors(state)[0]!;
    const before = state.authorityCommands.pending.length;
    expect(enqueueExtractorOrder(state, slice, { kind: "place", family: "metal" })).toBe(true);
    expect(enqueueExtractorOrder(state, slice, { kind: "crank", view })).toBe(true);
    expect(enqueueExtractorOrder(state, slice, { kind: "stop-crank" })).toBe(true);
    expect(enqueueExtractorOrder(state, slice, { kind: "collect", view })).toBe(true);
    expect(enqueueExtractorOrder(state, slice, { kind: "destroy", view })).toBe(true);
    expect(state.authorityCommands.pending.length).toBe(before + 5);
    const kinds = state.authorityCommands.pending.map((envelope) => Object.keys(envelope.command)[0]);
    expect(kinds).toEqual(expect.arrayContaining(["PlaceExtractor", "CrankExtractor", "StopCrank", "CollectExtractor", "DestroyExtractor"]));
  });
});
