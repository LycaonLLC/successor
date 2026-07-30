import { describe, expect, it } from "vitest";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { clearingMaskAt, paintTerrainPixel } from "./procgen";

const WIND_RAD = (SUCCESSOR_3D_CONFIG.environment.wind.baseDirDeg * Math.PI) / 180;
const WIND_X = Math.cos(WIND_RAD);
const WIND_Z = Math.sin(WIND_RAD);
const ACROSS_WIND_X = -WIND_Z;
const ACROSS_WIND_Z = WIND_X;

function terrainSample(seed: number, x: number, z: number, biome: "desert" | "forest" = "desert"): { kind: number; r: number; g: number; b: number } {
  const pixel = new Uint8ClampedArray(4);
  const kind = paintTerrainPixel(seed, x, z, pixel, 0, biome);
  return { kind, r: pixel[0] ?? 0, g: pixel[1] ?? 0, b: pixel[2] ?? 0 };
}

function terrainLuma(seed: number, x: number, z: number, biome: "desert" | "forest" = "desert"): number {
  const sample = terrainSample(seed, x, z, biome);
  return sample.r * 0.2126 + sample.g * 0.7152 + sample.b * 0.0722;
}

function valueVariance(seed: number, originX: number, originZ: number, dirX: number, dirZ: number): number {
  let sum = 0;
  let sumSquares = 0;
  const count = 41;
  const center = (count - 1) / 2;
  for (let i = 0; i < count; i += 1) {
    const distance = (i - center) * 1.25;
    const value = terrainLuma(seed, originX + dirX * distance, originZ + dirZ * distance);
    sum += value;
    sumSquares += value * value;
  }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

describe("paintTerrainPixel", () => {
  it("is deterministic for the same seed and world coordinate", () => {
    const a = terrainSample(0x1a2b_3c4d, 123.75, -44.5);
    const b = terrainSample(0x1a2b_3c4d, 123.75, -44.5);

    expect(b).toEqual(a);
  });

  it("keeps desert regression texels byte-identical", () => {
    expect(terrainSample(0x0d3d_071e, 0, 0)).toEqual({ kind: 0, r: 218, g: 173, b: 97 });
    expect(terrainSample(0x0d3d_071e, 96.25, -142.75)).toEqual({ kind: 0, r: 218, g: 173, b: 97 });
    expect(terrainSample(0x1a2b_3c4d, 123.75, -44.5)).toEqual({ kind: 2, r: 226, g: 192, b: 125 });
    expect(terrainSample(0xfeed_c0de, 512.5, 512.5)).toEqual({ kind: 0, r: 224, g: 178, b: 99 });
  });

  it("varies less along the wind-combed dune axis than across it", () => {
    const seed = 0x0d3d_071e;
    const originX = 96.25;
    const originZ = -142.75;

    const alongVariance = valueVariance(seed, originX, originZ, WIND_X, WIND_Z);
    const acrossVariance = valueVariance(seed, originX, originZ, ACROSS_WIND_X, ACROSS_WIND_Z);

    expect(alongVariance).toBeLessThan(acrossVariance);
  });

  it("is deterministic for forest terrain", () => {
    const a = terrainSample(0x5150_f0e5, 532.25, 511.75, "forest");
    const b = terrainSample(0x5150_f0e5, 532.25, 511.75, "forest");

    expect(b).toEqual(a);
  });

  it("uses the exported clearing mask to lighten forest clearings", () => {
    const seed = 0x5150_f0e5;
    let darkX = 0;
    let darkZ = 0;
    let darkMask = Infinity;
    let clearX = 0;
    let clearZ = 0;
    let clearMask = -Infinity;
    for (let z = 0; z <= 1024; z += 8) {
      for (let x = 0; x <= 1024; x += 8) {
        const mask = clearingMaskAt(seed, x, z);
        if (mask < darkMask) {
          darkMask = mask;
          darkX = x;
          darkZ = z;
        }
        if (mask > clearMask) {
          clearMask = mask;
          clearX = x;
          clearZ = z;
        }
      }
    }

    expect(clearMask).toBeGreaterThan(darkMask);
    expect(terrainLuma(seed, clearX, clearZ, "forest")).toBeGreaterThan(terrainLuma(seed, darkX, darkZ, "forest"));
  });
});
