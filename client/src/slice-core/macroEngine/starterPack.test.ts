import { describe, expect, it } from "vitest";

import { createPlayState, type PlayState, type SliceSnapshot } from "../gameState";
import { createVerbRegistry } from "../verbRegistry";
import { MACRO_ENGINE_DEFAULT_CAPS } from "./constants";
import { createMacroEngine } from "./engine";
import { parseMacroBody, utf8ByteLength } from "./parser";
import { LOCAL_MACRO_FILE_RULES, STARTER_MACROS, starterMacroByName, starterMacroIssues } from "./starterPack";

function sliceFixture(): SliceSnapshot {
  return {
    schema: "successor.slice.v1",
    tick: 10,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Test", width: 100, height: 100, level: 0 },
    areas: [{ id: "a", name: "A", kind: "overworld", width: 100, height: 100, level: 0 }],
    stateHash: "fixture",
    camera: { followActor: "player", zoom: 72 },
    factions: [
      { id: "desert_wardens", label: "Warden", enemies: ["rogue_troopers"] },
      { id: "rogue_troopers", label: "Rogues", enemies: ["desert_wardens"] },
    ],
    actors: [
      {
        id: "player",
        entity: "actor:player",
        areaId: "a",
        label: "Field Observer",
        role: "player",
        sprite: "adventurer-premium-male",
        poseSet: "idle",
        direction: "right",
        cell: { x: 1, y: 2 },
        route: [],
        factionId: "desert_wardens",
      },
    ],
    props: [],
    blockedCells: [],
    transitions: [],
    cloneFacilities: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function playFixture(slice: SliceSnapshot): PlayState {
  const state = createPlayState(slice);
  state.serverAuthority.playerActorId = "player";
  state.activeAreaId = "a";
  state.player = { x: 1, y: 2 };
  return state;
}

describe("macro starter pack", () => {
  it("ships only parser-valid templates under the engine body cap", () => {
    expect(STARTER_MACROS.length).toBeGreaterThan(0);
    for (const macro of STARTER_MACROS) {
      expect(() => parseMacroBody(macro.body)).not.toThrow();
      expect(utf8ByteLength(macro.body)).toBeLessThanOrEqual(MACRO_ENGINE_DEFAULT_CAPS.bodyBytes);
      expect(macro.name).toMatch(LOCAL_MACRO_FILE_RULES.namePattern);
      expect(macro.summary.length).toBeGreaterThan(0);
    }
  });

  it("resolves case-insensitively by name and misses honestly", () => {
    expect(starterMacroByName("Field-Report")?.name).toBe("field-report");
    expect(starterMacroByName("  OPEN-FIRE ")?.name).toBe("open-fire");
    expect(starterMacroByName("no-such-macro")).toBeNull();
  });

  it("uses only registered non-debug verbs and query-verb /until targets", () => {
    const slice = sliceFixture();
    const registry = createVerbRegistry({ state: playFixture(slice), slice });
    expect(starterMacroIssues(registry)).toEqual([]);
  });

  it("flags unknown, debug-gated, and non-query verbs when the registry disagrees", () => {
    const denyAll = { resolve: () => null };
    const issues = starterMacroIssues(denyAll);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes("unknown verb"))).toBe(true);

    const debugAll = { resolve: () => ({ kind: "authority", debugGated: true }) };
    expect(starterMacroIssues(debugAll).some((issue) => issue.includes("debug-gated"))).toBe(true);

    const noQueries = { resolve: (verb: string) => ({ kind: verb === "vitals" ? "local" : "authority" }) };
    expect(starterMacroIssues(noQueries).some((issue) => issue.includes("not a query verb"))).toBe(true);
  });

  it("every starter starts on a live engine backed by the real registry", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    const registry = createVerbRegistry({ state, slice });
    const engine = createMacroEngine({
      registry,
      caps: { runSlots: STARTER_MACROS.length },
      macros: STARTER_MACROS.map((macro) => ({ name: macro.name, body: macro.body, iconId: macro.iconId })),
    });
    for (const macro of STARTER_MACROS) {
      const started = engine.startMacro({ name: macro.name });
      expect(started, macro.name).toMatchObject({ ok: true });
    }
    // one tick must not throw — each run advances into its body deterministically
    expect(() => engine.tick(11)).not.toThrow();
  });
});
