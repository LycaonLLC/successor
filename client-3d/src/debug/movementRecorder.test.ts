// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlayState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { createMovementRecorder, type MovementRecorder } from "./movementRecorder";

function fixtureSlice(): SliceSnapshot {
  return {
    schema: "successor.slice.v1",
    tick: 1,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Test", width: 20, height: 20, level: 0 },
    areas: [{ id: "test", name: "Test", kind: "overworld", width: 20, height: 20, level: 0 }],
    stateHash: "movement-recorder-fixture",
    camera: { followActor: "player", zoom: 72 },
    actors: [{
      id: "player",
      entity: "actor:player",
      areaId: "test",
      label: "Player",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "idle",
      direction: "right",
      cell: { x: 4, y: 4 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

let recorder: MovementRecorder | null = null;

afterEach(() => {
  recorder?.dispose();
  recorder = null;
  document.body.textContent = "";
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

function recordSnap(search = "") {
  window.history.replaceState({}, "", `/${search}`);
  const state = createPlayState(fixtureSlice(), "player");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  recorder = createMovementRecorder(state);
  recorder.sample(state, 0);
  state.serverAuthority.predictionErrorCells = 2.5;
  recorder.sample(state, 16);
  return { consoleError, probe: window.__successor3dMoveRec! };
}

describe("movement recorder diagnostics", () => {
  it("records correction markers silently without the explicit debug flag", () => {
    const { consoleError, probe } = recordSnap();

    expect(probe.markers.snap).toBe(1);
    expect(probe.markerTotal).toBe(1);
    expect(document.querySelector(".sc3d-moverec-chip")).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("shows and logs correction diagnostics when moverec=1 is explicit", () => {
    const { consoleError, probe } = recordSnap("?moverec=1");

    expect(probe.markers.snap).toBe(1);
    expect(document.querySelector(".sc3d-moverec-chip")?.textContent).toBe(
      "MOVEMENT ANOMALY CAPTURED (snap)",
    );
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"kind":"snap"'));
  });
});
