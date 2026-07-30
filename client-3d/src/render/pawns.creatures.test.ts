// @vitest-environment happy-dom
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREATURE_SPECIES_BY_SPRITE,
  resolveCreatureAnimIntent,
  resolveCreatureRestPlayback,
} from "./pawns";

/**
 * Gaia creature lane contract: the sprite->species registry is the ONLY
 * routing table for the rigged creature renderer, and the pure anim-intent
 * resolver owns the idle/walk/rest state mapping the mixer executes.
 */

const EXPECTED_SPRITES = [
  "creature-bellback-adult",
  "creature-dapplepod-adult",
  "creature-mossmuff-adult",
  "creature-pebblehorn-adult",
  "creature-pocketclod-adult",
  "creature-snufflefin-adult",
];

describe("CREATURE_SPECIES_BY_SPRITE registry", () => {
  it("routes exactly the six accepted adult sprite keys", () => {
    expect(Object.keys(CREATURE_SPECIES_BY_SPRITE).sort()).toEqual(EXPECTED_SPRITES);
  });

  it("maps every sprite to its own <species>_adult.glb (no shared template)", () => {
    const paths = new Set<string>();
    for (const [sprite, def] of Object.entries(CREATURE_SPECIES_BY_SPRITE)) {
      expect(sprite).toBe(`creature-${def.speciesId}-adult`);
      expect(def.assetPath).toBe(`/assets/creatures/${def.speciesId}_adult.glb`);
      paths.add(def.assetPath);
    }
    expect(paths.size).toBe(EXPECTED_SPRITES.length);
  });

  it("every registered GLB is shipped in client-3d/public", () => {
    // vitest root = client-3d (vitest.config.ts), so cwd anchors public/.
    const publicRoot = resolve(process.cwd(), "public");
    for (const def of Object.values(CREATURE_SPECIES_BY_SPRITE)) {
      expect(existsSync(`${publicRoot}${def.assetPath}`), def.assetPath).toBe(true);
    }
  });

  it("carries a positive per-species scale and shadow footprint", () => {
    for (const def of Object.values(CREATURE_SPECIES_BY_SPRITE)) {
      expect(def.meshScale).toBeGreaterThan(0);
      expect(def.shadowScaleX).toBeGreaterThan(0);
      expect(def.shadowScaleZ).toBeGreaterThan(0);
    }
  });

  it("small authored species are scaled to overworld-mob height (live-proof tuning)", () => {
    // Authored heights: snufflefin 0.39m, pocketclod 0.65m, dapplepod 0.76m —
    // scaled to ≈0.94m / 0.98m / 0.99m so regular mobs read next to a pawn.
    const meshScaleBySpecies: Record<string, number> = {
      bellback: 1,
      pebblehorn: 1,
      mossmuff: 1,
      snufflefin: 2.4,
      pocketclod: 1.5,
      dapplepod: 1.3,
    };
    for (const def of Object.values(CREATURE_SPECIES_BY_SPRITE)) {
      expect(def.meshScale, def.speciesId).toBe(meshScaleBySpecies[def.speciesId]);
    }
  });
});

describe("resolveCreatureAnimIntent — idle/walk/rest mapping", () => {
  it("still + alive holds the idle loop", () => {
    expect(resolveCreatureAnimIntent({ down: false, bornDown: false, moving: false, speedCellsPerSec: 0 }))
      .toEqual({ clip: "idle", timeScale: 1, snapToHold: false });
  });

  it("moving plays walk with speed-proportional playback", () => {
    const intent = resolveCreatureAnimIntent({ down: false, bornDown: false, moving: true, speedCellsPerSec: 0.9 });
    expect(intent.clip).toBe("walk");
    expect(intent.timeScale).toBeCloseTo(0.9);
  });

  it("clamps walk playback so slow drift never moonwalks and bursts never strobe", () => {
    const slow = resolveCreatureAnimIntent({ down: false, bornDown: false, moving: true, speedCellsPerSec: 0.05 });
    const fast = resolveCreatureAnimIntent({ down: false, bornDown: false, moving: true, speedCellsPerSec: 9 });
    expect(slow.timeScale).toBe(0.5);
    expect(fast.timeScale).toBe(1.6);
  });

  it("downed plays the one-shot rest settle (fresh death does NOT snap)", () => {
    expect(resolveCreatureAnimIntent({ down: true, bornDown: false, moving: false, speedCellsPerSec: 0 }))
      .toEqual({ clip: "rest", timeScale: 1, snapToHold: false });
  });

  it("join-in-progress corpses snap straight to the stable rest hold", () => {
    expect(resolveCreatureAnimIntent({ down: true, bornDown: true, moving: false, speedCellsPerSec: 0 }))
      .toEqual({ clip: "rest", timeScale: 1, snapToHold: true });
  });

  it("down wins over movement (a dragged corpse never walks)", () => {
    const intent = resolveCreatureAnimIntent({ down: true, bornDown: false, moving: true, speedCellsPerSec: 2 });
    expect(intent.clip).toBe("rest");
  });

  it("revive sequence returns to idle once no longer down", () => {
    const downed = resolveCreatureAnimIntent({ down: true, bornDown: false, moving: false, speedCellsPerSec: 0 });
    const revived = resolveCreatureAnimIntent({ down: false, bornDown: false, moving: false, speedCellsPerSec: 0 });
    expect(downed.clip).toBe("rest");
    expect(revived.clip).toBe("idle");
  });
});

describe("resolveCreatureRestPlayback — reversible rest hold", () => {
  it("holds inside every measured species' stable downed-pose plateau", () => {
    const plateauBySpecies: Record<string, readonly [number, number]> = {
      bellback: [0.69, 0.96],
      dapplepod: [0.49, 0.92],
      mossmuff: [0.31, 0.92],
      pebblehorn: [0.45, 0.86],
      pocketclod: [0.30, 0.93],
      snufflefin: [0.50, 0.88],
    };
    const holdFraction = resolveCreatureRestPlayback({
      clipDurationSeconds: 1,
      currentTimeSeconds: 0,
      dtSeconds: 0,
      snapToHold: true,
    }).holdTimeSeconds;
    for (const [species, [start, end]] of Object.entries(plateauBySpecies)) {
      expect(holdFraction, species).toBeGreaterThanOrEqual(start);
      expect(holdFraction, species).toBeLessThanOrEqual(end);
    }
  });

  it("snaps a born-down creature to 75% of the clip and freezes immediately", () => {
    expect(resolveCreatureRestPlayback({
      clipDurationSeconds: 8,
      currentTimeSeconds: 0,
      dtSeconds: 0,
      snapToHold: true,
    })).toEqual({
      holdTimeSeconds: 6,
      nextTimeSeconds: 6,
      advanceSeconds: 0,
      shouldPause: true,
    });
  });

  it("lets a live death settle to 75%, then clips the final step and freezes", () => {
    const beforeHold = resolveCreatureRestPlayback({
      clipDurationSeconds: 8,
      currentTimeSeconds: 5.8,
      dtSeconds: 0.1,
      snapToHold: false,
    });
    expect(beforeHold.nextTimeSeconds).toBeCloseTo(5.9);
    expect(beforeHold.shouldPause).toBe(false);

    const atHold = resolveCreatureRestPlayback({
      clipDurationSeconds: 8,
      currentTimeSeconds: beforeHold.nextTimeSeconds,
      dtSeconds: 0.2,
      snapToHold: false,
    });
    expect(atHold.holdTimeSeconds).toBe(6);
    expect(atHold.nextTimeSeconds).toBe(6);
    expect(atHold.advanceSeconds).toBeCloseTo(0.1);
    expect(atHold.shouldPause).toBe(true);
  });
});
