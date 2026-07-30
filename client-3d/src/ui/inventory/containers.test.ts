import { describe, expect, it } from "vitest";
import {
  AMMO_PLATE_BY_ITEM_ID,
  CONTAINER_BODY_BY_SHAPE,
  RESOURCE_PLATE_BY_ITEM_ID,
  RESOURCE_SHAPE_BY_ITEM_ID,
  containerSpecFor,
  isStandardizedContainerItemId,
  type ContainerShape,
} from "./containers";
import { RESOURCE_GLYPH_BY_ITEM_ID, RESOURCE_GLYPH_SILHOUETTES } from "./resourceGlyphs";
import itemModelsJson from "./itemModels.json";

const RESOURCE_IDS = Object.keys(RESOURCE_PLATE_BY_ITEM_ID).map(Number);
const AMMO_IDS = Object.keys(AMMO_PLATE_BY_ITEM_ID).map(Number);
const STANDARD_IDS = [...RESOURCE_IDS, ...AMMO_IDS];

/** Contract routing (asset-rebase 2026-07-12): the container states what the material IS. */
const EXPECTED_SHAPE_BY_ITEM_ID: Record<number, ContainerShape> = {
  2001: "hex-crate", // iron — industrial solid
  2002: "gable-canister", // chemical — volatile
  2003: "hex-crate", // flora — baled solid
  2004: "gable-canister", // gas
  2005: "gable-canister", // liquid
  2006: "grain-sack", // clodpowder — fine organic powder
  2007: "hex-crate", // copper
  2008: "hex-crate", // carbon
  2009: "gable-canister", // fuel
  2010: "gable-canister", // polymer
  2101: "bio-pod", // hide
  2102: "bio-pod", // meat
  2103: "bio-pod", // clodbone
  2104: "bio-pod", // tissue
  1101: "ammobox",
  1102: "ammobox",
  1103: "ammobox",
};

function spec(itemId: number, category: "resource" | "ammo") {
  return containerSpecFor({ itemId, category });
}

describe("standardized 3D resource/ammo containers", () => {
  it("routes all 17 canonical IDs to the contract shape family regardless of GLB mapping", () => {
    expect(STANDARD_IDS).toHaveLength(17);
    for (const itemId of RESOURCE_IDS) {
      const result = spec(itemId, "resource");
      expect(result, `${itemId}`).not.toBeNull();
      expect(result?.shape, `${itemId}`).toBe(EXPECTED_SHAPE_BY_ITEM_ID[itemId]);
      expect(result?.bodyColor, `${itemId}`).toBe(CONTAINER_BODY_BY_SHAPE[result!.shape]);
      expect(result?.lineGlyph, `${itemId}`).toBe(RESOURCE_GLYPH_BY_ITEM_ID[itemId]);
    }
    for (const itemId of AMMO_IDS) {
      const result = spec(itemId, "ammo");
      expect(result, `${itemId}`).toEqual(expect.objectContaining({ shape: "ammobox", lineGlyph: "ammo" }));
    }
  });

  it("uses only the five contract shapes and exercises every one of them", () => {
    const validShapes: readonly ContainerShape[] = ["hex-crate", "gable-canister", "bio-pod", "grain-sack", "ammobox"];
    const seenShapes = new Set<string>();
    for (const itemId of STANDARD_IDS) {
      const result = spec(itemId, itemId >= 2000 ? "resource" : "ammo")!;
      expect(validShapes.includes(result.shape), `${itemId} shape ${result.shape}`).toBe(true);
      seenShapes.add(result.shape);
    }
    expect([...seenShapes].sort()).toEqual([...validShapes].sort());
    // Clean cutover: the retired drum/pod shape strings must not exist anywhere.
    expect(seenShapes.has("drum")).toBe(false);
    expect(seenShapes.has("pod")).toBe(false);
    expect(Object.values(RESOURCE_SHAPE_BY_ITEM_ID).every((shape) => validShapes.includes(shape))).toBe(true);
  });

  it("preserves the exact semantic plate colours from the pre-rebase grammar", () => {
    expect(RESOURCE_PLATE_BY_ITEM_ID).toEqual({
      2001: "#c26a2e",
      2002: "#4fae52",
      2003: "#7aa03a",
      2004: "#3fb8c9",
      2005: "#3f7ec9",
      2006: "#d8cfae",
      2007: "#e0805c",
      2008: "#aab7c4",
      2009: "#eda13f",
      2010: "#9b7fd4",
      2101: "#8a6a42",
      2102: "#a5524a",
      2103: "#cfc5a5",
      2104: "#96604f",
    });
    expect(AMMO_PLATE_BY_ITEM_ID).toEqual({ 1101: "#c7b27a", 1102: "#b87362", 1103: "#8ea4b8" });
    for (const itemId of RESOURCE_IDS) {
      expect(spec(itemId, "resource")?.plateColor, `${itemId}`).toBe(RESOURCE_PLATE_BY_ITEM_ID[itemId]);
    }
    for (const itemId of AMMO_IDS) {
      expect(spec(itemId, "ammo")?.plateColor, `${itemId}`).toBe(AMMO_PLATE_BY_ITEM_ID[itemId]);
    }
  });

  it("keeps all 14 resource plates explicit and visually distinct", () => {
    const identities = RESOURCE_IDS.map((itemId) => {
      const result = spec(itemId, "resource")!;
      return `${itemId}|${result.plateColor}|${result.lineGlyph}|${RESOURCE_GLYPH_SILHOUETTES[result.lineGlyph]}`;
    });
    expect(new Set(identities)).toHaveLength(14);
    expect(RESOURCE_IDS.every((itemId) => RESOURCE_GLYPH_SILHOUETTES[RESOURCE_GLYPH_BY_ITEM_ID[itemId]!]!.length > 0)).toBe(true);
  });

  it("uses the generated ammo silhouette and never consults an icon/sprite URL", () => {
    for (const svg of Object.values(RESOURCE_GLYPH_SILHOUETTES)) {
      expect(svg).toContain('viewBox="0 0 512 512"');
      expect(svg).toContain('fill="currentColor"');
      expect(svg).toContain("<path d=");
      expect(svg).not.toMatch(/href|url\(|<image/i);
    }
    expect(RESOURCE_GLYPH_SILHOUETTES.ammo.length).toBeGreaterThan(0);
    for (const itemId of AMMO_IDS) expect(spec(itemId, "ammo")?.lineGlyph).toBe("ammo");
  });

  it("routes containers before direct GLB mappings and leaves ordinary items non-container", () => {
    const modelIds = new Set(Object.keys(itemModelsJson).filter((key) => key !== "_comment").map(Number));
    for (const itemId of STANDARD_IDS) {
      expect(isStandardizedContainerItemId(itemId)).toBe(true);
      expect(modelIds.has(itemId), `${itemId} must not have a direct GLB`).toBe(false);
    }
    expect(containerSpecFor({ itemId: 1002, category: "medical" })).toBeNull();
    expect(containerSpecFor({ itemId: 3101, category: "weapon" })).toBeNull();
    expect(containerSpecFor({ itemId: 4001, category: "currency" })).toBeNull();
  });
});
