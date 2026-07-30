import { describe, expect, it } from "vitest";
import { clearingMaskAt } from "../terrain/procgen";
import { floraPlacementCounts, planFloraChunk } from "./scatter";

describe("planFloraChunk", () => {
  it("is deterministic for the same seed and chunk", () => {
    const first = planFloraChunk(0x0d3d071e, -3, 7, 1);
    const second = planFloraChunk(0x0d3d071e, -3, 7, 1);

    expect(second).toEqual(first);
  });

  it("keeps base density inside the sparse-desert budget", () => {
    const samples = [
      [0x12345678, 4, -2],
      [0x0d3d071e, -9, 0],
      [0xfeedc0de, 12, 11],
    ] as const;

    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]!;
      const placements = planFloraChunk(sample[0], sample[1], sample[2], 1);
      const counts = floraPlacementCounts(placements);

      expect(counts.rock).toBeGreaterThanOrEqual(24);
      expect(counts.rock).toBeLessThanOrEqual(40);
      expect(counts.shrub_thorn).toBeGreaterThanOrEqual(12);
      expect(counts.shrub_thorn).toBeLessThanOrEqual(20);
      expect(counts.cactus_sentinel).toBeGreaterThanOrEqual(5);
      expect(counts.cactus_sentinel).toBeLessThanOrEqual(10);
      expect(counts.snag_acacia).toBeGreaterThanOrEqual(0);
      expect(counts.snag_acacia).toBeLessThanOrEqual(2);
      for (let j = 0; j < placements.length; j += 1) {
        const placement = placements[j]!;
        if (placement.species === "rock") expect(placement.y).toBeLessThan(0);
      }
    }
  });

  it("keeps forest density in the Verdance budget and excludes trees from clearings", () => {
    const samples = [
      [0x12345678, 4, -2],
      [0x0d3d071e, -9, 0],
      [0xfeedc0de, 12, 11],
    ] as const;

    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]!;
      const placements = planFloraChunk(sample[0], sample[1], sample[2], 1, "forest");
      const counts = floraPlacementCounts(placements);

      // Titan-forest budget: world-lattice acceptance sampling (binomial
      // variance across chunks; clearing rejection shaves the mean).
      expect(counts.pine).toBeGreaterThanOrEqual(8);
      expect(counts.pine).toBeLessThanOrEqual(45);
      expect(counts.broadleaf).toBeGreaterThanOrEqual(1);
      expect(counts.broadleaf).toBeLessThanOrEqual(16);
      expect(counts.sapling).toBeGreaterThanOrEqual(80);
      expect(counts.sapling).toBeLessThanOrEqual(140);
      expect(counts.fern).toBeGreaterThanOrEqual(160);
      expect(counts.fern).toBeLessThanOrEqual(260);
      expect(counts.log).toBeGreaterThanOrEqual(6);
      expect(counts.log).toBeLessThanOrEqual(12);
      expect(counts.mossy_boulder).toBeGreaterThanOrEqual(24);
      expect(counts.mossy_boulder).toBeLessThanOrEqual(40);
      expect(counts.stump).toBeGreaterThanOrEqual(1);
      expect(counts.stump).toBeLessThanOrEqual(3);

      for (let j = 0; j < placements.length; j += 1) {
        const placement = placements[j]!;
        if (placement.species !== "pine" && placement.species !== "broadleaf") continue;
        expect(clearingMaskAt(sample[0], placement.x, placement.z)).toBeLessThanOrEqual(0.6);
      }
    }
  });
});
