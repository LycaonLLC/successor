import { describe, expect, it } from "vitest";
import {
  applyWorldClockSnapshot,
  createRuntimeWorldClock,
  createWorldClockConfig,
  formatWorldClock,
  formatWorldDate,
  projectedWorldClockState,
  ticksPerGameDay,
  worldClockStateAtTick,
} from "./worldClockSystem";

describe("worldClockSystem", () => {
  it("maps authoritative ticks into a five-minute observable day", () => {
    const config = createWorldClockConfig({ tickRateHz: 30, realSecondsPerGameDay: 300, epochMinuteOfDay: 360 });

    expect(ticksPerGameDay(config)).toBe(9_000);
    expect(worldClockStateAtTick(config, 0).minuteOfDay).toBe(360);
    expect(worldClockStateAtTick(config, 0).phase).toBe("dawn");
    expect(worldClockStateAtTick(config, 1_875).minuteOfDay).toBe(660);
    expect(worldClockStateAtTick(config, 1_875).phase).toBe("day");
    expect(worldClockStateAtTick(config, 4_500).minuteOfDay).toBe(1_080);
    expect(worldClockStateAtTick(config, 4_500).phase).toBe("dusk");
  });

  it("formats in-game date and clock labels from the same chronology", () => {
    const config = createWorldClockConfig({ tickRateHz: 30, realSecondsPerGameDay: 300, epochMinuteOfDay: 360 });
    const state = worldClockStateAtTick(config, 9_000 * 31);

    expect(formatWorldClock(state)).toBe("06:00");
    expect(formatWorldDate(config, state)).toBe("Second Cycle 2, 1 SE");
  });

  it("projects between snapshots without waiting for another server packet", () => {
    const runtime = createRuntimeWorldClock(30, 0);
    const next = applyWorldClockSnapshot(runtime, {
      ...worldClockStateAtTick(runtime.config, 0),
      config: runtime.config,
    }, 1_000);

    expect(projectedWorldClockState(next, 6_000).tick).toBe(150);
    expect(projectedWorldClockState(runtime, 6_000).tick).toBe(180);
  });
});
