import { describe, expect, it } from "vitest";
import { createPlayState, type SliceSnapshot } from "./gameState";
import {
  actorCorpseNameplate,
  actorNameplate,
  actorTargetSummary,
  selectedActor,
} from "./selectionSystem";

function sliceFixture(): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 12,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 40, height: 24, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 40, height: 24, level: 0 }],
    stateHash: "fixture",
    camera: { followActor: "player", zoom: 1 },
    actors: [
      {
        id: "player",
        entity: "actor/player",
        areaId: "street",
        label: "Field Observer",
        guildTag: "dune-coop",
        role: "player",
        sprite: "adventurer-premium-male",
        poseSet: "walk",
        direction: "front",
        cell: { x: 4, y: 5 },
        route: [],
      },
      {
        id: "warden",
        entity: "actor/npc",
        areaId: "street",
        label: "Warden",
        role: "public_shopkeeper",
        sprite: "adventurer-premium-male",
        poseSet: "walk",
        direction: "left",
        cell: { x: 8, y: 5 },
        route: [],
      },
      {
        id: "remote",
        entity: "actor/npc",
        areaId: "drain",
        label: "Remote",
        role: "public_shopkeeper",
        sprite: "adventurer-premium-male",
        poseSet: "walk",
        direction: "left",
        cell: { x: 8, y: 5 },
        route: [],
      },
    ],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

describe("selectionSystem", () => {
  it("selects local actors and formats actor target summaries", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    state.selectedActorId = "player";

    const actor = selectedActor(slice, state);
    expect(actor?.id).toBe("player");
    expect(actorNameplate(actor!)).toBe("Field Observer <dune-coop>");

    const summary = actorTargetSummary(actor!, state);
    expect(summary.self).toBe(true);
    expect(summary.name).toBe("Field Observer <dune-coop>");
    expect(summary.role).toBe("player");
    expect(actorCorpseNameplate(actor!)).toBe("Corpse of Field Observer <dune-coop>");


    state.actors.player!.statuses = [{ id: "dead", label: "Dead", severity: 3, ttlMs: Number.POSITIVE_INFINITY }];
    expect(actorTargetSummary(actor!, state).name).toBe("Corpse of Field Observer <dune-coop>");
    state.selectedActorId = "remote";
    expect(selectedActor(slice, state)).toBeNull();
  });

  it("uses player organization tags as the target-summary guild fallback", () => {
    const slice = sliceFixture();
    const actor = slice.actors[0]!;
    actor.guildTag = null;
    actor.playerOrganizationTag = "WARD";
    const state = createPlayState(slice);

    const summary = actorTargetSummary(actor, state);
    expect(summary.guildTag).toBe("WARD");
    expect(summary.name).toBe("Field Observer <WARD>");
  });

  it("preserves authoritative Gaia creature names in target summaries", () => {
    const slice = sliceFixture();
    slice.areas[0]!.biome = "desert";
    slice.actors.push({
      id: "open-desert-creature-01",
      entity: "actor/npc",
      areaId: "street",
      label: "Duskback",
      role: "creature",
      sprite: "creature-pocketclod-adult",
      poseSet: "walk",
      direction: "front",
      cell: { x: 6, y: 6 },
      route: [],
    });
    const state = createPlayState(slice);
    const actor = slice.actors.find((candidate) => candidate.id === "open-desert-creature-01")!;

    expect(actorNameplate(actor, slice)).toBe("Duskback");
    expect(actorTargetSummary(actor, state, slice).name).toBe("Duskback");
    state.actors[actor.id]!.statuses = [{ id: "dead", label: "Dead", severity: 3, ttlMs: Number.POSITIVE_INFINITY }];
    expect(actorTargetSummary(actor, state, slice).name).toBe("Corpse of Duskback");
  });

  it("resolves dynamic server-only selected actors from the authoritative stream", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    state.serverAuthority.connected = true;
    state.serverAuthority.receivedSnapshots = 1;
    state.selectedActorId = "remote-rifle";
    state.serverAuthority.actors["remote-rifle"] = {
      id: "remote-rifle",
      label: "Remote Rifle",
      areaId: "street",
      x: 12,
      y: 9,
      renderX: 12,
      renderY: 9,
      direction: "right",
      lifeState: "alive",
      lifecycleSeq: 1,
      vitals: { health: 87, action: 92, spirit: 100 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
      bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
      statuses: [],
    };

    const actor = selectedActor(slice, state);
    expect(actor).toMatchObject({
      id: "remote-rifle",
      entity: "server:remote-rifle",
      label: "Remote Rifle",
      areaId: "street",
      role: "remote_actor",
    });
    expect(actorTargetSummary(actor!, state).vitals.health).toBe(87);
  });

  it("uses the current humanoid fallback for server-only actors without a sprite", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    state.serverAuthority.connected = true;
    state.serverAuthority.receivedSnapshots = 1;
    const serverActor = (id: string, label: string) => ({
      id,
      label,
      areaId: "street",
      x: 12,
      y: 9,
      renderX: 12,
      renderY: 9,
      direction: "right" as const,
      lifeState: "alive" as const,
      lifecycleSeq: 1,
      vitals: { health: 87, action: 92, spirit: 100 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
      bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
      statuses: [],
    });
    state.serverAuthority.actors["remote-operator"] = serverActor("remote-operator", "Human Operator");

    state.selectedActorId = "remote-operator";
    expect(selectedActor(slice, state)?.sprite).toBe("adventurer-premium-male");
  });

  it("uses authoritative target data after a selected local actor moves out of area", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    state.serverAuthority.connected = true;
    state.serverAuthority.receivedSnapshots = 1;
    state.activeAreaId = "street";
    state.selectedActorId = "warden";
    state.serverAuthority.actors.warden = {
      id: "warden",
      label: "Warden",
      areaId: "drain",
      x: 8,
      y: 5,
      renderX: 8,
      renderY: 5,
      direction: "left",
      lifeState: "alive",
      lifecycleSeq: 4,
      vitals: { health: 100, action: 100, spirit: 100 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
      bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
      statuses: [],
    };

    const actor = selectedActor(slice, state);
    expect(actor).toMatchObject({
      id: "warden",
      areaId: "drain",
      cell: { x: 8, y: 5 },
    });
    expect(actorTargetSummary(actor!, state).vitals.health).toBe(100);
  });

  it("keeps a selected respawning authoritative actor addressable for the target HUD", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice);
    state.serverAuthority.connected = true;
    state.serverAuthority.receivedSnapshots = 1;
    state.selectedActorId = "warden";
    state.serverAuthority.actors.warden = {
      id: "warden",
      label: "Warden",
      areaId: "street",
      x: 8,
      y: 5,
      renderX: 8,
      renderY: 5,
      direction: "left",
      lifeState: "respawning",
      lifecycleSeq: 5,
      vitals: { health: 0, action: 0, spirit: 0 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
      bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
      statuses: [{ id: "dead", label: "Dead", severity: 3, remainingMs: 30_000 }],
    };

    const actor = selectedActor(slice, state);
    expect(actor).toMatchObject({ id: "warden", areaId: "street", cell: { x: 8, y: 5 } });
    const summary = actorTargetSummary(actor!, state);
    expect(summary.lifeState).toBe("respawning");
    expect(summary.vitals.health).toBe(0);
    expect(summary.statuses.map((status) => status.id)).toContain("dead");
  });

});
