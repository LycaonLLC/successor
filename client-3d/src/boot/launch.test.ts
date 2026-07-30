import type { LaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import type { SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { describe, expect, it } from "vitest";
import { applyLaunchIdentity, initialCameraFocus } from "./launch";

describe("initialCameraFocus", () => {
  it("starts on the authoritative player instead of a stale launch spawn", () => {
    expect(initialCameraFocus(
      "?spawnX=512&spawnY=512",
      { x: 512, y: 512 },
      { x: 630.25, y: 465.75 },
    )).toEqual({ x: 630.25, z: 465.75 });
  });

  it("uses a valid launch spawn while authority is unavailable", () => {
    expect(initialCameraFocus(
      "?spawnX=44.5&spawnY=81.25",
      { x: 10, y: 20 },
      null,
    )).toEqual({ x: 44.5, z: 81.25 });
  });

  it("falls back to local player coordinates for invalid launch values", () => {
    expect(initialCameraFocus(
      "?spawnX=nowhere&spawnY=NaN",
      { x: 10, y: 20 },
      null,
    )).toEqual({ x: 10, z: 20 });
  });
});

describe("applyLaunchIdentity", () => {
  it("re-keys the authored camera pawn to a persistent character id", () => {
    const slice = {
      schema: "successor.slice-snapshot.v1",
      tick: 0,
      tickRateHz: 30,
      combatModel: "roll",
      grid: { cellSizePx: 32 },
      zone: { id: 1, name: "Open Desert", width: 1024, height: 1024, level: 1 },
      areas: [],
      stateHash: "test",
      camera: { followActor: "player", zoom: 72 },
      actors: [
        {
          id: "player",
          entity: "1:1",
          areaId: "open-desert-overworld",
          label: "Field Observer",
          role: "player",
          sprite: "adventurer-premium-male",
          poseSet: "idle",
          direction: "front",
          cell: { x: 512, y: 512 },
          route: [],
        },
        {
          id: "grok",
          entity: "1:2",
          areaId: "open-desert-overworld",
          label: "GR0K",
          role: "social",
          sprite: "droid",
          poseSet: "idle",
          direction: "front",
          cell: { x: 510, y: 512 },
          route: [],
        },
      ],
      props: [],
      blockedCells: [],
      transitions: [],
      inventory: [],
      reservations: [],
      events: [],
    } satisfies SliceSnapshot;
    const identity = {
      ownerRef: "local",
      ownerDisplayName: "Grug",
      playerId: "char_grug",
      displayName: "Grug",
      characterId: "char_grug",
      characterName: "Grug",
      zoneId: "open-desert",
      partyId: "",
      guildId: "",
      guildTag: null,
    } satisfies LaunchIdentity;

    const projected = applyLaunchIdentity(slice, identity, "char_grug");

    expect(projected.camera.followActor).toBe("char_grug");
    expect(projected.actors.map((actor) => actor.id)).toEqual(["char_grug", "grok"]);
    expect(projected.actors[0]).toMatchObject({ id: "char_grug", label: "Grug" });
    expect(slice.camera.followActor).toBe("player");
    expect(slice.actors[0]?.id).toBe("player");
  });
});
