import { describe, expect, it } from "vitest";
import { craftReasonLine, recipeDescription } from "./copy";

describe("craft reason lines", () => {
  it("maps §A.8 craft rejects to player language regardless of casing", () => {
    expect(craftReasonLine("CraftSlotUnfilled")).toBe("Fill every slot to assemble.");
    expect(craftReasonLine("craft_slot_unfilled")).toBe("Fill every slot to assemble.");
    expect(craftReasonLine("CRAFT SLOT UNFILLED")).toBe("Fill every slot to assemble.");
    expect(craftReasonLine("SchematicUsesExceeded")).toBe("This schematic is spent.");
    expect(craftReasonLine("craft_session_active")).toBe("Finish the work on your bench first.");
    expect(craftReasonLine("no_craft_session")).toBe("Nothing on the bench.");
    expect(craftReasonLine("CraftSlotMismatch")).toBe("That material doesn't fit this slot.");
    expect(craftReasonLine("CraftAlreadyAssembled")).toBe("Already assembled — choose an exit.");
    expect(craftReasonLine("CraftNotAssembled")).toBe("Assemble first.");
    expect(craftReasonLine("InvalidExperimentLine")).toBe("That line can't take more work.");
  });

  it("never leaks dev casing for unknown codes", () => {
    const line = craftReasonLine("WeirdNewReject_code");
    expect(line).toBe("Refused — weird new reject code.");
    expect(line).not.toMatch(/[_]|[a-z][A-Z]/u);
    expect(craftReasonLine(null)).toBe("Refused by the field office.");
    expect(craftReasonLine("")).toBe("Refused by the field office.");
  });
});

describe("recipe descriptions", () => {
  it("keeps the itemCopy register: plain one-liners under 60 chars", () => {
    for (const id of ["field_multitool", "metal_extractor", "extractor_battery", "slugthrower"]) {
      const line = recipeDescription(id);
      expect(line.length).toBeGreaterThan(0);
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("answers unknown recipes with the honest fallback", () => {
    expect(recipeDescription("brand_new_pattern")).toBe("Field pattern. Materials decide the quality.");
  });
});
