/**
 * Resource CATEGORY model — the single client-side source of truth mirroring the
 * Rust `ResourceCategory` (crates/successor-sim authority/model.rs). Each of the
 * four categories owns a survey-tool item, an extractor item, and the family key
 * the survey/sample/extractor commands carry. Several families map to one
 * category (mineral covers iron + copper, and carbon the moment the registry
 * activates it). Item ids match the sim (additive 3008-3014; mineral extractor
 * keeps its stable id 3006).
 */
export type ResourceCategory = "mineral" | "chemical" | "gas" | "water";

export interface ResourceCategorySpec {
  category: ResourceCategory;
  /** Family key sent to survey/sample/place for this category's primary spawn. */
  surveyFamily: string;
  surveyToolItemId: number;
  extractorToolItemId: number;
  surveyToolName: string;
  extractorName: string;
}

const CATEGORY_SPECS: Readonly<Record<ResourceCategory, ResourceCategorySpec>> = {
  mineral: { category: "mineral", surveyFamily: "metal", surveyToolItemId: 3008, extractorToolItemId: 3006, surveyToolName: "Mineral Survey Tool", extractorName: "Personal Mineral Sampler" },
  chemical: { category: "chemical", surveyFamily: "chemical", surveyToolItemId: 3009, extractorToolItemId: 3012, surveyToolName: "Chemical Survey Device", extractorName: "Personal Chemical Extractor" },
  gas: { category: "gas", surveyFamily: "gas", surveyToolItemId: 3010, extractorToolItemId: 3013, surveyToolName: "Gas Survey Tool", extractorName: "Personal Gas Harvester" },
  water: { category: "water", surveyFamily: "water", surveyToolItemId: 3011, extractorToolItemId: 3014, surveyToolName: "Water Survey Tool", extractorName: "Survival Moisture Vaporator" },
};

const FAMILY_TO_CATEGORY: Readonly<Record<string, ResourceCategory>> = {
  metal: "mineral", iron: "mineral", ferrite: "mineral", mineral: "mineral", minerals: "mineral", ore: "mineral",
  copper: "mineral", cuprite: "mineral", cu: "mineral", conductor: "mineral",
  carbon: "mineral", coal: "mineral", carbonite: "mineral", graphite: "mineral",
  chemical: "chemical", chemicals: "chemical", chem: "chemical", petro: "chemical", petroleum: "chemical", solvent: "chemical", catalyst: "chemical", binder: "chemical",
  gas: "gas", gasses: "gas", gases: "gas", gaseous: "gas", vapor: "gas", fuelgas: "gas",
  water: "water", liquid: "water", liquids: "water", moisture: "water", aqua: "water", h2o: "water", hydro: "water",
};

export const RESOURCE_CATEGORIES: readonly ResourceCategory[] = ["mineral", "chemical", "gas", "water"];

export function resourceCategoryForFamily(family: string | null | undefined): ResourceCategory | null {
  const key = family?.trim().toLowerCase() ?? "";
  return FAMILY_TO_CATEGORY[key] ?? null;
}

export function resourceCategorySpec(category: ResourceCategory): ResourceCategorySpec {
  return CATEGORY_SPECS[category];
}

export function surveyToolCategoryForItemId(itemId: number): ResourceCategory | null {
  return RESOURCE_CATEGORIES.find((c) => CATEGORY_SPECS[c].surveyToolItemId === itemId) ?? null;
}

export function isSurveyToolItemId(itemId: number): boolean {
  return surveyToolCategoryForItemId(itemId) !== null;
}

export function extractorCategoryForItemId(itemId: number): ResourceCategory | null {
  return RESOURCE_CATEGORIES.find((c) => CATEGORY_SPECS[c].extractorToolItemId === itemId) ?? null;
}

export function isExtractorToolItemId(itemId: number): boolean {
  return extractorCategoryForItemId(itemId) !== null;
}

/** The category-generic device NAME for a placed extractor's family (kills the
 *  old "Iron Extractor" specificity — e.g. "Personal Mineral Sampler"). */
export function extractorDeviceLabelForFamily(family: string | null | undefined): string {
  const category = resourceCategoryForFamily(family);
  return category ? CATEGORY_SPECS[category].extractorName : "Extractor";
}

/** Family key to survey/sample a category (used when a category survey tool
 *  opens its window). */
export function surveyFamilyForCategory(category: ResourceCategory): string {
  return CATEGORY_SPECS[category].surveyFamily;
}
