import { describe, expect, it } from "vitest";
import {
  buildWardrobeCatalog,
  equipmentIdsCoverLegs,
  pawnEquipmentLookupFor,
  type PawnEquipmentPack,
  type PawnEquipmentItem,
} from "./pawnPack";
import { WARDROBE_PIECES } from "./wardrobe.gen";

/**
 * DEF-13a: the store wardrobe catalog must never appear as inventory gear
 * rows — wardrobe-group items enter a character's catalog ONLY through the
 * character's own worn set. Non-wardrobe gear (armor, hats, classic unders)
 * keeps the pre-wave behavior; hair stays out entirely.
 */

function pack(): PawnEquipmentPack {
  const wardrobeTop = WARDROBE_PIECES.find((piece) => piece.slot === "under_torso")!;
  const wardrobeLegs = WARDROBE_PIECES.find((piece) => piece.slot === "under_legs")!;
  return {
    basePath: "/assets/pawn-pack/equipment",
    items: [
      { id: wardrobeTop.id, name: wardrobeTop.name, layer: "Under", group: wardrobeTop.group, slot: wardrobeTop.slot, glb: "Under/a.glb", requires: [] },
      { id: wardrobeLegs.id, name: wardrobeLegs.name, layer: "Under", group: wardrobeLegs.group, slot: wardrobeLegs.slot, glb: "Under/b.glb", requires: [] },
      { id: "armor_harness", name: "Harness", layer: "Armor", group: "Torso", slot: "armor_harness", glb: "Armor/Harness.glb", requires: [] },
      { id: "under_tank", name: "Tank", layer: "Under", group: "Torso", slot: "under_torso", glb: "Under/Tank.glb", requires: [] },
      { id: "hair_banded_mohawk", name: "Banded Mohawk", layer: "Under", group: "Hair", slot: "cranium", glb: "Under/h.glb", requires: [] },
      { id: "helmet_a", name: "Helmet A", layer: "Armor", group: "Helmet — bake-off", slot: "cranium", glb: "Armor/Helmet_A.glb", requires: [] },
      { id: "helmet_s2", name: "Helmet S2", layer: "Armor", group: "Helmet — bake-off", slot: "cranium", glb: "Armor/Helmet_S2.glb", requires: [] },
      { id: "trial_helm_a", name: "Trial Helm", layer: "Armor", group: "SYNTY TRIALS", slot: "cranium", glb: "Armor/t.glb", requires: [], viewerOnly: true },
      { id: "hat_field_cap", name: "Field Cap", layer: "Under", group: "Headwear — baseline", slot: "cranium", glb: "../../items/custom/accessories/field_cap.glb", requires: [], authorityItemId: 7203, rigidAnchorBone: "head" },
      { id: "hat_warm", name: "Warm Hat", layer: "Under", group: "Headwear — baseline", slot: "cranium", glb: "Under/Hat_Warm.glb", requires: [] },
    ],
    scenes: new Map(),
  };
}

describe("buildWardrobeCatalog (DEF-13a)", () => {
  it("gates wardrobe groups behind the worn set", () => {
    const wardrobeTop = WARDROBE_PIECES.find((piece) => piece.slot === "under_torso")!;
    const entries = buildWardrobeCatalog(pack(), new Set([wardrobeTop.id]));
    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain(wardrobeTop.id);           // worn -> present
    const wardrobeLegs = WARDROBE_PIECES.find((piece) => piece.slot === "under_legs")!;
    expect(ids).not.toContain(wardrobeLegs.id);       // unworn wardrobe -> gone
    expect(entries.every((entry) => entry.glb.length > 0)).toBe(true);
    expect(entries.find((entry) => entry.id === wardrobeTop.id)?.glb).toBe("/assets/pawn-pack/equipment/Under/a.glb");
  });

  it("keeps non-wardrobe gear, the shipped helmet, and drops hair/bake-off/viewer-only", () => {
    const entries = buildWardrobeCatalog(pack(), new Set());
    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain("armor_harness");
    expect(ids).toContain("under_tank");
    expect(ids).toContain("helmet_s2");
    expect(ids).not.toContain("helmet_a");
    expect(ids).not.toContain("hair_banded_mohawk");
    expect(ids).not.toContain("trial_helm_a");
    // and zero wardrobe rows with an empty worn set
    const wardrobeIds = new Set(WARDROBE_PIECES.map((piece) => piece.id));
    expect(ids.filter((id) => wardrobeIds.has(id))).toHaveLength(0);
  });

  it("excludes authority-owned entries so the server row stays the sole item", () => {
    const entries = buildWardrobeCatalog(pack(), new Set());
    const ids = entries.map((entry) => entry.id);
    // 7203 field cap: server inventory row is the only item — no duplicate
    // always-present local gear row for the authority-owned manifest entry.
    expect(ids).not.toContain("hat_field_cap");
    // The exclusion is keyed on authorityItemId, not on the group: a plain
    // client-local hat in the same group still lands.
    expect(ids).toContain("hat_warm");
  });
});

describe("pawnEquipmentLookupFor", () => {
  it("indexes a hand-built equipment pack once and reuses the same lookup", () => {
    const equipment = pack();
    const first = pawnEquipmentLookupFor(equipment);
    const second = pawnEquipmentLookupFor(equipment);

    expect(second).toBe(first);
    expect(first.itemById.size).toBe(equipment.items.length);
    expect(first.availableIds.has("under_tank")).toBe(true);
  });
});

describe("equipmentIdsCoverLegs", () => {
  const item = (id: string, slot: string): PawnEquipmentItem => ({
    id,
    name: id,
    layer: "Under",
    group: "test",
    slot,
    glb: `${id}.glb`,
    requires: [],
  });

  it("uses the manifest leg slot and fixed bodysuit override", () => {
    const items = [
      item("pants", "under_legs"),
      item("under_bodysuit", "under_full"),
      item("tank", "under_torso"),
    ];
    expect(equipmentIdsCoverLegs(items, ["pants"])).toBe(true);
    expect(equipmentIdsCoverLegs(items, ["under_bodysuit"])).toBe(true);
    expect(equipmentIdsCoverLegs(items, ["tank"])).toBe(false);
  });
});
