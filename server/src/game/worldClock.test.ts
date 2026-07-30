import { describe, expect, it } from "vitest";
import {
  createWorldClockConfig,
  formatWorldClock,
  formatWorldDate,
  ticksPerGameDay,
  worldClockSnapshot,
  worldClockStateAtTick,
} from "./worldClock.js";

describe("worldClock", () => {
  it("derives calendar phases from authoritative shard ticks", () => {
    const config = createWorldClockConfig({ tickRateHz: 30, realSecondsPerGameDay: 300, epochMinuteOfDay: 360 });

    expect(ticksPerGameDay(config)).toBe(9_000);
    expect(worldClockStateAtTick(config, 0).phase).toBe("dawn");
    expect(worldClockStateAtTick(config, 1_875).phase).toBe("day");
    expect(worldClockStateAtTick(config, 4_500).phase).toBe("dusk");
    expect(worldClockStateAtTick(config, 7_125).phase).toBe("deep_night");
  });

  it("keeps snapshot config explicit on full snapshots and compact on deltas", () => {
    const config = createWorldClockConfig({ tickRateHz: 30, realSecondsPerGameDay: 300 });

    expect(worldClockSnapshot(config, 0, true).config?.configId).toBe("successor-open-desert-300s-day-v1");
    expect(worldClockSnapshot(config, 0, false).config).toBeUndefined();
  });

  it("formats the world chronology consistently", () => {
    const config = createWorldClockConfig({ tickRateHz: 30, realSecondsPerGameDay: 300, epochMinuteOfDay: 360 });
    const state = worldClockStateAtTick(config, 9_000 * 31);

    expect(formatWorldClock(state)).toBe("06:00");
    expect(formatWorldDate(config, state)).toBe("Second Cycle 2, 1 SE");
  });
});
