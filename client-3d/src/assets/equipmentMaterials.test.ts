import { beforeAll, describe, expect, it, vi } from "vitest";
import { MeshStandardMaterial } from "three";
import { resolveEquipmentSlotMaterial } from "./equipmentMaterials";

beforeAll(() => {
  vi.stubGlobal("fetch", async (rawUrl: string) => {
    const url = String(rawUrl);
    return {
      ok: true,
      json: async () => {
        if (url.endsWith("/manifest.json")) {
          return {
            items: [
              { id: "armor_harness", layer: "Armor", mat: "smooth_steel" },
              { id: "hair_afro2", layer: "Under", mat: "hair_umber" },
            ],
          };
        }
        return { schemaVersion: 1, default: url.includes("ClothingMaterials") ? "cotton_jersey" : "smooth_steel", materials: [] };
      },
    };
  });
});

const armorItem = { id: "armor_harness", name: "Harness", layer: "Armor" as const, slot: "armor_harness", glb: "Armor/Harness.glb" };
const proofItem = { id: "armor_slot_test", name: "Slot Color Proof", layer: "Armor" as const, slot: "armor_harness", glb: "Armor/Slot_Test.glb" };

function sourceMaterial(name: string, color: string): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color });
  material.name = name;
  return material;
}

describe("resolveEquipmentSlotMaterial", () => {
  it("uses a baked color only for authorial custom source material names", () => {
    const material = resolveEquipmentSlotMaterial(
      sourceMaterial("custom_bake_slot", "#11ccf0"),
      proofItem,
      null,
      { kind: "lit" },
    );

    if (Array.isArray(material)) throw new Error("expected a single material");
    expect(material.name).toBe("successor-lit-equipment:baked:#11ccf0");
  });

  it("treats legacy/default source names as non-authorial and falls back to the piece preset", () => {
    const material = resolveEquipmentSlotMaterial(
      sourceMaterial("PF_Hard", "#11ccf0"),
      armorItem,
      null,
      { kind: "lit" },
    );

    if (Array.isArray(material)) throw new Error("expected a single material");
    expect(material.name).toBe("successor-lit-equipment:smooth_steel");
  });

  it("preserves material arrays slot-by-slot", () => {
    const materials = resolveEquipmentSlotMaterial(
      [sourceMaterial("Material.001", "#ffffff"), sourceMaterial("custom_bake_slot", "#22ddcc")],
      proofItem,
      null,
      { kind: "lit" },
    );

    if (!Array.isArray(materials)) throw new Error("expected a material array");
    expect(materials).toHaveLength(2);
    expect(materials[1]!.name).toBe("successor-lit-equipment:baked:#22ddcc");
  });

  it("keeps hair preset override ahead of source material color", () => {
    const material = resolveEquipmentSlotMaterial(
      sourceMaterial("custom_bake_slot", "#22ddcc"),
      { id: "hair_afro2", name: "Afro", layer: "Under" as const, slot: "cranium", glb: "Under/Hair_Afro.glb" },
      "hair_crimson",
      { kind: "lit" },
    );

    if (Array.isArray(material)) throw new Error("expected a single material");
    expect(material.name).toBe("successor-lit-equipment:hair_crimson");
  });
});
