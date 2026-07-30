import { describe, expect, it } from "vitest";
import type { PlayState, ServerAuthorityPlayerCorpseState } from "@successor/client/src/slice-core/gameState";
import { playerCorpseProbeProjections } from "./playerCorpseProbe";

function corpse(id: string, patch: Partial<ServerAuthorityPlayerCorpseState> = {}): ServerAuthorityPlayerCorpseState {
  return {
    id,
    ownerLabel: "Bank Keeper",
    areaId: "desert",
    cellX: 512,
    cellY: 513,
    x: 512,
    y: 513,
    expiryTick: 9_000,
    hasItems: true,
    creditsPresent: true,
    creditsCount: 400,
    isOwner: true,
    container: `corpse:${id}`,
    ...patch,
  };
}

function stateWith(corpses: ServerAuthorityPlayerCorpseState[]): PlayState {
  return {
    activeAreaId: "desert",
    serverAuthority: { playerCorpses: corpses },
  } as unknown as PlayState;
}

describe("playerCorpseProbeProjections", () => {
  it("projects an active-area corpse at the rendered bag's cell center with rounded screen px", () => {
    const calls: [number, number, number][] = [];
    const projections = playerCorpseProbeProjections(stateWith([corpse("player-corpse:7", { x: 512.204, y: 513.706 })]), (x, z, y) => {
      calls.push([x, z, y]);
      return { px: 731.4, py: 448.6 };
    });

    expect(projections).toEqual([{
      id: "player-corpse:7",
      ownerLabel: "Bank Keeper",
      isOwner: true,
      hasItems: true,
      creditsPresent: true,
      areaId: "desert",
      x: 512.204,
      y: 513.706,
      screen: { px: 731, py: 449 },
    }]);
    // The anchor targets the same point the raycast picker resolves: the bag
    // at the cell center (x+0.5, y+0.5), at the lying capsule's height.
    expect(calls).toEqual([[512.704, 514.206, 0.22]]);
  });

  it("keeps facts but carries no screen anchor for an off-area corpse (renderer never spawned a bag)", () => {
    const projections = playerCorpseProbeProjections(
      stateWith([corpse("player-corpse:3", { areaId: "elsewhere", hasItems: false, creditsPresent: false, isOwner: false })]),
      () => {
        throw new Error("must not project off-area corpses");
      },
    );

    expect(projections).toEqual([{
      id: "player-corpse:3",
      ownerLabel: "Bank Keeper",
      isOwner: false,
      hasItems: false,
      creditsPresent: false,
      areaId: "elsewhere",
      x: 512,
      y: 513,
      screen: null,
    }]);
  });

  it("mirrors the streamed list: empty AOI projects nothing, loot/expiry flips flow through", () => {
    expect(playerCorpseProbeProjections(stateWith([]), () => ({ px: 0, py: 0 }))).toEqual([]);
    const stripped = playerCorpseProbeProjections(
      stateWith([corpse("player-corpse:7", { hasItems: false, creditsPresent: false })]),
      () => ({ px: 10, py: 20 }),
    )[0]!;
    expect(stripped.hasItems).toBe(false);
    expect(stripped.creditsPresent).toBe(false);
    expect(stripped.screen).toEqual({ px: 10, py: 20 });
  });
});
