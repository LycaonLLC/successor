import { describe, expect, it } from "vitest";

import { createVoiceMemory } from "../voice";
import { composeArrival, composePhaseChange, composeWeatherChange, type SceneInputs, type SceneWeather } from "./scene";

function inputs(overrides: Partial<SceneInputs> = {}): SceneInputs {
  return {
    areaName: "Open Desert",
    biome: "desert",
    phase: "day",
    moonBrightness: 0.1,
    weather: null,
    hostiles: 0,
    contacts: 2,
    ...overrides,
  };
}

function weather(overrides: Partial<SceneWeather> = {}): SceneWeather {
  return {
    eventType: "sandstorm",
    phase: "warning",
    magnitude: 0.7,
    distanceCells: 55,
    wind: "north-east",
    inside: false,
    ...overrides,
  };
}

describe("scene register", () => {
  it("arrival names the place and the light", () => {
    const line = composeArrival(inputs(), createVoiceMemory(), 1);
    expect(line.toLowerCase()).toContain("open desert");
    expect(line).toMatch(/light|sun|heat/i);
  });

  it("arrival folds in weather and hostile pressure when present", () => {
    const line = composeArrival(inputs({ weather: weather(), hostiles: 2 }), createVoiceMemory(), 2);
    expect(line).toMatch(/sandstorm/);
    expect(line).toMatch(/north-east/);
    expect(line).toMatch(/two hostiles/i);
  });

  it("phase turns speak their own hour", () => {
    const memory = createVoiceMemory();
    expect(composePhaseChange(inputs({ phase: "dusk" }), memory, 3)).toMatch(/dusk|sundown|rust|light lowers/i);
    expect(composePhaseChange(inputs({ phase: "deep_night" }), memory, 4)).toMatch(/dead hours|deep night|cold/i);
  });

  it("night lines read the moon", () => {
    const bright = composePhaseChange(inputs({ phase: "night", moonBrightness: 0.6 }), createVoiceMemory(), 5);
    expect(bright).toMatch(/moon/i);
    const dark = composePhaseChange(inputs({ phase: "night", moonBrightness: 0.05 }), createVoiceMemory(), 6);
    expect(dark).toMatch(/no moon|dark is total/i);
  });

  it("weather transitions carry bearing at a distance and immediacy inside", () => {
    const far = composeWeatherChange(weather(), createVoiceMemory(), 7);
    expect(far).toMatch(/north-east/);
    const inside = composeWeatherChange(weather({ phase: "active", inside: true, distanceCells: 0 }), createVoiceMemory(), 8);
    expect(inside).toMatch(/inside|arrives|hammers|narrows/i);
    const decay = composeWeatherChange(weather({ phase: "decay" }), createVoiceMemory(), 9);
    expect(decay).toMatch(/passes|loses|wearing down/i);
  });
});
