import { describe, expect, it } from "vitest";
import { actorWorldPosition, pickActor, routeDirection, type TargetableActor } from "./targetingSystem";

function actor(overrides: Partial<TargetableActor> = {}): TargetableActor {
  return {
    id: "npc",
    areaId: "open-desert",
    direction: "front",
    cell: { x: 4, y: 5 },
    route: [],
    ...overrides,
  };
}

describe("targetingSystem", () => {
  it("uses player state position for the followed actor", () => {
    const player = actor({ id: "player", cell: { x: 1, y: 1 } });
    const position = actorWorldPosition(
      player,
      { grid: { cellSizePx: 32 }, camera: { followActor: "player" }, actors: [player] },
      { activeAreaId: "open-desert", player: { x: 12.5, y: 18.25 }, actors: {} },
      0,
    );

    expect(position).toEqual({ x: 12.5, y: 18.25 });
  });

  it("prefers downed cells over actor routes for non-player actors", () => {
    const npc = actor({
      route: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    });
    const position = actorWorldPosition(
      npc,
      { grid: { cellSizePx: 32 }, camera: { followActor: "player" }, actors: [npc] },
      {
        activeAreaId: "open-desert",
        player: { x: 0, y: 0 },
        actors: { npc: { downed: true, downedCell: { x: 7, y: 8 } } },
      },
      4_100,
    );

    expect(position).toEqual({ x: 7, y: 8 });
  });

  it("derives facing direction from active route segment", () => {
    const eastThenSouth = actor({
      route: [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 8, y: 8 },
      ],
    });

    expect(routeDirection(eastThenSouth, 1_000)).toBe("right");
    expect(routeDirection(eastThenSouth, 5_000)).toBe("front");
    expect(routeDirection(eastThenSouth, 7_000)).toBe("back_left");
  });

  it("walks the closing route leg instead of snapping from last point to first", () => {
    const shuttle = actor({
      route: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    });
    const slice = { grid: { cellSizePx: 32 }, camera: { followActor: "player" }, actors: [shuttle] };
    const state = { activeAreaId: "open-desert", player: { x: 0, y: 0 }, actors: {} };

    expect(actorWorldPosition(shuttle, slice, state, 0)).toEqual({ x: 0, y: 0 });
    expect(actorWorldPosition(shuttle, slice, state, 4_100)).toEqual({ x: 10, y: 0 });
    expect(actorWorldPosition(shuttle, slice, state, 6_150)).toEqual({ x: 5, y: 0 });
    expect(actorWorldPosition(shuttle, slice, state, 8_199).x).toBeLessThan(0.01);
    expect(routeDirection(shuttle, 6_150)).toBe("left");
  });

  it("picks the frontmost actor under the pointer and ignores other areas", () => {
    const backActor = actor({ id: "back", areaId: "open-desert", cell: { x: 3, y: 3 } });
    const frontActor = actor({ id: "front", areaId: "open-desert", cell: { x: 3, y: 4 } });
    const otherAreaActor = actor({ id: "other", areaId: "storm-drain", cell: { x: 3, y: 5 } });
    const picked = pickActor(
      {
        grid: { cellSizePx: 32 },
        camera: { followActor: "player" },
        actors: [backActor, frontActor, otherAreaActor],
      },
      { activeAreaId: "open-desert", player: { x: 0, y: 0 }, actors: {} },
      0,
      { x: 112, y: 156 },
    );

    expect(picked?.id).toBe("front");
  });

  it("does not pick authored non-player actors missing from the authoritative stream", () => {
    const live = actor({ id: "live", areaId: "open-desert", cell: { x: 3, y: 4 } });
    const stale = actor({ id: "stale", areaId: "open-desert", cell: { x: 3, y: 5 } });
    const picked = pickActor(
      {
        grid: { cellSizePx: 32 },
        camera: { followActor: "player" },
        actors: [live, stale],
      },
      {
        activeAreaId: "open-desert",
        player: { x: 0, y: 0 },
        actors: {},
        serverAuthority: {
          enabled: true,
          actors: {
            live: { areaId: "open-desert", x: 3, y: 4, renderX: 3, renderY: 4, lifeState: "alive" },
          },
        },
      },
      0,
      { x: 112, y: 188 },
    );

    expect(picked).toBeNull();
  });

  it("picks dynamic server-only actors that are rendered under server authority", () => {
    const picked = pickActor(
      {
        grid: { cellSizePx: 32 },
        camera: { followActor: "player" },
        actors: [actor({ id: "player", areaId: "open-desert", cell: { x: 0, y: 0 } })],
      },
      {
        activeAreaId: "open-desert",
        player: { x: 0, y: 0 },
        actors: {},
        serverAuthority: {
          enabled: true,
          actors: {
            "remote-rifle": { areaId: "open-desert", x: 3, y: 4, renderX: 3, renderY: 4, direction: "right", lifeState: "alive" },
          },
        },
      },
      0,
      { x: 112, y: 156 },
    );

    expect(picked?.id).toBe("remote-rifle");
  });
});
