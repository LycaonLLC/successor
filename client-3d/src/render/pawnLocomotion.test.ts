import { describe, expect, it } from "vitest";
import { SUCCESSOR_3D_CONFIG } from "../config";
import { locomotionTimeScale } from "./pawnLocomotion";

// Unarmed walk_f authored travel speed after pack scaling: 1.399 m/s ×
// (1.7 / 1.7525) = 1.357 cells/s (see config.ts walk/run gate derivation).
const WALK_CLIP_CELLS_PER_SEC = 1.357;

describe("locomotionTimeScale", () => {
  it("tracks displacement through the low-speed band instead of clamping to a fast floor", () => {
    // Creep speeds just above the idle gate must play at the true
    // speed/clipSpeed ratio — the old 0.4 floor animated legs 4-8x faster
    // than the ground moved (foot sliding).
    expect(locomotionTimeScale(0.1, WALK_CLIP_CELLS_PER_SEC)).toBeCloseTo(0.1 / WALK_CLIP_CELLS_PER_SEC, 5);
    expect(locomotionTimeScale(0.3, WALK_CLIP_CELLS_PER_SEC)).toBeCloseTo(0.3 / WALK_CLIP_CELLS_PER_SEC, 5);
  });

  it("covers everything the idle gate hands over: residual slide at the floor is imperceptible", () => {
    const { min } = SUCCESSOR_3D_CONFIG.pawnPack.timeScaleClamp;
    // Below the idle threshold the idle clip owns the pawn, so the floor
    // only has to be honest from idleSpeedCellsPerSec upward.
    const idle = SUCCESSOR_3D_CONFIG.pawnPack.idleSpeedCellsPerSec;
    const shownCellsPerSec = locomotionTimeScale(idle, WALK_CLIP_CELLS_PER_SEC) * WALK_CLIP_CELLS_PER_SEC;
    expect(Math.abs(shownCellsPerSec - idle)).toBeLessThan(0.02);
    // The floor stays > 0 so the mixer never freezes mid-stride.
    expect(locomotionTimeScale(0, WALK_CLIP_CELLS_PER_SEC)).toBe(min);
    expect(min).toBeGreaterThan(0);
  });

  it("plays the walk clip at ~1x at authored server walk speed", () => {
    expect(locomotionTimeScale(1.357, WALK_CLIP_CELLS_PER_SEC)).toBeCloseTo(1, 3);
  });

  it("caps retiming at the configured max", () => {
    expect(locomotionTimeScale(100, WALK_CLIP_CELLS_PER_SEC)).toBe(SUCCESSOR_3D_CONFIG.pawnPack.timeScaleClamp.max);
  });

  it("falls back to 1x when the clip has no authored travel speed", () => {
    expect(locomotionTimeScale(2, 0)).toBe(1);
  });
});
