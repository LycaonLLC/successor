import { describe, expect, it } from "vitest";

import { createPlayState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { createSlashCommandRouter } from "./slashCommands";

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
    actors: [{
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
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    cloneFacilities: [{ id: "camp-clone", areaId: "a", label: "Camp Clone", respawnCell: { x: 1, y: 1 }, respawnFacing: "right", sicknessDurationMs: 0 }],
    inventory: [],
    reservations: [],
    events: [],
  };
}

describe("slashCommands", () => {
  it("delegates curated authority slashes to the slice-core verb registry", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    state.selectedActorId = "rogue";
    const router = createSlashCommandRouter(state, slice);

    expect(router.handle("/survey iron")).toBe("SURVEYING METAL…");
    expect(router.handle("/sample copper")).toBe("SAMPLING COPPER — HOLD POSITION");
    expect(router.handle("/kneel")).toBe("KNEELING");
    expect(router.handle("/stand")).toBe("STANDING");
    expect(router.handle("/peace")).toBe("STANDING DOWN");
    expect(router.handle("/clone camp-clone")).toBe("CLONE ACTIVATION QUEUED");
    expect(router.handle("/attack")).toBe("ATTACK QUEUED");
    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([
      { SurveyResource: { family: "metal" } },
      { SampleResource: { family: "copper" } },
      { SetPosture: { posture: "kneel" } },
      { SetPosture: { posture: "stand" } },
      { Peace: {} },
      { CloneRespawn: { facility_id: "camp-clone" } },
      { QueueCombatAction: { action_id: "basic_shot", target_actor_id: "rogue" } },
    ]);
  });

  it("routes local /ui through the window manager seam", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    const opened: string[] = [];
    const router = createSlashCommandRouter(state, slice, { openWindow: (id) => opened.push(id) });

    expect(router.handle("/ui inventory")).toBe("UI INVENTORY");
    expect(opened).toEqual(["inventory"]);
  });

  it("consumes /bugreport through the focused support-window seam", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    const opened: string[] = [];
    const router = createSlashCommandRouter(state, slice, {
      bugReportLine: (line) => {
        if (line !== "/bugreport") return null;
        opened.push("bugReport");
        return "BUG REPORT OPEN";
      },
    });

    expect(router.handle("/bugreport")).toBe("BUG REPORT OPEN");
    expect(opened).toEqual(["bugReport"]);
    expect(state.authorityCommands.pending).toHaveLength(0);
  });

  it("denies /ui for windows outside knownWindowIds without opening anything", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    const opened: string[] = [];
    const router = createSlashCommandRouter(state, slice, {
      openWindow: (id) => opened.push(id),
      knownWindowIds: ["inventory", "options"],
    });

    expect(router.handle("/ui craft")).toBe("UI DENIED — UNKNOWN WINDOW");
    expect(router.handle("/ui splice")).toBe("UI DENIED — UNKNOWN WINDOW");
    expect(router.handle("/ui inventory")).toBe("UI INVENTORY");
    expect(opened).toEqual(["inventory"]);
  });

  it("returns null for chat-service commands and non-slash chat", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    const router = createSlashCommandRouter(state, slice);

    expect(router.handle("/who")).toBeNull();
    expect(router.handle("hello zone")).toBeNull();
    expect(state.authorityCommands.pending).toHaveLength(0);
  });
});
