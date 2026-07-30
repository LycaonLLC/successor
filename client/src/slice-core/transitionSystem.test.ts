import { describe, expect, it } from "vitest";
import {
  applyAreaTransitionState,
  applyCloneRespawnArrivalState,
  cloneFacilityForRespawn,
  cloneRespawnArrival,
  transitionArrival,
  transitionAtPlayerPosition,
  transitionCenter,
} from "./transitionSystem";
import type { PlayState, SliceSnapshot } from "./gameState";
import type { AreaTransitionSnapshot, CloneFacilitySnapshot } from "./worldTypes";

const transition: AreaTransitionSnapshot = {
  id: "bolt-entry",
  label: "Enter Bolt Bench",
  style: "door",
  fromAreaId: "open-desert-overworld",
  fromCell: { x: 10, y: 20 },
  triggerSize: { w: 2, h: 1 },
  toAreaId: "bolt-bench",
  toCell: { x: 4, y: 7.5 },
  toFacing: "back",
};

const facility: CloneFacilitySnapshot = {
  id: "rust-vat-clinic",
  label: "Rust Vat Cloning",
  areaId: "rust-vat-cloning",
  respawnCell: { x: 52, y: 21.126 },
  respawnFacing: "front",
  sicknessDurationMs: 240_000,
};

function playState(overrides: Partial<PlayState> = {}): PlayState {
  return {
    activeAreaId: "open-desert-overworld",
    player: { x: 9.5, y: 19.5 },
    facing: "front",
    blocked: new Set(),
    floatingTexts: [{ id: 1 }],
    selectedActorId: "npc",
    examineActorId: "npc",
    transitionCooldownMs: 0,
    transitionFlashMs: 0,
    lastTransitionLabel: null,
    status: "ready",
    ...overrides,
  } as PlayState;
}

function slice(overrides: Partial<SliceSnapshot> = {}): SliceSnapshot {
  return {
    areas: [
      { id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 32, height: 32, level: 0 },
      { id: "bolt-bench", name: "Bolt Bench", kind: "public_interior", width: 12, height: 10, level: 0 },
      { id: "rust-vat-cloning", name: "Rust Vat Cloning", kind: "public_interior", width: 64, height: 32, level: 0 },
    ],
    transitions: [transition],
    blockedCells: [{ areaId: "bolt-bench", x: 2, y: 3 }],
    props: [{
      id: "counter",
      entity: "counter",
      areaId: "bolt-bench",
      label: "Counter",
      kind: "counter",
      cell: { x: 4, y: 5 },
      size: { w: 2, h: 1 },
      interactive: false,
    }],
    ...overrides,
  } as SliceSnapshot;
}

describe("transitionSystem", () => {
  it("uses the player's cell center for transition trigger checks", () => {
    expect(transitionCenter({ x: 9.5, y: 19.5 })).toEqual({ x: 10, y: 20 });
    expect(transitionAtPlayerPosition([transition], { x: 9.5, y: 19.5 })?.id).toBe("bolt-entry");
    expect(transitionAtPlayerPosition([transition], { x: 11.5, y: 19.5 })).toBeNull();
  });

  it("normalizes transition arrival into runtime state fields", () => {
    expect(transitionArrival(transition)).toEqual({
      activeAreaId: "bolt-bench",
      player: { x: 4, y: 7.5 },
      facing: "back",
      label: "Enter Bolt Bench",
      status: "enter bolt bench",
    });
  });

  it("keeps clone respawn selection and arrival deterministic", () => {
    expect(cloneFacilityForRespawn([])).toBeNull();
    expect(cloneFacilityForRespawn([facility])?.id).toBe("rust-vat-clinic");
    expect(cloneRespawnArrival(facility)).toEqual({
      activeAreaId: "rust-vat-cloning",
      player: { x: 52, y: 21.126 },
      facing: "front",
      label: "Cloning Center Respawn",
    });
  });

  it("applies area transition state mutation consistently", () => {
    const state = playState();
    const applied = applyAreaTransitionState(state, slice());

    expect(applied?.label).toBe("Enter Bolt Bench");
    expect(state.activeAreaId).toBe("bolt-bench");
    expect(state.player).toEqual({ x: 4, y: 7.5 });
    expect(state.facing).toBe("back");
    expect(state.blocked.has("2,3")).toBe(true);
    expect(state.blocked.has("4,5")).toBe(true);
    expect(state.blocked.has("5,5")).toBe(true);
    expect(state.floatingTexts).toHaveLength(1);
    expect(state.selectedActorId).toBeNull();
    expect(state.examineActorId).toBeNull();
    expect(state.transitionCooldownMs).toBe(650);
    expect(state.transitionFlashMs).toBe(420);
    expect(state.lastTransitionLabel).toBe("Enter Bolt Bench");
    expect(state.status).toBe("enter bolt bench");
  });

  it("does not apply area transitions during cooldown", () => {
    const state = playState({ transitionCooldownMs: 100 });
    expect(applyAreaTransitionState(state, slice())).toBeNull();
    expect(state.activeAreaId).toBe("open-desert-overworld");
  });

  it("applies clone respawn arrival state and clears floating combat text", () => {
    const state = playState({ status: "clone pending" });
    applyCloneRespawnArrivalState(state, slice(), cloneRespawnArrival(facility));

    expect(state.activeAreaId).toBe("rust-vat-cloning");
    expect(state.player).toEqual({ x: 52, y: 21.126 });
    expect(state.facing).toBe("front");
    expect(state.floatingTexts).toEqual([]);
    expect(state.transitionCooldownMs).toBe(650);
    expect(state.transitionFlashMs).toBe(460);
    expect(state.lastTransitionLabel).toBe("Cloning Center Respawn");
    expect(state.status).toBe("clone pending");
  });
});
