import { describe, expect, it } from "vitest";
import { MeshMatcapMaterial, MeshStandardMaterial } from "three";
import { resolveEquipmentSlotMaterial, type EquipmentSlotMaterialItem } from "./equipmentMaterials";

/**
 * Palette-zone resolution (wardrobe wave 2026-07-08): a wardrobe piece's
 * manifest palette maps atlas slot suffixes (cN) to dye zones. Dyed slots
 * render the worn color (or the authored zone default); slots outside every
 * zone stay FIXED (baked atlas color); hair items keep the hair_mat override.
 */

const piece: EquipmentSlotMaterialItem = {
  id: "top_rigged_tank",
  name: "Rigged Canvas Tank",
  layer: "Under",
  slot: "under_torso",
  palette: {
    zones: [
      { key: "body", family: "workcloth", slots: ["c3"], default: "#b08040" },
      { key: "straps", family: "workcloth", slots: ["c5"], default: "#406090" },
    ],
  },
};

/** The fixed-issue bodysuit: ONE Blender slot named "PF2_Cloth" (no _cN
 * atlas suffix) addressed by full slot name from the manifest zone. */
const bodysuit: EquipmentSlotMaterialItem = {
  id: "under_bodysuit",
  name: "Bodysuit",
  layer: "Under",
  slot: "under_full",
  palette: {
    zones: [
      { key: "suit", family: "workcloth", slots: ["PF2_Cloth"], default: "#89cff0" },
    ],
  },
};

function identity(name: string, baseColorHex = "#aabbcc") {
  return { name, baseColorHex };
}

function colorHex(material: unknown): string {
  const mesh = material as MeshMatcapMaterial | MeshStandardMaterial;
  return `#${mesh.color.getHexString()}`;
}

describe("equipmentMaterials palette zones", () => {
  it("dyes a zone slot with the worn color at that zone index", () => {
    const material = resolveEquipmentSlotMaterial(
      identity("top_rigged_tank_c3"),
      piece,
      undefined,
      { kind: "world" },
      ["#804040", "#3f7472"],
    );
    expect(colorHex(material)).toBe("#804040");
    const straps = resolveEquipmentSlotMaterial(
      identity("top_rigged_tank_c5"),
      piece,
      undefined,
      { kind: "world" },
      ["#804040", "#3f7472"],
    );
    expect(colorHex(straps)).toBe("#3f7472");
  });

  it("falls back to the authored zone default without worn colors", () => {
    const material = resolveEquipmentSlotMaterial(
      identity("top_rigged_tank_c3"),
      piece,
      undefined,
      { kind: "world" },
      null,
    );
    expect(colorHex(material)).toBe("#b08040");
    // short arrays: missing index -> default
    const straps = resolveEquipmentSlotMaterial(
      identity("top_rigged_tank_c5"),
      piece,
      undefined,
      { kind: "world" },
      ["#804040"],
    );
    expect(colorHex(straps)).toBe("#406090");
  });

  it("ignores malformed worn colors (falls back to the zone default)", () => {
    const material = resolveEquipmentSlotMaterial(
      identity("top_rigged_tank_c3"),
      piece,
      undefined,
      { kind: "world" },
      ["magenta!!"],
    );
    expect(colorHex(material)).toBe("#b08040");
  });

  it("leaves FIXED slots on the baked atlas color path", () => {
    // c0 belongs to no zone -> baked source color survives (hardware stays
    // hardware no matter the player's dye picks).
    const material = resolveEquipmentSlotMaterial(
      identity("top_rigged_tank_c0", "#808080"),
      piece,
      undefined,
      { kind: "world" },
      ["#804040", "#3f7472"],
    );
    expect(colorHex(material)).toBe("#808080");
  });

  it("applies zone colors in the lit family too (paper doll path)", () => {
    const material = resolveEquipmentSlotMaterial(
      identity("top_rigged_tank_c3"),
      piece,
      undefined,
      { kind: "lit" },
      ["#687048"],
    );
    expect(material).toBeInstanceOf(MeshStandardMaterial);
    expect(colorHex(material)).toBe("#687048");
  });

  it("keeps hair items on the hair_mat preset override, palette or not", () => {
    const hair: EquipmentSlotMaterialItem = {
      id: "hair_banded_mohawk",
      layer: "Under",
      slot: "cranium",
    };
    const material = resolveEquipmentSlotMaterial(
      identity("sk_apoc_outl_01_02hair_hu01_c0"),
      hair,
      "hair_moss",
      { kind: "world" },
      null,
    ) as MeshMatcapMaterial;
    // resolves through the preset path (named material), not the baked color
    expect(material.name).toContain("hair_moss");
  });

  it("dyes a full-name zone slot (issue bodysuit PF2_Cloth) with the worn color", () => {
    const dyed = resolveEquipmentSlotMaterial(
      identity("PF2_Cloth"),
      bodysuit,
      "cotton_jersey",
      { kind: "world" },
      ["#89cff0"],
    );
    expect(colorHex(dyed)).toBe("#89cff0");
    // Blender duplicate suffix ("PF2_Cloth.001") still lands in the zone.
    const duplicate = resolveEquipmentSlotMaterial(
      identity("PF2_Cloth.001"),
      bodysuit,
      "cotton_jersey",
      { kind: "world" },
      null,
    );
    expect(colorHex(duplicate)).toBe("#89cff0");
  });
});
