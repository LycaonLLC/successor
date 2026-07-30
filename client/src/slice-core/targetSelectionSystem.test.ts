import { describe, expect, it } from "vitest";

import { createPlayState, type PlayState, type ServerAuthorityActorState, type SliceSnapshot } from "./gameState";
import {
  clearInvisibleTargetSelection,
  resolveTargetSelector,
  setSelectedTarget,
  visibleTargetActors,
  type TargetSelectionContext,
} from "./targetSelectionSystem";

function actorSnapshot(id: string, label: string, x: number, y: number, factionId: string, role: string) {
  return {
    id,
    entity: `actor:${id}`,
    areaId: "a",
    label,
    role,
    sprite: "adventurer-premium-male",
    poseSet: "idle",
    direction: "right",
    cell: { x, y },
    route: [],
    factionId,
  };
}

function sliceFixture(): SliceSnapshot {
  return {
    schema: "successor.slice.v1",
    tick: 10,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Test", width: 100, height: 100, level: 0 },
    areas: [
      { id: "a", name: "A", kind: "overworld", width: 100, height: 100, level: 0 },
      { id: "b", name: "B", kind: "overworld", width: 100, height: 100, level: 0 },
    ],
    stateHash: "fixture",
    camera: { followActor: "player", zoom: 72 },
    factions: [
      { id: "desert_wardens", label: "Warden", enemies: ["rogue_troopers"] },
      { id: "rogue_troopers", label: "Rogues", enemies: ["desert_wardens"] },
    ],
    actors: [
      actorSnapshot("player", "Field Observer", 1, 2, "desert_wardens", "player"),
      actorSnapshot("rogue-a", "Rogue A", 4, 2, "rogue_troopers", "skirmisher"),
      actorSnapshot("rogue-b", "Rogue B", 1, 5, "rogue_troopers", "skirmisher"),
      actorSnapshot("vendor", "Vendor", 2, 2, "desert_wardens", "vendor"),
    ],
    props: [],
    blockedCells: [],
    transitions: [],
    cloneFacilities: [],
    inventory: [],
    reservations: [],
    events: [],
  } as unknown as SliceSnapshot;
}

function serverActor(id: string, label: string, x: number, y: number, factionId: string, role: string): ServerAuthorityActorState {
  return {
    id,
    label,
    role,
    sprite: "adventurer-premium-male",
    areaId: "a",
    x,
    y,
    direction: "right",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 80, action: 72, spirit: 63 },
    maxVitals: { health: 100, action: 100, spirit: 90 },
    bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    statuses: [],
    factionId,
    posture: "standing",
  } as ServerAuthorityActorState;
}

function contextFixture(): TargetSelectionContext {
  const slice = sliceFixture();
  const state: PlayState = createPlayState(slice);
  state.activeAreaId = "a";
  state.player = { x: 1, y: 2 };
  state.serverAuthority.playerActorId = "player";
  state.serverAuthority.actors = {
    player: serverActor("player", "Field Observer", 1, 2, "desert_wardens", "player"),
    // rogue-a and rogue-b sit at the SAME distance 3 from the player — the
    // nearest-hostile tie must break on actor id, never on object order.
    "rogue-a": serverActor("rogue-a", "Rogue A", 4, 2, "rogue_troopers", "skirmisher"),
    "rogue-b": serverActor("rogue-b", "Rogue B", 1, 5, "rogue_troopers", "skirmisher"),
    vendor: serverActor("vendor", "Vendor", 2, 2, "desert_wardens", "vendor"),
  };
  return { state, slice };
}

describe("targetSelectionSystem", () => {
  it("lists only visible same-area actors in stable id order", () => {
    const context = contextFixture();
    context.state.serverAuthority.actors["rogue-b"]!.areaId = "b";
    expect(visibleTargetActors(context).map((actor) => actor.id)).toEqual(["rogue-a", "vendor"]);
    expect(visibleTargetActors(context, true).map((actor) => actor.id)).toEqual(["player", "rogue-a", "vendor"]);
  });

  it("drops respawning actors from every selector surface", () => {
    const context = contextFixture();
    context.state.serverAuthority.actors["rogue-b"]!.lifeState = "respawning";
    expect(visibleTargetActors(context).map((actor) => actor.id)).toEqual(["rogue-a", "vendor"]);
    // With rogue-b gone, the "rogue" prefix becomes unique.
    expect(resolveTargetSelector(context, "rogue")).toMatchObject({ ok: true, actor: { id: "rogue-a" } });
  });

  it("resolves self and me to the player even though other selectors exclude self", () => {
    const context = contextFixture();
    expect(resolveTargetSelector(context, "self")).toMatchObject({ ok: true, actor: { id: "player" } });
    expect(resolveTargetSelector(context, "ME")).toMatchObject({ ok: true, actor: { id: "player" } });
    // Non-self selectors never match the player, even by prefix.
    expect(resolveTargetSelector(context, "play")).toMatchObject({ ok: false, error: "target_not_visible" });
  });

  it("resolves exact id, exact label, and unique prefix; ambiguity reports candidates", () => {
    const context = contextFixture();
    expect(resolveTargetSelector(context, "rogue-a")).toMatchObject({ ok: true, actor: { id: "rogue-a" } });
    expect(resolveTargetSelector(context, "Rogue B")).toMatchObject({ ok: true, actor: { id: "rogue-b" } });
    expect(resolveTargetSelector(context, "vend")).toMatchObject({ ok: true, actor: { id: "vendor" } });

    const ambiguous = resolveTargetSelector(context, "rogue");
    expect(ambiguous).toMatchObject({ ok: false, error: "ambiguous_target" });
    expect(!ambiguous.ok && ambiguous.candidates?.map((actor) => actor.id)).toEqual(["rogue-a", "rogue-b"]);

    expect(resolveTargetSelector(context, "")).toMatchObject({ ok: false, error: "no_target" });
    expect(resolveTargetSelector(context, "ghost")).toMatchObject({ ok: false, error: "target_not_visible" });
  });

  it("picks nearest hostile by distance with a deterministic id tiebreak", () => {
    const context = contextFixture();
    // Vendor is nearer (distance 1) but friendly — never a hostile candidate.
    expect(resolveTargetSelector(context, "nearest hostile")).toMatchObject({ ok: true, actor: { id: "rogue-a" } });

    // Break the tie the other way: rogue-b moves closer.
    context.state.serverAuthority.actors["rogue-b"]!.y = 4;
    expect(resolveTargetSelector(context, "nearest hostile")).toMatchObject({ ok: true, actor: { id: "rogue-b" } });

    context.state.serverAuthority.actors["rogue-a"]!.lifeState = "respawning";
    context.state.serverAuthority.actors["rogue-b"]!.areaId = "b";
    expect(resolveTargetSelector(context, "nearest hostile")).toMatchObject({ ok: false, error: "no_target" });
  });

  it("cycles next/previous over the id-ordered visible ring, wrapping both ways", () => {
    const context = contextFixture();
    // No current selection: next starts at the front, previous at the back.
    expect(resolveTargetSelector(context, "next")).toMatchObject({ ok: true, actor: { id: "rogue-a" } });
    expect(resolveTargetSelector(context, "previous")).toMatchObject({ ok: true, actor: { id: "vendor" } });

    context.state.selectedActorId = "rogue-a";
    expect(resolveTargetSelector(context, "next")).toMatchObject({ ok: true, actor: { id: "rogue-b" } });
    context.state.selectedActorId = "vendor";
    expect(resolveTargetSelector(context, "next")).toMatchObject({ ok: true, actor: { id: "rogue-a" } });
    context.state.selectedActorId = "rogue-a";
    expect(resolveTargetSelector(context, "previous")).toMatchObject({ ok: true, actor: { id: "vendor" } });
  });

  it("keeps selection and soft-lock independent in setSelectedTarget", () => {
    const context = contextFixture();
    setSelectedTarget(context.state, "rogue-a");
    expect(context.state.selectedActorId).toBe("rogue-a");
    expect(context.state.softLockActorId).toBeNull();

    setSelectedTarget(context.state, "rogue-b", true);
    expect(context.state.selectedActorId).toBe("rogue-b");
    expect(context.state.softLockActorId).toBe("rogue-b");

    // Re-selecting without the lock flag leaves the existing lock alone.
    setSelectedTarget(context.state, "vendor");
    expect(context.state.softLockActorId).toBe("rogue-b");
  });

  it("clears stale selection when the actor disappears or changes area", () => {
    const context = contextFixture();
    context.state.selectedActorId = "rogue-a";
    context.state.softLockActorId = "rogue-b";

    context.state.serverAuthority.actors["rogue-a"]!.areaId = "b";
    clearInvisibleTargetSelection(context);
    expect(context.state.selectedActorId).toBeNull();
    expect(context.state.softLockActorId).toBe("rogue-b");

    delete context.state.serverAuthority.actors["rogue-b"];
    clearInvisibleTargetSelection(context);
    expect(context.state.softLockActorId).toBeNull();
  });
});
