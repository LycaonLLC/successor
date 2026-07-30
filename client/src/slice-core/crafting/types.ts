import type { ServerAuthorityResourceStatsState } from "../gameState";

/**
 * CRAFT window view-model contract — blueprint §E (extraction-crafting
 * blueprint, owner spec 2026-07-08) plus the owner canon growth fields
 * (recipe source / remaining uses / hands_craftable, drafted-schematic
 * datapad handles). These shapes are the FE side of the craftSession
 * channel; the sim lane (CraftSimW67) delivers matching wire state and the
 * store normalizes into these. Everything the window renders comes from
 * here — the FE computes NOTHING the server already knows (the
 * recommendation, eligibility, caps and quality are all server truth).
 */

/** Factory-draft datapad handle (5001 = travel ticket; drafts are 5003). */
export const DRAFTED_SCHEMATIC_ITEM_ID = 5003;
/** Field Multitool — the one tool that covers every recipe (no stations). */
export const FIELD_MULTITOOL_ITEM_ID = 3001;
/** Owner cap on schematic use counts. */
export const DRAFT_MAX_USES = 1000;

/** The full 12-stat resource block (wire shape, snake_case = sim struct). */
export type ResourceStatsVM = ServerAuthorityResourceStatsState;

export type CraftRecipeCategory = "weapon" | "tool" | "component" | "supply";

export type CraftSlotRequirementKind = "material_family" | "item";

/** §E.1 — one recipe row in the KNOWN RECIPES browser. */
export interface CraftRecipeSummaryVM {
  recipeId: string;
  name: string;
  category: CraftRecipeCategory;
  outputItemId: number;
  outputPreviewVariantId: number;
  unlocked: boolean;
  requiredToolItemId: number;
  requiredProfession: string;
  /** Where the player got it — trained skill box or a looted/learned unlock. */
  source?: "trained" | "learned";
  /** Limited-use learned recipes carry a remaining count; null = unlimited. */
  remainingUses?: number | null;
  /** Craftable bare-handed (Field Multitool only) — assembly is penalized. */
  handsCraftable?: boolean;
}

export interface CraftRecipeListVM {
  recipes: CraftRecipeSummaryVM[];
}

/** §E.2 — slot requirement spec (browser ledger + slot screen headers). */
export interface CraftSlotSpecVM {
  slotIndex: number;
  /** Slot glyph (e.g. ⚙ / ⚡ / ▤). */
  symbol: string;
  /** "Conductor (copper)" etc. */
  resourceKindLabel: string;
  requiredItemId: number | null;
  requiredFamily: string | null;
  requirementKind?: CraftSlotRequirementKind | string;
  requiredItemName?: string | null;
  requiredQty: number;
  /** e.g. "conductivity" — drives the auto-recommendation. */
  craftRelevantStat: keyof ResourceStatsVM;
}

/** §E.2 — selected recipe detail (preview + requirements + ceilings). */
export interface CraftRecipeDetailVM {
  recipeId: string;
  outputItemId: number;
  outputPreviewVariantId: number;
  slots: CraftSlotSpecVM[];
  statLines: { lineId: number; label: string; capEstimateMilli: number }[];
}

/** §E.3 — one eligible stack for a slot (server-sorted, server-recommended). */
export interface ResourceOptionVM {
  container: string;
  stackId: string;
  itemId: number;
  variantId: number;
  name: string;
  qtyAvailable: number;
  craftRelevantStatValue: number;
  /** Highest craft-relevant value with qtyAvailable >= requiredQty. */
  recommended: boolean;
  /** Full block for the ⓘ hover. */
  stats: ResourceStatsVM;
}

/** §E.3 — a slot mid-fill. */
export interface CraftSlotFillVM {
  slotIndex: number;
  symbol: string;
  resourceKindLabel: string;
  requiredQty: number;
  requiredItemId?: number | null;
  requiredFamily?: string | null;
  requirementKind?: CraftSlotRequirementKind | string;
  requiredItemName?: string | null;
  /** Sorted DESC by craftRelevantStatValue — [0] is the recommendation. */
  eligible: ResourceOptionVM[];
  assigned: { container: string; stackId: string; variantId: number } | null;
  /** Joined from the recipe detail; null when the spec hasn't streamed. */
  craftRelevantStat: keyof ResourceStatsVM | null;
}

export interface CraftSlotScreenVM {
  recipeId: string;
  slots: CraftSlotFillVM[];
  canAssemble: boolean;
}

/** §E.4 — post-assembly stat line (value vs cap, experimentable). */
export interface CraftStatLineVM {
  lineId: number;
  label: string;
  valueMilli: number;
  capMilli: number;
  canRaise: boolean;
  onePointSuccessMilli?: number;
  batchRiskPerExtraPointMilli?: number;
}

export interface CraftAssembledVM {
  recipeId: string;
  assemblyQualityMilli: number;
  experimentationPointsRemaining: number;
  lines: CraftStatLineVM[];
  /** Live-updates as experiments land. */
  outputPreviewVariantId: number;
}

/** Session phase — browser is "no session"; the server owns transitions. */
export type CraftSessionPhase = "slots" | "assembled";

export interface CraftSessionVM {
  phase: CraftSessionPhase;
  recipeId: string;
  slotScreen: CraftSlotScreenVM | null;
  assembled: CraftAssembledVM | null;
}

/** One factory draft (datapad SCHEMATICS tab row; §A.5 side table). */
export interface DraftedSchematicVM {
  schematicId: string;
  recipeId: string;
  /** Output display name ("Extractor Battery"). */
  name: string;
  outputItemId: number;
  outputVariantId: number;
  maxUses: number;
  remainingUses: number;
  /** Frozen resource locks — identical stacks required for line production. */
  resourceLocks: { itemId: number; variantId: number; quantity: number; name: string }[];
  /** Achieved stat lines frozen at draft time. */
  statLines: { label: string; valueMilli: number }[];
}
