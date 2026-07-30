import type { InventoryItemVM } from "./types";
import { RESOURCE_GLYPH_BY_ITEM_ID, type ResourceGlyphId, type ContainerGlyphId } from "./resourceGlyphs";

/**
 * Standardized stack-container grammar (asset-rebase contract, 2026-07-12).
 *
 * Shape is the family signal and every family is a stackable polygonal form:
 * industrial solids ship in hex crates, fluids/volatiles/polymers in gable
 * canisters, creature resources in bio-pods, fine organic powders in grain
 * sacks, and ammunition in the aligned ammo box. The plate carries a
 * fixed-value semantic colour and a monochrome filled-silhouette glyph for
 * the exact item. These values are deliberately independent of the UI theme.
 */
export type ContainerShape = "hex-crate" | "gable-canister" | "bio-pod" | "grain-sack" | "ammobox";

export interface ContainerSpec {
  shape: ContainerShape;
  /** Semantic, theme-independent plate colour. */
  plateColor: string;
  /** Fixed body value for the container family. */
  bodyColor: string;
  /** Generated filled-silhouette glyph identity on the plate. */
  lineGlyph: ContainerGlyphId;
}

export const RESOURCE_PLATE_BY_ITEM_ID: Readonly<Record<number, string>> = {
  2001: "#c26a2e", // iron / rust orange
  2002: "#4fae52", // chemical / reactive green
  2003: "#7aa03a", // flora / leaf
  2004: "#3fb8c9", // gas / cyan
  2005: "#3f7ec9", // liquid / blue
  2006: "#d8cfae", // clodpowder / bone
  2007: "#e0805c", // copper / polished salmon
  2008: "#aab7c4", // carbon / silvered graphite
  2009: "#eda13f", // fuel / amber
  2010: "#9b7fd4", // polymer / synthetic violet
  2101: "#8a6a42", // hide
  2102: "#a5524a", // meat
  2103: "#cfc5a5", // clodbone
  2104: "#96604f", // tissue
};

/** Ammo plates share the ammo-box body but retain exact-type colour identity. */
export const AMMO_PLATE_BY_ITEM_ID: Readonly<Record<number, string>> = {
  1101: "#c7b27a", // iron slug
  1102: "#b87362", // shard slug
  1103: "#8ea4b8", // spike slug
};

/** Fixed body neutrals per container family (graphite / warm alloy / soil fiber). */
export const CONTAINER_BODY_BY_SHAPE: Readonly<Record<ContainerShape, string>> = {
  "hex-crate": "#5a616a", // graphite — industrial solids
  "gable-canister": "#6a6152", // warm alloy — sealed fluid transport
  "bio-pod": "#526466", // cold teal-graphite — chilled creature stock
  "grain-sack": "#7d6f52", // soil fiber — woven powder sack
  ammobox: "#5c6650", // olive field metal
};

/**
 * Deliberate physical routing: the container states what the material IS.
 * Solids stack in crates, anything that pours or off-gasses is canned,
 * creature yield is chilled, and clodpowder (with future fine organics)
 * is sacked.
 */
export const RESOURCE_SHAPE_BY_ITEM_ID: Readonly<Record<number, ContainerShape>> = {
  2001: "hex-crate", // iron — dense ore/ingot stock
  2002: "gable-canister", // chemical — volatile reagent
  2003: "hex-crate", // flora — baled solid plant matter
  2004: "gable-canister", // gas — pressurised
  2005: "gable-canister", // liquid
  2006: "grain-sack", // clodpowder — fine organic powder
  2007: "hex-crate", // copper — ore/ingot stock
  2008: "hex-crate", // carbon — block stock
  2009: "gable-canister", // fuel — volatile fluid
  2010: "gable-canister", // polymer — feedstock resin
  2101: "bio-pod", // hide
  2102: "bio-pod", // meat
  2103: "bio-pod", // clodbone
  2104: "bio-pod", // tissue
};

const AMMO_IDS: Record<number, true> = { 1101: true, 1102: true, 1103: true };

/**
 * Resolve the standardized container before consulting any GLB mapping.
 * Ordinary item categories intentionally return null; their authored GLB is
 * the only visual path and no planar/card fallback exists.
 */
export function containerSpecFor(vm: Pick<InventoryItemVM, "itemId" | "category">): ContainerSpec | null {
  if (vm.category === "resource") {
    const shape = RESOURCE_SHAPE_BY_ITEM_ID[vm.itemId];
    const lineGlyph = shape ? RESOURCE_GLYPH_BY_ITEM_ID[vm.itemId] : undefined;
    if (!shape || !lineGlyph) return null;
    return {
      shape,
      plateColor: RESOURCE_PLATE_BY_ITEM_ID[vm.itemId]!,
      bodyColor: CONTAINER_BODY_BY_SHAPE[shape],
      lineGlyph,
    };
  }
  if (vm.category === "ammo" && AMMO_IDS[vm.itemId]) {
    return {
      shape: "ammobox",
      plateColor: AMMO_PLATE_BY_ITEM_ID[vm.itemId]!,
      bodyColor: CONTAINER_BODY_BY_SHAPE.ammobox,
      lineGlyph: "ammo",
    };
  }
  return null;
}

export function isStandardizedContainerItemId(itemId: number): boolean {
  return Boolean(RESOURCE_SHAPE_BY_ITEM_ID[itemId] || AMMO_IDS[itemId]);
}

export type { ContainerGlyphId, ResourceGlyphId };
