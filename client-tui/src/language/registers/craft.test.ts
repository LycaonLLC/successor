import { describe, expect, it } from "vitest";

import { craftResultWord } from "@successor/client/src/slice-core/craftResultBands";
import type { CraftAssembledVM, CraftSlotScreenVM } from "@successor/client/src/slice-core/crafting/types";

import {
  composeAssembled,
  composeCancelWarning,
  composeExperimentDelta,
  composeRecipeInfo,
  composePrototypeLine,
  composeRecipeList,
  composeSlotScreen,
} from "./craft";

function slotScreen(): CraftSlotScreenVM {
  return {
    recipeId: "extractor-battery",
    canAssemble: false,
    slots: [
      {
        slotIndex: 0,
        symbol: "⚡",
        resourceKindLabel: "Conductor (copper)",
        requiredQty: 4,
        requiredItemId: 2007,
        requiredFamily: "copper",
        requirementKind: "material_family",
        requiredItemName: "Copper",
        craftRelevantStat: "conductivity",
        assigned: null,
        eligible: [
          { container: "observer:field-pack", stackId: "11", itemId: 2004, variantId: 1, name: "Daxmire copper", qtyAvailable: 12, craftRelevantStatValue: 641, recommended: true, stats: {} as never },
          { container: "observer:field-pack", stackId: "12", itemId: 2004, variantId: 2, name: "Rill copper", qtyAvailable: 40, craftRelevantStatValue: 512, recommended: false, stats: {} as never },
        ],
      },
      {
        slotIndex: 1,
        symbol: "▤",
        resourceKindLabel: "Casing (iron)",
        requiredQty: 2,
        requiredItemId: 2001,
        requiredFamily: "mineral",
        requirementKind: "material_family",
        requiredItemName: "Iron",
        craftRelevantStat: "density",
        assigned: null,
        eligible: [],
      },
    ],
  };
}

function assembled(): CraftAssembledVM {
  return {
    recipeId: "extractor-battery",
    assemblyQualityMilli: 780,
    experimentationPointsRemaining: 7,
    outputPreviewVariantId: 1,
    lines: [
      { lineId: 1, label: "Charge", valueMilli: 412, capMilli: 618, canRaise: true },
      { lineId: 2, label: "Durability", valueMilli: 300, capMilli: 300, canRaise: false },
    ],
  };
}

describe("craft register (workbench prose)", () => {
  it("slot screen surfaces the bench pick BOTH ways and speaks empty slots honestly", () => {
    const lines = composeSlotScreen(slotScreen(), "Extractor Battery");
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("SLOT Ⅰ — Conductor (copper)   [empty]");
    expect(text).toContain("Copper (×4)");
    expect(text).toContain("◆ bench pick");
    expect(text).toContain("The bench likes the Daxmire copper lot for its conductivity.");
    expect(text).toContain("nothing eligible in your pack");
    expect(text).toContain("/craft fill auto");
  });


  it("recipe info spells flavor slots as purpose plus real material", () => {
    const lines = composeRecipeInfo({
      recipeId: "extractor-battery",
      outputItemId: 3201,
      outputPreviewVariantId: 0,
      slots: slotScreen().slots.map((slot) => ({
        slotIndex: slot.slotIndex,
        symbol: slot.symbol,
        resourceKindLabel: slot.resourceKindLabel,
        requiredItemId: slot.requiredItemId ?? null,
        requiredFamily: slot.requiredFamily ?? null,
        requirementKind: slot.requirementKind,
        requiredItemName: slot.requiredItemName ?? null,
        requiredQty: slot.requiredQty,
        craftRelevantStat: slot.craftRelevantStat ?? "conductivity",
      })),
      statLines: [{ lineId: 1, label: "Charge", capEstimateMilli: 618 }],
    }, "Extractor Battery");
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("Ⅰ Conductor (copper) — Copper (×4)");
    expect(text).toContain("Ⅱ Casing (iron) — Iron (×2)");
  });
  it("assembled phase reads the SHARED band word with numbered gauge rows", () => {
    const lines = composeAssembled(assembled());
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain(`${craftResultWord(780)} work (quality 78%)`);
    expect(text).toMatch(/1\. CHARGE\s+412 \/ cap 618/);
    expect(text).toContain("(at cap)");
    expect(text).toContain("Experimentation: 7 points.");
  });

  it("prototype/draft lines stamp the same band vocabulary as the 3D surface", () => {
    expect(composePrototypeLine("Extractor Battery", 920).text).toContain(craftResultWord(920));
    expect(composePrototypeLine("Extractor Battery", 100).text).toContain(craftResultWord(100));
  });

  it("experiment deltas narrate rise, stall, and slip distinctly", () => {
    expect(composeExperimentDelta("charge", 412, 466, 2, 5).text).toMatch(/412 → 466.*5 remain/);
    expect(composeExperimentDelta("charge", 412, 412, 1, 4).text).toMatch(/refuses to move/);
    expect(composeExperimentDelta("charge", 412, 380, 1, 4).register).toBe("reject");
  });

  it("lossy-cancel warning names exactly what is forfeited", () => {
    expect(composeCancelWarning(2, 5).text).toContain("2 slots committed, 5 points unspent");
    expect(composeCancelWarning(1, 0).text).toContain("1 slot committed");
  });

  it("recipe list numbers rows and carries source/uses/lock channels", () => {
    const lines = composeRecipeList([
      { recipeId: "r1", name: "Extractor Battery", category: "component", outputItemId: 3201, outputPreviewVariantId: 0, unlocked: true, requiredToolItemId: 3001, requiredProfession: "craftsman", source: "trained" },
      { recipeId: "r2", name: "Field Bandage", category: "supply", outputItemId: 1002, outputPreviewVariantId: 0, unlocked: false, requiredToolItemId: 3001, requiredProfession: "medic", source: "learned", remainingUses: 3 },
    ]);
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("1. Extractor Battery — component");
    expect(text).toContain("2. Field Bandage — supply · learned · 3 uses left · LOCKED");
  });
});
