import { describe, expect, it } from "vitest";

import { createMacroEngine } from "@successor/client/src/slice-core/macroEngine/index";
import { createVerbRegistry } from "@successor/client/src/slice-core/verbRegistry/index";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { createContactTracker } from "./contacts";
import { createSurveyStore } from "./surveyStore";
import { isCarriedContainer } from "./exchangeTrade";
import { routeFarm } from "./farm";
import type { GameSession } from "./session";
import type { ServerAuthorityParcelState } from "@successor/client/src/slice-core/gameState";

function fakeSession(): GameSession {
  const { state, slice } = createTuiPlayStateFixture();
  const registry = createVerbRegistry({ state, slice });
  const session: GameSession = {
    state,
    slice,
    registry,
    macros: createMacroEngine({ registry }),
    survey: createSurveyStore(),
    tracker: createContactTracker(),
    chat: null,
    defineMacro() {},
    removeMacro: () => false,
    listMacroDefs: () => [],
    isCarried: (container) => isCarriedContainer(state, container),
    async start() {},
    async dispose() {},
    onEvent: () => () => {},
    estimatedTick: () => 4512,
    executeVerb: (line) => registry.executeLine(line),
    sendChat() {},
    holdDirection() {},
    walk() {},
    stopMovement() {},
    moving: () => false,
    queueEventsSince: (seq) => ({ seq, events: [] }),
  };
  session.tracker.update(state);
  return session;
}

function mockParcel(
  parcelId: string,
  areaId: string,
  rect: { x: number; y: number; w: number; h: number },
  isOwner = true
): ServerAuthorityParcelState {
  return {
    parcelId,
    planetId: "planet-a",
    areaId,
    name: `Parcel ${parcelId}`,
    rect,
    tier: "homestead",
    buildZone: rect,
    farmYard: rect,
    isOwner,
    tilledTiles: 0,
    plantedTiles: 0,
  };
}

describe("/farm TUI parcel selection", () => {
  it("containing parcel takes precedence over a nearby non-containing parcel", () => {
    const session = fakeSession();
    const state = session.state;

    // Position player at (42, 44) in "open-desert"
    const me = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
    if (me) {
      me.x = 42;
      me.y = 44;
      me.areaId = "open-desert";
    }

    // Set up two parcels:
    // Parcel 1: containing parcel, rect: (40, 40) size 10x10. Player is inside this.
    // Parcel 2: non-containing parcel, rect: (43, 44) size 10x10. (wait, actually, if it's (43, 44), it contains 42? No, 42 < 43, so player is not inside. Distance is dx = 43 - 42 = 1, dy = 0. Distance sq = 1).
    const parcel1 = mockParcel("parcel:1", "open-desert", { x: 40, y: 40, w: 10, h: 10 });
    const parcel2 = mockParcel("parcel:2", "open-desert", { x: 43, y: 44, w: 10, h: 10 });

    state.serverAuthority.placedParcels = [parcel2, parcel1];

    const lines = routeFarm(session, ["plot"]);
    const text = lines.map((line) => line.text).join("\n");

    // It should select parcel:1 (containing), not parcel:2 (which is closer to player but player is not inside it).
    // Wait, distance to parcel1 is 0. Distance to parcel2 is 1. So 0 < 1, parcel1 is chosen.
    expect(text).toContain("Parcel parcel:1");
  });

  it("nearest parcel is chosen when player is outside all parcels", () => {
    const session = fakeSession();
    const state = session.state;

    // Position player at (30, 30) in "open-desert"
    const me = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
    if (me) {
      me.x = 30;
      me.y = 30;
      me.areaId = "open-desert";
    }

    // Set up two parcels:
    // Parcel A: rect: (40, 30) size 10x10. Distance = dx = 40 - 30 = 10, dy = 0. Sq distance = 100.
    // Parcel B: rect: (100, 30) size 10x10. Distance = dx = 100 - 30 = 70, dy = 0. Sq distance = 4900.
    const parcelA = mockParcel("parcel:A", "open-desert", { x: 40, y: 30, w: 10, h: 10 });
    const parcelB = mockParcel("parcel:B", "open-desert", { x: 100, y: 30, w: 10, h: 10 });

    state.serverAuthority.placedParcels = [parcelB, parcelA];

    const lines = routeFarm(session, ["plot"]);
    const text = lines.map((line) => line.text).join("\n");

    // It should select parcel:A because it is nearest (distance 10 vs 70)
    expect(text).toContain("Parcel parcel:A");
  });

  it("breaks ties deterministically by selecting the lexicographically smaller parcelId", () => {
    const session = fakeSession();
    const state = session.state;

    // Position player at (30, 30) in "open-desert"
    const me = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
    if (me) {
      me.x = 30;
      me.y = 30;
      me.areaId = "open-desert";
    }

    // Set up two parcels with exactly equal distance to the player:
    // Parcel 2: rect: (40, 30) size 10x10. Distance = dx = 40 - 30 = 10. Sq distance = 100.
    // Parcel 1: rect: (10, 30) size 11x10. maxX = 20. Distance = dx = 30 - 20 = 10. Sq distance = 100.
    const parcel2 = mockParcel("parcel:2", "open-desert", { x: 40, y: 30, w: 10, h: 10 });
    const parcel1 = mockParcel("parcel:1", "open-desert", { x: 10, y: 30, w: 11, h: 10 });

    // Test order 1: [parcel2, parcel1]
    state.serverAuthority.placedParcels = [parcel2, parcel1];
    let lines = routeFarm(session, ["plot"]);
    let text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("Parcel parcel:1");

    // Test order 2: [parcel1, parcel2]
    state.serverAuthority.placedParcels = [parcel1, parcel2];
    lines = routeFarm(session, ["plot"]);
    text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("Parcel parcel:1");
  });

  it("filters parcels by the current area and ownership", () => {
    const session = fakeSession();
    const state = session.state;

    // Position player at (30, 30) in "open-desert"
    const me = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
    if (me) {
      me.x = 30;
      me.y = 30;
      me.areaId = "open-desert";
    }

    // Set up three parcels:
    // Parcel A: rect: (30, 30) size 10x10 (containing). In different area "open-desert-overworld", isOwner = true. (Should be ignored).
    // Parcel B: rect: (30, 30) size 10x10 (containing). In "open-desert", isOwner = false (foreign). (Should be ignored).
    // Parcel C: rect: (100, 30) size 10x10. In "open-desert", isOwner = true. (Should be selected).
    const parcelA = mockParcel("parcel:A", "open-desert-overworld", { x: 30, y: 30, w: 10, h: 10 }, true);
    const parcelB = mockParcel("parcel:B", "open-desert", { x: 30, y: 30, w: 10, h: 10 }, false);
    const parcelC = mockParcel("parcel:C", "open-desert", { x: 100, y: 30, w: 10, h: 10 }, true);

    state.serverAuthority.placedParcels = [parcelA, parcelB, parcelC];

    const lines = routeFarm(session, ["plot"]);
    const text = lines.map((line) => line.text).join("\n");

    // It should select parcel:C because it is owned and in the current area, even though it's farther than A and B.
    expect(text).toContain("Parcel parcel:C");
  });
});
