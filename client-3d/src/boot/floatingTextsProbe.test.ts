import { describe, expect, it } from "vitest";
import type { FloatingCombatText } from "@successor/client/src/slice-core/effectsSystem";
import { projectFloatingTextsProbe } from "./floatingTextsProbe";

describe("projectFloatingTextsProbe", () => {
  it("projects status labels such as HARVESTED into read-only probe entries", () => {
    const raw: FloatingCombatText[] = [
      {
        id: 1,
        actorId: "gaia-corpse-1",
        x: 10.5,
        y: 12.5,
        driftX: 0.1,
        value: null,
        label: "HARVESTED",
        ttlMs: 850,
        totalTtlMs: 900,
        color: "#ffffff",
        scale: 1,
      },
    ];

    const projected = projectFloatingTextsProbe(raw);

    expect(projected).toEqual([
      {
        id: 1,
        label: "HARVESTED",
        actorId: "gaia-corpse-1",
        ttlMs: 850,
        color: "#ffffff",
      },
    ]);
  });

  it("projects numerical damage pops when label is null", () => {
    const raw: FloatingCombatText[] = [
      {
        id: 2,
        x: 5,
        y: 5,
        driftX: 0,
        value: 42,
        label: null,
        ttlMs: 500,
        totalTtlMs: 780,
        color: "#ff4747",
        scale: 1,
      },
    ];

    const projected = projectFloatingTextsProbe(raw);

    expect(projected).toEqual([
      {
        id: 2,
        label: "42",
        actorId: null,
        ttlMs: 500,
        color: "#ff4747",
      },
    ]);
  });
});
