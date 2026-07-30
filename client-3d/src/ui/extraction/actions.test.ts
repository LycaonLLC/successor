import { describe, expect, it } from "vitest";
import type { InventoryRow, ServerAuthorityPlacedExtractorState } from "@successor/client/src/slice-core/gameState";
import type { RadialAction } from "../windows/contextRadial";
import {
  batteryRuntimeSeconds,
  bestBatteryRow,
  extractionReceiptCopy,
  extractorRadialActions,
  formatBatteryRuntime,
  sampleCooldownToast,
  samplerPlateTag,
  ticksToSeconds,
} from "./actions";

const BATTERY_BASE = 32_000_000;

function batteryRow(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    container: "player:field-pack",
    item: "Extractor Battery",
    itemId: 3201,
    variantId: BATTERY_BASE + 3600,
    quantity: 1,
    reserved: 0,
    available: 1,
    stackId: 7,
    ...overrides,
  };
}

function extractor(overrides: Partial<ServerAuthorityPlacedExtractorState> = {}): ServerAuthorityPlacedExtractorState {
  return {
    extractorId: "extractor:player:1",
    areaId: "open-desert",
    cellX: 10,
    cellY: 12,
    mode: "idle",
    biome: "desert",
    hopperPct: 0,
    collectableUnits: 0,
    batteryPct: 0,
    isOwner: true,
    familyLabel: "metal",
    ...overrides,
  };
}

function actionById(actions: readonly RadialAction[], id: string): RadialAction {
  const found = actions.find((action) => action.id === id);
  if (!found) throw new Error(`missing radial action ${id}`);
  return found;
}

describe("battery charge encoding", () => {
  it("decodes runtime seconds from the variant id and clamps the cap", () => {
    expect(batteryRuntimeSeconds(BATTERY_BASE + 7200)).toBe(7200);
    expect(batteryRuntimeSeconds(BATTERY_BASE + 90_000_000)).toBe(86_400);
    expect(batteryRuntimeSeconds(BATTERY_BASE)).toBe(0);
    expect(batteryRuntimeSeconds(0)).toBe(0);
    expect(batteryRuntimeSeconds(1.5)).toBe(0);
  });

  it("formats charge in the largest sensible unit", () => {
    expect(formatBatteryRuntime(86_400)).toBe("24H");
    expect(formatBatteryRuntime(3600)).toBe("1H");
    expect(formatBatteryRuntime(90)).toBe("2M");
    expect(formatBatteryRuntime(45)).toBe("45S");
  });
});

describe("bestBatteryRow", () => {
  const carried = (container: string) => container.startsWith("player:");

  it("prefers the fullest charge among carried, stack-addressable rows", () => {
    const low = batteryRow({ variantId: BATTERY_BASE + 60, stackId: 1 });
    const high = batteryRow({ variantId: BATTERY_BASE + 86_400, stackId: 2 });
    expect(bestBatteryRow([low, high], carried)).toBe(high);
  });

  it("skips foreign containers, stackless rows, dead cells and empty rows", () => {
    const foreign = batteryRow({ container: "corpse:npc-1" });
    const stackless = batteryRow({ stackId: undefined });
    const dead = batteryRow({ variantId: BATTERY_BASE });
    const empty = batteryRow({ available: 0 });
    const wrongItem = batteryRow({ itemId: 3006 });
    expect(bestBatteryRow([foreign, stackless, dead, empty, wrongItem], carried)).toBeNull();
  });
});

describe("extractorRadialActions", () => {
  it("idle in reach: crank + insert enabled, collect live without a % claim", () => {
    const actions = extractorRadialActions({
      extractor: extractor(),
      distanceCells: 1.0,
      battery: batteryRow(),
      confirmDestroy: false,
    });
    expect(actionById(actions, "crank").enabled).toBe(true);
    const insert = actionById(actions, "insert-battery");
    expect(insert.enabled).toBe(true);
    expect(insert.label).toBe("INSERT BATTERY · 1H");
    // hopperPct floors on the wire — pct 0 may hide sub-1% yield, so the
    // verb stays live (server receipt owns the empty case) and the label
    // makes no % claim.
    const collect = actionById(actions, "collect");
    expect(collect.enabled).toBe(true);
    expect(collect.label).toBe("COLLECT");
    expect(collect.note).toBeNull();
    expect(actionById(actions, "destroy").enabled).toBe(true);
  });

  it("out of reach disables every verb with the reach note", () => {
    const actions = extractorRadialActions({
      extractor: extractor({ hopperPct: 40 }),
      distanceCells: 3.2,
      battery: batteryRow(),
      confirmDestroy: false,
    });
    for (const id of ["crank", "insert-battery", "collect", "destroy"]) {
      const action = actionById(actions, id);
      expect(action.enabled).toBe(false);
      expect(action.note).toBe("OUT OF REACH · ≤1.5 CELLS");
    }
  });

  it("manual mode swaps crank for stop and blocks battery insertion", () => {
    const actions = extractorRadialActions({
      extractor: extractor({ mode: "manual" }),
      distanceCells: 0.5,
      battery: batteryRow(),
      confirmDestroy: false,
    });
    expect(actions.some((action) => action.id === "crank")).toBe(false);
    expect(actionById(actions, "stop-crank").enabled).toBe(true);
    const insert = actionById(actions, "insert-battery");
    expect(insert.enabled).toBe(false);
    expect(insert.note).toBe("RELEASE CRANK FIRST");
    const pack = actionById(actions, "destroy");
    expect(pack.enabled).toBe(false);
    expect(pack.note).toBe("RELEASE CRANK FIRST");
  });

  it("battery mode blocks cranking and a second cell", () => {
    const actions = extractorRadialActions({
      extractor: extractor({ mode: "battery", batteryPct: 80, hopperPct: 25 }),
      distanceCells: 0.5,
      battery: batteryRow(),
      confirmDestroy: false,
    });
    const crank = actionById(actions, "crank");
    expect(crank.enabled).toBe(false);
    expect(crank.note).toBe("RUNNING ON BATTERY");
    const insert = actionById(actions, "insert-battery");
    expect(insert.enabled).toBe(false);
    expect(insert.note).toBe("BATTERY PRESENT");
    const collect = actionById(actions, "collect");
    expect(collect.enabled).toBe(true);
    expect(collect.label).toBe("COLLECT · HOPPER 25%");
  });

  it("full hopper blocks cranking with the sim's reason", () => {
    const actions = extractorRadialActions({
      extractor: extractor({ hopperPct: 100 }),
      distanceCells: 0.5,
      battery: null,
      confirmDestroy: false,
    });
    const crank = actionById(actions, "crank");
    expect(crank.enabled).toBe(false);
    expect(crank.note).toBe("HOPPER FULL");
    const insert = actionById(actions, "insert-battery");
    expect(insert.enabled).toBe(false);
    expect(insert.note).toBe("HOPPER FULL");
  });

  it("missing battery is an honest note, not a hidden verb", () => {
    const actions = extractorRadialActions({
      extractor: extractor(),
      distanceCells: 0.5,
      battery: null,
      confirmDestroy: false,
    });
    const insert = actionById(actions, "insert-battery");
    expect(insert.enabled).toBe(false);
    expect(insert.note).toBe("NO BATTERY IN PACK");
  });

  it("labels collect from authority collectableUnits and gates pack while cranking", () => {
    const actions = extractorRadialActions({
      extractor: extractor({ hopperPct: 1, collectableUnits: 3 }),
      distanceCells: 0.5,
      battery: null,
      confirmDestroy: false,
    });
    expect(actionById(actions, "collect").label).toBe("COLLECT · 3 UNITS");
    const busy = extractorRadialActions({
      extractor: extractor({ mode: "manual", hopperPct: 10, collectableUnits: 2 }),
      distanceCells: 0.5,
      battery: null,
      confirmDestroy: false,
    });
    expect(actionById(busy, "destroy").enabled).toBe(false);
    expect(actionById(busy, "destroy").note).toBe("RELEASE CRANK FIRST");
  });
  it("confirm step warns about forfeited yield only when there is yield", () => {
    const armed = extractorRadialActions({
      extractor: extractor({ hopperPct: 60 }),
      distanceCells: 0.5,
      battery: null,
      confirmDestroy: true,
    });
    expect(actionById(armed, "confirm-destroy").label).toBe("CONFIRM PACK-UP · YIELD LOST");
    expect(actionById(armed, "cancel-destroy").enabled).toBe(true);

    const emptyHopper = extractorRadialActions({
      extractor: extractor(),
      distanceCells: 0.5,
      battery: null,
      confirmDestroy: true,
    });
    expect(actionById(emptyHopper, "confirm-destroy").label).toBe("CONFIRM PACK-UP");
  });
});

describe("sampler countdown copy", () => {
  it("converts remaining ticks to whole seconds, never negative", () => {
    expect(ticksToSeconds(900, 30)).toBe(30);
    expect(ticksToSeconds(31, 30)).toBe(2);
    expect(ticksToSeconds(1, 30)).toBe(1);
    expect(ticksToSeconds(-40, 30)).toBe(0);
    expect(ticksToSeconds(60, 0)).toBe(60);
  });

  it("speaks the survey-window cooldown voice", () => {
    expect(sampleCooldownToast(24)).toBe("SAMPLE COOLDOWN · 24s");
    expect(samplerPlateTag(12)).toBe("AUTO-SAMPLE · 12s");
  });
});

describe("extractionReceiptCopy", () => {
  it("hands sample_cooldown to the live countdown", () => {
    expect(extractionReceiptCopy("SampleResource", false, "sample_cooldown")).toBeNull();
  });

  it("speaks rejections in the commandReceipts voice", () => {
    expect(extractionReceiptCopy("PlaceExtractor", false, "extractor_already_placed"))
      .toBe("DENIED · EXTRACTOR ALREADY PLACED");
    expect(extractionReceiptCopy("CrankExtractor", false, null)).toBe("DENIED · UNSPECIFIED");
  });

  it("maps known deny codes to player vocabulary (C4)", () => {
    expect(extractionReceiptCopy("SampleResource", false, "economy_cooldown")).toBe("DENIED · COOLDOWN");
    expect(extractionReceiptCopy("SampleResource", false, "missing_survey_tool")).toBe("DENIED · NO SURVEY TOOL");
    expect(extractionReceiptCopy("CollectExtractor", false, "container_full")).toBe("DENIED · PACK FULL");
  });

  it("keeps accepted cranks silent and receipts the rest", () => {
    expect(extractionReceiptCopy("CrankExtractor", true, null)).toBeNull();
    expect(extractionReceiptCopy("StopCrank", true, null)).toBeNull();
    expect(extractionReceiptCopy("PlaceExtractor", true, null)).toBe("EXTRACTOR DEPLOYED");
    expect(extractionReceiptCopy("CollectExtractor", true, null)).toBe("COLLECTED · YIELD TO PACK");
    expect(extractionReceiptCopy("InsertBattery", true, null)).toBe("BATTERY INSERTED");
    expect(extractionReceiptCopy("DestroyExtractor", true, null)).toBe("PACKED UP · TOOL TO PACK");
  });
});
