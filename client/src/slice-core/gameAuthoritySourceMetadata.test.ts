import { describe, expect, it } from "vitest";
import { applyAuthoritativeSnapshot } from "./gameAuthoritySystem";
import { createPlayState, type SliceSnapshot } from "./gameState";

const slice = {
  schema: "test",
  tick: 1,
  tickRateHz: 30,
  combatModel: "roll",
  grid: { cellSizePx: 32 },
  zone: { id: 1, name: "Test", width: 24, height: 18, level: 0 },
  areas: [{ id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 24, height: 18, level: 0 }],
  stateHash: "slice-hash",
  camera: { followActor: "player", zoom: 1 },
  actors: [{
    id: "player",
    entity: "actor.player",
    areaId: "open-desert-overworld",
    label: "Field Observer",
    role: "player",
    sprite: "adventurer-premium-male",
    poseSet: "idle",
    direction: "right",
    cell: { x: 4, y: 5 },
    route: [],
  }],
  props: [],
  blockedCells: [],
  transitions: [],
  inventory: [],
  reservations: [],
  events: [],
} as SliceSnapshot;

function authorityActor() {
  return {
    id: "player",
    label: "Field Observer",
    areaId: "open-desert-overworld",
    x: 4,
    y: 5,
    direction: "right",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: {
      active: false,
      stackCount: 0,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    statuses: [],
  };
}

function snapshot(source: Record<string, unknown> = {}) {
  return {
    schema: "successor.authoritative-shard-snapshot.v1",
    shardId: "test",
    tick: 2,
    playerActorId: "player",
    actors: { player: authorityActor() },
    counters: {
      acceptedCommands: 0,
      rejectedCommands: 0,
      shotsFired: 0,
      hits: 0,
      deaths: 0,
    },
    ...source,
  } as never;
}

describe("authority source metadata", () => {
  it("fails closed when an authority snapshot omits either source field", () => {
    const state = createPlayState(slice);
    expect(applyAuthoritativeSnapshot(state, slice, snapshot())).toBe(false);
    expect(state.serverAuthority.sourceMatchesClient).toBe(false);
    expect(state.serverAuthority.actors).toEqual({});

    const stateWithHashOnly = createPlayState(slice);
    expect(applyAuthoritativeSnapshot(stateWithHashOnly, slice, snapshot({ sourceStateHash: "slice-hash" }))).toBe(false);
    expect(stateWithHashOnly.serverAuthority.sourceMatchesClient).toBe(false);

    const stateWithCountOnly = createPlayState(slice);
    expect(applyAuthoritativeSnapshot(stateWithCountOnly, slice, snapshot({ sourceActorCount: 1 }))).toBe(false);
    expect(stateWithCountOnly.serverAuthority.sourceMatchesClient).toBe(false);
  });

  it("fails closed for malformed or mismatched source metadata", () => {
    for (const source of [
      { sourceStateHash: "slice-hash", sourceActorCount: 1.5 },
      { sourceStateHash: "", sourceActorCount: 1 },
      { sourceStateHash: "wrong-hash", sourceActorCount: 1 },
      { sourceStateHash: "slice-hash", sourceActorCount: 2 },
    ]) {
      const state = createPlayState(slice);
      expect(applyAuthoritativeSnapshot(state, slice, snapshot(source))).toBe(false);
      expect(state.serverAuthority.sourceMatchesClient).toBe(false);
    }
  });

  it("accepts the exact loaded source hash and declared actor count", () => {
    const state = createPlayState(slice);
    expect(applyAuthoritativeSnapshot(state, slice, snapshot({ sourceStateHash: "slice-hash", sourceActorCount: 1 }))).toBe(true);
    expect(state.serverAuthority.sourceStateHash).toBe("slice-hash");
    expect(state.serverAuthority.sourceActorCount).toBe(1);
    expect(state.serverAuthority.sourceMatchesClient).toBe(true);
  });
});
