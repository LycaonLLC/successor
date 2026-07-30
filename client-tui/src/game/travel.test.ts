import { describe, expect, it } from "vitest";

import type { SliceSnapshot } from "@successor/client/src/slice-core/gameState";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { enqueuePurchase, enqueueUseTicket, listTickets, nearestTerminal, resolveDestination, travelDestinations } from "./travel";

function withCatalog(slice: SliceSnapshot): void {
  slice.travelCatalog = {
    schema: "successor.travel-catalog.v1",
    planets: [
      {
        id: "open-desert",
        label: "Open Desert",
        biome: "desert",
        areaId: "open-desert",
        cities: [{ id: "warden", label: "Warden", terminalPropId: "travel-terminal-1", spawn: { x: 40, y: 44 } }],
      },
      {
        id: "verdance",
        label: "Verdance",
        biome: "forest",
        areaId: "verdance-forest",
        cities: [{ id: "lowbough", label: "Lowbough", terminalPropId: "vt-1", spawn: { x: 10, y: 10 } }],
      },
    ],
  };
}

describe("travel flows", () => {
  it("flattens the catalog and resolves planet/city loosely", () => {
    const { slice } = createTuiPlayStateFixture();
    withCatalog(slice);
    expect(travelDestinations(slice)).toHaveLength(2);
    expect(resolveDestination(slice, "verdance", undefined)?.city.id).toBe("lowbough");
    expect(resolveDestination(slice, "Verd", "low")?.city.label).toBe("Lowbough");
    expect(resolveDestination(slice, "nowhere", undefined)).toBeNull();
  });

  it("finds the nearest terminal with the reach gate", () => {
    const { state, slice } = createTuiPlayStateFixture();
    // fixture terminal at (52,60) size 2×2 vs player (40,44) → far
    const terminal = nearestTerminal(state, slice);
    expect(terminal?.propId).toBe("travel-terminal-1");
    expect(terminal?.inReach).toBe(false);
    state.player = { x: 52, y: 60 };
    state.serverAuthority.actors[state.serverAuthority.playerActorId!]!.x = 52;
    state.serverAuthority.actors[state.serverAuthority.playerActorId!]!.y = 60;
    expect(nearestTerminal(state, slice)?.inReach).toBe(true);
  });

  it("lists tickets from scoped rows with travelTicket metadata and uses them", () => {
    const { state, slice, playerId } = createTuiPlayStateFixture();
    withCatalog(slice);
    state.inventory.push({
      container: `${playerId}:field-pack`,
      item: "Travel Ticket",
      itemId: 5001,
      variantId: 0,
      quantity: 1,
      reserved: 0,
      available: 1,
      stackId: 71,
      metadata: {
        travelTicket: {
          ticketId: "tk-1",
          fromPlanetId: "open-desert",
          fromCityId: "warden",
          toPlanetId: "verdance",
          toCityId: "lowbough",
          originTerminalPropId: "travel-terminal-1",
          originAreaId: "open-desert",
          destAreaId: "verdance-forest",
          destSpawn: { x: 10, y: 10 },
        },
      },
    });
    const tickets = listTickets(state);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.ticket.toCityId).toBe("lowbough");

    const before = state.authorityCommands.pending.length;
    expect(enqueueUseTicket(state, slice, tickets[0]!)).toBe(true);
    const terminal = { propId: "travel-terminal-1", label: "Travel terminal", distanceCells: 1, inReach: true };
    const destination = resolveDestination(slice, "verdance", "lowbough")!;
    expect(enqueuePurchase(state, slice, terminal, destination)).toBe(true);
    expect(state.authorityCommands.pending.length).toBe(before + 2);
  });
});
