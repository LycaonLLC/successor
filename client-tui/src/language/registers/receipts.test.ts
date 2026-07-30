import { describe, expect, it } from "vitest";
import { composeReceiptLine } from "./receipts";

describe("receipts register — weapon certification (combat-doctrine.md §3)", () => {
  it("speaks the honest cert reject as readable prose, not a dev code", () => {
    const line = composeReceiptLine({
      commandKind: "SetEquippedWeapon",
      accepted: false,
      reasonCode: "weapon_not_certified",
    });
    expect(line).not.toBeNull();
    expect(line!.reject).toBe(true);
    expect(line!.text).toContain("UNCERTIFIED");
    expect(line!.text.toLowerCase()).toContain("certification");
    expect(line!.text).not.toContain("weapon_not_certified");
  });

  it("stays silent when an equip is accepted (the act speaks through events)", () => {
    const line = composeReceiptLine({
      commandKind: "SetEquippedWeapon",
      accepted: true,
      reasonCode: undefined,
    });
    expect(line).toBeNull();
  });
});

describe("receipts register — resource entry points", () => {
  it("distinguishes universal hand sampling from trained tool surveying", () => {
    const sample = composeReceiptLine({
      commandKind: "SampleResource",
      accepted: true,
      reasonCode: undefined,
    });
    const survey = composeReceiptLine({
      commandKind: "SurveyResource",
      accepted: true,
      reasonCode: undefined,
    });

    expect(sample?.text).toContain("by hand");
    expect(sample?.text.toLowerCase()).not.toContain("sampler");
    expect(survey?.text.toLowerCase()).toContain("scanner");
  });
});

describe("receipts register — harvest corpse", () => {
  it("returns exact accepted copy when HarvestCorpse is accepted", () => {
    const line = composeReceiptLine({
      commandKind: "HarvestCorpse",
      accepted: true,
      reasonCode: undefined,
    });
    expect(line).toEqual({
      text: "You strip useful hide, meat, and bone from the corpse.",
      reject: false,
    });
  });

  it("uses normal DENIED path rather than success copy when HarvestCorpse is rejected", () => {
    const line = composeReceiptLine({
      commandKind: "HarvestCorpse",
      accepted: false,
      reasonCode: "target_not_found",
    });
    expect(line).not.toBeNull();
    expect(line!.reject).toBe(true);
    expect(line!.text).toContain("HARVEST CORPSE DENIED");
    expect(line!.text).not.toContain("You strip useful hide, meat, and bone from the corpse.");
  });
});
