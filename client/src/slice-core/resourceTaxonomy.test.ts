import { describe, expect, it } from "vitest";
import { resourceTaxonomyByItemId } from "./resourceTaxonomy";
import {
  resourceCategoryForFamily,
  surveyToolCategoryForItemId,
  extractorCategoryForItemId,
  isSurveyToolItemId,
  isExtractorToolItemId,
} from "./resourceCategories";

describe("client resource and display taxonomy", () => {
  it("maps raw chemical (2002) to Petrochemical with the correct taxonomy path", () => {
    const rawChemical = resourceTaxonomyByItemId.get(2002);
    expect(rawChemical).toBeDefined();
    expect(rawChemical!.name).toBe("Petrochemical");
    expect(rawChemical!.path).toEqual(["Inorganic", "Chemical", "Petrochemical"]);
  });

  it("defines Carbon (2008) in the display taxonomy as Mineral", () => {
    const carbon = resourceTaxonomyByItemId.get(2008);
    expect(carbon).toBeDefined();
    expect(carbon!.name).toBe("Carbon");
    expect(carbon!.path).toEqual(["Inorganic", "Mineral", "Carbon"]);

    // Carbon and its aliases map to mineral category
    expect(resourceCategoryForFamily("carbon")).toBe("mineral");
    expect(resourceCategoryForFamily("coal")).toBe("mineral");
    expect(resourceCategoryForFamily("carbonite")).toBe("mineral");
    expect(resourceCategoryForFamily("graphite")).toBe("mineral");
  });

  it("defines processed Fuel (2009) and Polymer (2010) in display taxonomy", () => {
    const fuel = resourceTaxonomyByItemId.get(2009);
    expect(fuel).toBeDefined();
    expect(fuel!.name).toBe("Fuel");
    expect(fuel!.path).toEqual(["Inorganic", "Chemical", "Fuel"]);

    const polymer = resourceTaxonomyByItemId.get(2010);
    expect(polymer).toBeDefined();
    expect(polymer!.name).toBe("Polymer");
    expect(polymer!.path).toEqual(["Inorganic", "Chemical", "Polymer"]);
  });

  it("correctly identifies Chemical Survey Device (3009) at craftsman-novice", () => {
    expect(surveyToolCategoryForItemId(3009)).toBe("chemical");
    expect(isSurveyToolItemId(3009)).toBe(true);
  });

  it("correctly maps categories for extractors", () => {
    expect(extractorCategoryForItemId(3006)).toBe("mineral"); // Mineral Sampler
    expect(isExtractorToolItemId(3006)).toBe(true);

    expect(extractorCategoryForItemId(3012)).toBe("chemical"); // Chemical Extractor
    expect(isExtractorToolItemId(3012)).toBe(true);
  });
});
