import { describe, expect, it } from "vitest";

import { AreaWeatherController, sweepDirRadForArea } from "./weather.js";

const baseWeatherConfig = {
  areaId: "open-desert-overworld",
  eventType: "sandstorm",
  centerCell: { x: 512, y: 512 },
  radiusCells: 48,
  spawnRadiusCells: 320,
  magnitudeRange: [0.45, 1] as [number, number],
  periodTicks: { idle: 10, warning: 4, active: 6, decay: 5 },
  dpsMilliHealth: 8_000,
  phaseOffsetTicks: 0,
};

describe("AreaWeatherController", () => {
  it("derives restart-stable phases, end ticks, and intensity ramps from tick only", () => {
    const controller = new AreaWeatherController(baseWeatherConfig, {});

    expect(controller.snapshotAtTick(0)).toMatchObject({ phase: "idle", intensity: 0, phaseEndsAtTick: 10 });
    expect(controller.snapshotAtTick(9)).toMatchObject({ phase: "idle", intensity: 0, phaseEndsAtTick: 10 });
    expect(controller.snapshotAtTick(10)).toMatchObject({ phase: "warning", intensity: 0, phaseEndsAtTick: 14 });
    expect(controller.snapshotAtTick(12)).toMatchObject({ phase: "warning", intensity: 0.5, phaseEndsAtTick: 14 });
    expect(controller.snapshotAtTick(14)).toMatchObject({ phase: "active", intensity: 1, phaseEndsAtTick: 20 });
    expect(controller.snapshotAtTick(20)).toMatchObject({ phase: "decay", intensity: 1, phaseEndsAtTick: 25 });
    expect(controller.snapshotAtTick(24)).toMatchObject({ phase: "decay", intensity: 0.2, phaseEndsAtTick: 25 });
    expect(controller.snapshotAtTick(25)).toMatchObject({ phase: "idle", intensity: 0, phaseEndsAtTick: 35 });
    expect(controller.snapshotAtTick(10)).toMatchObject({ resolvesAtTick: 25 });
    expect(controller.snapshotAtTick(14)).toMatchObject({ resolvesAtTick: 25 });
    expect(controller.snapshotAtTick(20)).toMatchObject({ resolvesAtTick: 25 });
    expect(controller.snapshotAtTick(25)).toMatchObject({ resolvesAtTick: 35 });
  });

  it("applies phaseOffsetTicks by advancing through the same deterministic cycle", () => {
    const controller = new AreaWeatherController({ ...baseWeatherConfig, phaseOffsetTicks: 12 }, {});

    expect(controller.snapshotAtTick(0)).toMatchObject({ phase: "warning", intensity: 0.5, phaseEndsAtTick: 2 });
    expect(controller.snapshotAtTick(2)).toMatchObject({ phase: "active", intensity: 1, phaseEndsAtTick: 8 });
  });

  it("derives a deterministic sweep direction from areaId and accepts explicit overrides", () => {
    const controller = new AreaWeatherController(baseWeatherConfig, {});
    const override = new AreaWeatherController({ ...baseWeatherConfig, sweepDirRad: Math.PI / 3 }, {});

    expect(sweepDirRadForArea("open-desert-overworld")).toBeCloseTo(1.2112585008840648, 12);
    expect(controller.snapshotAtTick(0).sweepDirRad).toBeCloseTo(1.2112585008840648, 12);
    expect(override.snapshotAtTick(0).sweepDirRad).toBeCloseTo(Math.PI / 3, 12);
  });

  it("scales period ticks through GAME_WEATHER_PERIOD_SCALE", () => {
    const controller = new AreaWeatherController(baseWeatherConfig, { GAME_WEATHER_PERIOD_SCALE: "0.5" });

    expect(controller.periodTicks).toEqual({ idle: 5, warning: 2, active: 3, decay: 3 });
    expect(controller.snapshotAtTick(5)).toMatchObject({ phase: "warning", intensity: 0, phaseEndsAtTick: 7 });
    expect(controller.snapshotAtTick(6)).toMatchObject({ phase: "warning", intensity: 0.5, phaseEndsAtTick: 7 });
    expect(controller.snapshotAtTick(7)).toMatchObject({ phase: "active", intensity: 1, phaseEndsAtTick: 10 });
  });

  it("pins the phase through GAME_WEATHER_FORCE_PHASE without introducing hidden state", () => {
    const controller = new AreaWeatherController(baseWeatherConfig, { GAME_WEATHER_FORCE_PHASE: "active" });

    expect(controller.snapshotAtTick(0)).toMatchObject({ phase: "active", intensity: 1, phaseEndsAtTick: 6 });
    expect(controller.snapshotAtTick(7)).toMatchObject({ phase: "active", intensity: 1, phaseEndsAtTick: 12 });
  });

  it("keeps the rolled center and magnitude stable for every tick in one cycle", () => {
    const ticksInsideInstance = [10, 13, 14, 19, 20, 24];
    const snapshots = ticksInsideInstance.map((tick) => {
      const restarted = new AreaWeatherController(baseWeatherConfig, {}, { worldSeed: 424242, mapWidthCells: 1024, mapHeightCells: 1024 });
      const snapshot = restarted.snapshotAtTick(tick);
      return { centerX: snapshot.centerX, centerY: snapshot.centerY, magnitude: snapshot.magnitude, radiusCells: snapshot.radiusCells };
    });

    expect(new Set(snapshots.map((snapshot) => JSON.stringify(snapshot))).size).toBe(1);
  });

  it("rolls different center or magnitude values across cycles", () => {
    const controller = new AreaWeatherController(baseWeatherConfig, {}, { worldSeed: 424242, mapWidthCells: 1024, mapHeightCells: 1024 });
    const first = controller.snapshotAtTick(12);
    const second = controller.snapshotAtTick(37);

    expect({
      centerX: second.centerX,
      centerY: second.centerY,
      magnitude: second.magnitude,
    }).not.toEqual({
      centerX: first.centerX,
      centerY: first.centerY,
      magnitude: first.magnitude,
    });
  });

  it("clamps rolled centers so the whole storm stays on-map", () => {
    const controller = new AreaWeatherController(
      {
        ...baseWeatherConfig,
        centerCell: { x: 20, y: 20 },
        radiusCells: 48,
        spawnRadiusCells: 320,
      },
      {},
      { worldSeed: 424242, mapWidthCells: 128, mapHeightCells: 128 },
    );

    for (const tick of [0, 12, 37, 62, 87]) {
      const snapshot = controller.snapshotAtTick(tick);
      expect(snapshot.centerX).toBeGreaterThanOrEqual(64);
      expect(snapshot.centerX).toBeLessThanOrEqual(64);
      expect(snapshot.centerY).toBeGreaterThanOrEqual(64);
      expect(snapshot.centerY).toBeLessThanOrEqual(64);
    }
  });

  it("pins center and magnitude through GAME_WEATHER_PIN_CENTER", () => {
    const controller = new AreaWeatherController(
      baseWeatherConfig,
      { GAME_WEATHER_PIN_CENTER: "1" },
      { worldSeed: 424242, mapWidthCells: 1024, mapHeightCells: 1024 },
    );

    expect(controller.snapshotAtTick(12)).toMatchObject({ centerX: 512, centerY: 512, magnitude: 1, radiusCells: 192 });
    expect(controller.snapshotAtTick(37)).toMatchObject({ centerX: 512, centerY: 512, magnitude: 1, radiusCells: 192 });
  });
  it("rolls a boosted hazard radius in the 2.5x-4x band on top of the configured base", () => {
    const controller = new AreaWeatherController(baseWeatherConfig, {}, { worldSeed: 424242, mapWidthCells: 1024, mapHeightCells: 1024 });
    const radii = new Set<number>();
    for (let cycle = 0; cycle < 24; cycle += 1) {
      const { radiusCells } = controller.snapshotAtTick(cycle * 25 + 14);
      expect(radiusCells).toBeGreaterThanOrEqual(baseWeatherConfig.radiusCells * 2.5);
      expect(radiusCells).toBeLessThanOrEqual(baseWeatherConfig.radiusCells * 4);
      radii.add(radiusCells);
    }
    expect(radii.size).toBeGreaterThan(4);
  });

  it("keeps the rolled radius stable for every tick in one cycle and varies it across cycles", () => {
    const controller = new AreaWeatherController(baseWeatherConfig, {}, { worldSeed: 424242, mapWidthCells: 1024, mapHeightCells: 1024 });
    const withinCycle = [10, 13, 14, 19, 20, 24].map((tick) => controller.snapshotAtTick(tick).radiusCells);
    expect(new Set(withinCycle).size).toBe(1);
    expect(controller.snapshotAtTick(37).radiusCells).not.toBe(controller.snapshotAtTick(12).radiusCells);
  });

  it("stays byte-identical for magnitude and center after adding the size roll (determinism)", () => {
    const controller = new AreaWeatherController(baseWeatherConfig, {}, { worldSeed: 424242, mapWidthCells: 1024, mapHeightCells: 1024 });
    const first = controller.snapshotAtTick(12);
    const second = new AreaWeatherController(baseWeatherConfig, {}, { worldSeed: 424242, mapWidthCells: 1024, mapHeightCells: 1024 }).snapshotAtTick(12);
    expect({ centerX: second.centerX, centerY: second.centerY, magnitude: second.magnitude, radiusCells: second.radiusCells })
      .toEqual({ centerX: first.centerX, centerY: first.centerY, magnitude: first.magnitude, radiusCells: first.radiusCells });
  });

  it("honors a per-fixture radiusScaleRange override (1x disables the boost)", () => {
    const controller = new AreaWeatherController(
      { ...baseWeatherConfig, radiusScaleRange: [1, 1] },
      {},
      { worldSeed: 424242, mapWidthCells: 1024, mapHeightCells: 1024 },
    );
    for (const tick of [14, 39, 64]) {
      expect(controller.snapshotAtTick(tick).radiusCells).toBe(baseWeatherConfig.radiusCells);
    }
  });
});
