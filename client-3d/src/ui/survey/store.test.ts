import { describe, expect, it } from "vitest";
import {
  activeSurveyCategory,
  setActiveSurveyCategory,
  setSelectedSurveyFamily,
  resolveSurveyFamily,
  surveyFamilyOptionsFor,
  canonicalSurveyFamily,
  IRON_FAMILY,
  COPPER_FAMILY,
  type SurveyFamilySpawnSource,
} from "./store";
import type { ResourceCategory } from "@successor/client/src/slice-core/resourceCategories";
import {
  createAuthorityCommandQueue,
  enqueueAuthoritySurveyResourceCommand,
  enqueueAuthoritySampleResourceCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";

describe("Survey store selection and options", () => {
  it("manages the active survey category", () => {
    setActiveSurveyCategory("chemical");
    expect(activeSurveyCategory()).toBe("chemical");
    setActiveSurveyCategory("mineral");
    expect(activeSurveyCategory()).toBe("mineral");
  });

  it("remembers selection per category and isolates them (category isolation)", () => {
    // Set different selections for each category
    setSelectedSurveyFamily("mineral", "copper");
    setSelectedSurveyFamily("chemical", "chemical");
    setSelectedSurveyFamily("gas", "gas");
    setSelectedSurveyFamily("water", "water");

    // Mineral category should resolve to its own remembered selection (copper)
    expect(resolveSurveyFamily("mineral", ["metal", "copper"])).toBe("copper");

    // Chemical category should resolve to its own remembered selection (chemical)
    expect(resolveSurveyFamily("chemical", ["chemical"])).toBe("chemical");

    // Isolations remain intact (setting one doesn't clobber the other)
    expect(resolveSurveyFamily("mineral", ["metal", "copper"])).toBe("copper");
  });

  it("resolves options for mineral category from live snapshots including iron, copper, and carbon", () => {
    const spawns: readonly SurveyFamilySpawnSource[] = [
      { family: "iron", classLabel: "Iron Ore" },
      { family: "copper", classLabel: "Copper Ore" },
      { family: "carbon", classLabel: "Carbon Deposit" },
      { family: "gas", classLabel: "Gas Pocket" }, // Belongs to gas category, should be filtered out
    ];

    const options = surveyFamilyOptionsFor(spawns, "mineral");

    // "iron" should canonicalize to "metal"
    // "copper" should canonicalize to "copper"
    // "carbon" should canonicalize to "carbon"
    // "gas" is gas, should be ignored
    expect(options).toEqual([
      { family: "metal", label: "Iron Ore" },
      { family: "carbon", label: "Carbon Deposit" },
      { family: "copper", label: "Copper Ore" },
    ]);
  });

  it("handles primary fallback on empty or dormant family correctly", () => {
    // Reset mineral remembered family to primary "metal" or clear selection (since we can't delete, we test by not having it offered)
    setSelectedSurveyFamily("mineral", "copper");

    // 1. Primary fallback on empty offered list (returns category's primary family, "metal" for mineral)
    expect(resolveSurveyFamily("mineral", [])).toBe("metal");

    // 2. Primary fallback on dormant selection (remembered copper is not offered, primary metal is offered)
    expect(resolveSurveyFamily("mineral", ["metal"])).toBe("metal");

    // 3. Fallback to first offered family when both remembered and primary are dormant (not offered)
    // Here copper and metal are not offered, only carbon is offered.
    expect(resolveSurveyFamily("mineral", ["carbon"])).toBe("carbon");
  });

  it("deduplicates options and sorts them stably (primary first, others alphabetically by label)", () => {
    const spawns: readonly SurveyFamilySpawnSource[] = [
      { family: "copper", classLabel: "Copper Ore" },
      { family: "copper", classLabel: "Copper Plentiful" }, // Duplicate family, first wins
      { family: "carbon", classLabel: "Coal Bed" },
      { family: "iron", classLabel: "Ferrite Vein" }, // Primary "metal" family, should sort first
      { family: "carbon", classLabel: "Graphite Lobe" }, // Duplicate family, first wins
    ];

    const options = surveyFamilyOptionsFor(spawns, "mineral");

    // Expected order:
    // 1. Primary: "metal" (labeled "Ferrite Vein" because iron -> metal)
    // 2. Sorted alphabetically by label:
    //    - "Coal Bed" (family "carbon")
    //    - "Copper Ore" (family "copper")
    expect(options).toEqual([
      { family: "metal", label: "Ferrite Vein" },
      { family: "carbon", label: "Coal Bed" },
      { family: "copper", label: "Copper Ore" },
    ]);
  });

  it("builds correct authority commands using the chosen survey family", () => {
    // Set a chosen family
    setSelectedSurveyFamily("mineral", "carbon");
    const spawns: readonly SurveyFamilySpawnSource[] = [
      { family: "iron", classLabel: "Iron" },
      { family: "copper", classLabel: "Copper" },
      { family: "carbon", classLabel: "Carbon" },
    ];
    const offered = spawns.map((s) => canonicalSurveyFamily(s.family));

    // Resolve the chosen/resolved family using the offered snapshot
    const resolvedFamily = resolveSurveyFamily("mineral", offered);
    expect(resolvedFamily).toBe("carbon");

    // Create a mock authority command queue
    const queue = createAuthorityCommandQueue(1, 1);

    // Enqueue a survey command with the resolved family
    const surveyEnvelope = enqueueAuthoritySurveyResourceCommand(queue, resolvedFamily, 10);
    expect(surveyEnvelope).not.toBeNull();
    expect(surveyEnvelope!.command).toEqual({
      SurveyResource: { family: "carbon" },
    });

    // Enqueue a sample command with the resolved family
    const sampleEnvelope = enqueueAuthoritySampleResourceCommand(queue, resolvedFamily, 11);
    expect(sampleEnvelope).not.toBeNull();
    expect(sampleEnvelope!.command).toEqual({
      SampleResource: { family: "carbon" },
    });
  });
});
