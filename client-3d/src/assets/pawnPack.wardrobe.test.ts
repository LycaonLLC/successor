import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pawnPack.ts pulls in ui/inventory/data -> render/pawns, which builds a canvas
// at module scope; a null-context stub satisfies it in the node env. Static
// imports hoist, so the module under test comes in dynamically after the stub.
(globalThis as { document?: unknown }).document ??= {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => null }),
};
const { buildWardrobeCatalog } = await import("./pawnPack");
type PawnEquipmentPack = import("./pawnPack").PawnEquipmentPack;
type PawnEquipmentItem = import("./pawnPack").PawnEquipmentItem;

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "..", "..", "public", "assets", "pawn-pack", "equipment", "manifest.json");

interface ManifestItem {
  id: string; name: string; layer: PawnEquipmentItem["layer"]; group: string; slot: string;
  glb: string; mat?: string; requires?: string[]; viewerOnly?: boolean;
}

function realEquipmentPack(extra: ManifestItem[] = []): PawnEquipmentPack {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { items: ManifestItem[] };
  const items: PawnEquipmentItem[] = [...manifest.items, ...extra].map((raw) => ({
    id: raw.id,
    name: raw.name,
    layer: raw.layer,
    group: raw.group,
    slot: raw.slot,
    glb: raw.glb,
    mat: raw.mat,
    requires: raw.requires ?? [],
    viewerOnly: raw.viewerOnly,
  }));
  return { basePath: "assets/pawn-pack/equipment", items, scenes: new Map() } as unknown as PawnEquipmentPack;
}

describe("wardrobe inventory catalog (owner ruling: hair is appearance, never an item)", () => {
  it("emits ZERO hair entries from the shipped equipment manifest — oracle", () => {
    const catalog = buildWardrobeCatalog(realEquipmentPack());
    expect(catalog.filter((entry) => entry.id.startsWith("hair_"))).toEqual([]);
    // The filter must be SELECTIVE, not accidentally empty: real wardrobe still lands.
    expect(catalog.some((entry) => entry.id === "under_tank")).toBe(true);
    expect(catalog.some((entry) => entry.id === "under_shorts")).toBe(true);
    expect(catalog.some((entry) => entry.id === "helmet_s2")).toBe(true);
  });

  it("keeps new Hair-group items OUT of inventory (WardrobeCreator's future hairs)", () => {
    const catalog = buildWardrobeCatalog(realEquipmentPack([
      { id: "hair_ponytail_long", name: "Long Ponytail", layer: "Under", group: "Hair", slot: "cranium", glb: "Under/Hair_Ponytail.glb" },
      { id: "hair_buzz", name: "Buzz", layer: "Under", group: "Hair", slot: "cranium", glb: "Under/Hair_Buzz.glb" },
    ]));
    expect(catalog.some((entry) => entry.id.startsWith("hair_"))).toBe(false);
  });
});
