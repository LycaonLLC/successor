import { describe, expect, it } from "vitest";
import { SUCCESSOR_3D_CONFIG } from "../config";
import {
  atmosphereDensityScale,
  interpolatePs2TimeOfDayGrade,
  mixAtmosphereParams,
  projectWindToScreenUv,
  type BiomeAtmosphereParams,
} from "./post";

describe("interpolatePs2TimeOfDayGrade", () => {
  it("keeps the owner-ratified noon fog, tint, desaturation, and darken defaults exact", () => {
    const noon = interpolatePs2TimeOfDayGrade(720, 0.72);
    const noonFog = Number.parseInt(SUCCESSOR_3D_CONFIG.renderer.clearColor.slice(1), 16);
    const noonFogRgb = [((noonFog >> 16) & 255) / 255, ((noonFog >> 8) & 255) / 255, (noonFog & 255) / 255];

    expect(noon.fogClearColor).toEqual(noonFogRgb);
    expect(noon.clearColor).toBe(noon.fogClearColor);
    expect(noon.boneTint).toEqual([...SUCCESSOR_3D_CONFIG.renderer.post.boneTint]);
    expect(noon.desaturate).toBe(SUCCESSOR_3D_CONFIG.renderer.post.desaturate);
    expect(noon.sceneDarken).toBe(1);
    expect(noon.blackLift).toBe(0.03);
    expect(noon.bloomStrength).toBe(0.35);
  });

  it("is continuous across the 1440-to-0 wrap", () => {
    const atZero = interpolatePs2TimeOfDayGrade(0);
    const atDayEnd = interpolatePs2TimeOfDayGrade(1440);
    const justBeforeWrap = interpolatePs2TimeOfDayGrade(1439);

    expect(atDayEnd.fogClearColor).toEqual(atZero.fogClearColor);
    expect(atDayEnd.boneTint).toEqual(atZero.boneTint);
    expect(atDayEnd.desaturate).toBe(atZero.desaturate);
    expect(atDayEnd.sceneDarken).toBe(atZero.sceneDarken);
    expect(atDayEnd.blackLift).toBe(atZero.blackLift);
    expect(atDayEnd.bloomStrength).toBe(atZero.bloomStrength);
    expect(Math.abs(justBeforeWrap.sceneDarken - atZero.sceneDarken)).toBeLessThan(0.001);
  });

  it("smoothly and monotonically blends inside a segment", () => {
    const early = interpolatePs2TimeOfDayGrade(60);
    const middle = interpolatePs2TimeOfDayGrade(180);
    const late = interpolatePs2TimeOfDayGrade(300);

    expect(early.sceneDarken).toBeGreaterThan(0.38);
    expect(middle.sceneDarken).toBeGreaterThan(early.sceneDarken);
    expect(late.sceneDarken).toBeGreaterThan(middle.sceneDarken);
    expect(late.sceneDarken).toBeLessThan(0.85);
  });

  it("returns a single shared fog/clear colour tuple for every sampled minute", () => {
    for (let minute = 0; minute <= 1440; minute += 37) {
      const grade = interpolatePs2TimeOfDayGrade(minute);
      expect(grade.clearColor).toBe(grade.fogClearColor);
    }
  });
});

function biomeParams(biome: "desert" | "forest"): BiomeAtmosphereParams {
  const src = SUCCESSOR_3D_CONFIG.biomes[biome].atmosphere;
  return {
    borderWidth: src.borderWidth,
    cornerBoost: src.cornerBoost,
    topBias: src.topBias,
    bottomBias: src.bottomBias,
    windRise: src.windRise,
    driftScale: src.driftScale,
    noiseScale: src.noiseScale,
    borderStrength: src.borderStrength,
    accentTint: [src.accentTint[0], src.accentTint[1], src.accentTint[2]],
    moteStrength: src.moteStrength,
    gustiness: src.gustiness,
    nightDensityScale: src.nightDensityScale,
  };
}

describe("border atmosphere", () => {
  it("cross-fades biome params exactly at the endpoints and monotonically between", () => {
    const desert = biomeParams("desert");
    const forest = biomeParams("forest");
    const out = biomeParams("desert");

    mixAtmosphereParams(out, desert, forest, 0);
    expect(out.bottomBias).toBe(desert.bottomBias);
    expect(out.accentTint).toEqual(desert.accentTint);

    mixAtmosphereParams(out, desert, forest, 1);
    expect(out.bottomBias).toBeCloseTo(forest.bottomBias, 12);
    expect(out.driftScale).toBeCloseTo(forest.driftScale, 12);
    expect(out.accentTint[0]).toBeCloseTo(forest.accentTint[0], 12);
    expect(out.accentTint[1]).toBeCloseTo(forest.accentTint[1], 12);
    expect(out.accentTint[2]).toBeCloseTo(forest.accentTint[2], 12);

    mixAtmosphereParams(out, desert, forest, 0.5);
    expect(out.bottomBias).toBeGreaterThan(Math.min(desert.bottomBias, forest.bottomBias));
    expect(out.bottomBias).toBeLessThan(Math.max(desert.bottomBias, forest.bottomBias));
    // Clamped outside [0, 1].
    mixAtmosphereParams(out, desert, forest, 2);
    expect(out.bottomBias).toBeCloseTo(forest.bottomBias, 12);
  });

  it("projects north-up wind into screen UV with biome rise/sink", () => {
    // Pure +x/east wind drifts only screen-right.
    const [eastX, eastY] = projectWindToScreenUv(1, 0, 0);
    expect(eastX).toBe(1);
    expect(eastY).toBe(0);
    // Raw -z/north drifts screen-up in UV convention.
    const [northX, northY] = projectWindToScreenUv(0, -1, 0);
    expect(northX).toBe(0);
    expect(northY).toBeGreaterThan(0);
    // Rise lifts the vertical component without touching horizontal.
    const [risenX, risenY] = projectWindToScreenUv(1, 0, 0.05);
    expect(risenX).toBe(eastX);
    expect(risenY).toBeCloseTo(eastY + 0.05, 12);
  });

  it("breathes density with gusts and blends toward each biome's night register", () => {
    // Gustless air is constant.
    expect(atmosphereDensityScale(0.5, 1, 0, 1)).toBe(1);
    // Gust crest kicks more than the trough at full gustiness.
    const trough = atmosphereDensityScale(0, 1, 1, 1);
    const crest = atmosphereDensityScale(1, 1, 1, 1);
    expect(crest).toBeGreaterThan(trough);
    // Desert air settles at night; Verdance mist thickens.
    const desert = biomeParams("desert");
    const forest = biomeParams("forest");
    expect(atmosphereDensityScale(0.5, 0, 0, desert.nightDensityScale))
      .toBeLessThan(atmosphereDensityScale(0.5, 1, 0, desert.nightDensityScale));
    expect(atmosphereDensityScale(0.5, 0, 0, forest.nightDensityScale))
      .toBeGreaterThan(atmosphereDensityScale(0.5, 1, 0, forest.nightDensityScale));
  });
});
