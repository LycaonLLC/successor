import { describe, expect, it } from "vitest";
import type { SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { biomeIdFromSliceArea, effectiveWorldSeedFromSliceArea, worldSeedFromSlice } from "./TerrainStreamer";

function sliceWithAreas(areas: readonly { id: string; biome?: string }[], worldSeed = 0x0d3d_071e): SliceSnapshot {
  return { worldSeed, areas } as unknown as SliceSnapshot;
}

describe("terrain area biome context", () => {
  it("resolves additive area biome fields with the forest-id fallback", () => {
    const slice = sliceWithAreas([
      { id: "open-desert-overworld", biome: "desert" },
      { id: "verdance-forest-overworld", biome: "forest" },
    ]);

    expect(biomeIdFromSliceArea(slice, "open-desert-overworld")).toBe("desert");
    expect(biomeIdFromSliceArea(slice, "verdance-forest-overworld")).toBe("forest");
    expect(biomeIdFromSliceArea(sliceWithAreas([{ id: "verdance-forest-overworld" }]), "verdance-forest-overworld")).toBe("forest");
    expect(biomeIdFromSliceArea(sliceWithAreas([{ id: "dustgate" }]), "dustgate")).toBe("desert");
  });

  it("keeps Ashvat seed identity while deriving a distinct Verdance seed", () => {
    const slice = sliceWithAreas([
      { id: "open-desert-overworld", biome: "desert" },
      { id: "verdance-forest-overworld", biome: "forest" },
    ]);
    const baseSeed = worldSeedFromSlice(slice);
    const ashvatSeed = effectiveWorldSeedFromSliceArea(slice, "open-desert-overworld");
    const verdanceSeed = effectiveWorldSeedFromSliceArea(slice, "verdance-forest-overworld");

    expect(ashvatSeed).toBe(baseSeed);
    expect(verdanceSeed).not.toBe(baseSeed);
    expect(effectiveWorldSeedFromSliceArea(slice, "verdance-forest-overworld")).toBe(verdanceSeed);
  });
});
