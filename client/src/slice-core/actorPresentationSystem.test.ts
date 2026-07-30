import { describe, expect, it } from "vitest";
import {
  actorDrawEntries,
  actorNameplateMaxWidth,
  selectActorNameplateIds,
} from "./actorPresentationSystem";
import type { SliceSnapshot } from "./gameState";

describe("actorPresentationSystem", () => {
  it("projects only actors present in the current authority stream", () => {
    const slice = {
      camera: { followActor: "player" },
      actors: [
        { id: "player", entity: "p", areaId: "a", label: "Player", role: "player", sprite: "adventurer-premium-male", poseSet: "idle", direction: "front", cell: { x: 2, y: 2 }, route: [] },
        { id: "present", entity: "n", areaId: "a", label: "Present", role: "creature", sprite: "creature-bellback-adult", poseSet: "idle", direction: "front", cell: { x: 4, y: 4 }, route: [] },
        { id: "absent", entity: "x", areaId: "a", label: "Absent", role: "creature", sprite: "creature-pebblehorn-adult", poseSet: "idle", direction: "front", cell: { x: 5, y: 5 }, route: [] },
      ],
    } as unknown as SliceSnapshot;
    const state = {
      activeAreaId: "a",
      player: { x: 2, y: 2 },
      actors: {},
      serverAuthority: {
        enabled: true,
        connected: true,
        sourceMatchesClient: true,
        playerActorId: "player",
        actors: {
          player: { id: "player", label: "Player", areaId: "a", x: 2, y: 2, renderX: 2, renderY: 2, direction: "front", lifeState: "alive" },
          present: { id: "present", label: "Present", areaId: "a", x: 4, y: 4, renderX: 4.25, renderY: 4, direction: "right", lifeState: "alive" },
          dynamic: { id: "dynamic", label: "Dynamic", areaId: "a", x: 6, y: 4, renderX: 6, renderY: 4, direction: "left", lifeState: "alive" },
        },
      },
    } as never;

    const entries = actorDrawEntries(slice, state, 0);

    expect(entries.map((entry) => entry.actor.id)).toEqual(["player", "present", "dynamic"]);
    expect(entries[1]?.pos).toEqual({ x: 4.25, y: 4 });
    expect(entries[2]?.actor).toMatchObject({ role: "remote_actor", sprite: "adventurer-premium-male" });
  });

  it("keeps dense nameplates within the overlay budget while retaining the player", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      actor: { id: `actor-${index}`, role: "creature" },
      pos: { x: 10 + index * 0.2, y: 17 },
    }));
    entries.push({ actor: { id: "player", role: "player" }, pos: { x: 11, y: 17 } });
    const state = {
      player: { x: 11, y: 17 },
      selectedActorId: null,
      examineActorId: null,
      actors: {},
    } as never;

    const ids = selectActorNameplateIds(entries as never, state, "player");

    expect(ids.size).toBeLessThanOrEqual(18);
    expect(ids.has("player")).toBe(true);
  });

  it("exposes the current live and corpse label widths", () => {
    expect(actorNameplateMaxWidth(false)).toBe(240);
    expect(actorNameplateMaxWidth(true)).toBe(430);
  });
});
