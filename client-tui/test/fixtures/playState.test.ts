import { describe, expect, it } from "vitest";
import { createVerbRegistry } from "../../../client/src/slice-core/verbRegistry/index";

import {
  TUI_FIXTURE_CACHE_CONTAINER,
  TUI_FIXTURE_CHARACTER_ID,
  TUI_FIXTURE_LOOT_CONTAINER,
  TUI_FIXTURE_PLAYER_ID,
  classifyInventoryRowFor3dParity,
  createTuiPlayStateFixture,
  visibleInventoryRowsFor3dParity,
} from "./playState";

describe("TUI PlayState fixtures", () => {
  it("seeds every visibility-law surface without relying on DOM or GPU state", () => {
    const { state } = createTuiPlayStateFixture();

    expect(state.serverAuthority.enabled).toBe(true);
    expect(state.serverAuthority.actors[TUI_FIXTURE_PLAYER_ID]?.weapon?.weaponId).toBe("slugthrower");
    expect(state.serverAuthority.actors["rogue-1"]?.aiAttitude).toBe("hostile");
    expect(state.abilityQueue.view?.entries[0]?.targetActorId).toBe("rogue-1");
    expect(state.serverAuthority.surveyResults[0]?.concentrationMilli.length).toBe(25);
    expect(state.serverAuthority.resourceSpawns[0]?.stats.extraction_yield).toBe(880);
    expect(state.weather[0]?.phase).toBe("warning");
    expect(state.serverAuthority.receiptLog[0]?.commandId).toBe(9001);
    expect(state.serverAuthority.eventLog[0]?.kind).toBe("ranged_roll");
  });

  it("contains sentinel inventory rows that prove raw /inv is broader than the 3D partition", () => {
    const { state } = createTuiPlayStateFixture();
    const context = { playerId: TUI_FIXTURE_PLAYER_ID, characterId: TUI_FIXTURE_CHARACTER_ID };
    const partitions = new Map(state.inventory.map((row) => [row.container, classifyInventoryRowFor3dParity(state, row, context)]));

    expect(partitions.get(`${TUI_FIXTURE_PLAYER_ID}:field-pack`)).toBe("local");
    expect(partitions.get(`${TUI_FIXTURE_CHARACTER_ID}:pouch`)).toBe("local");
    expect(partitions.get("district-exchange")).toBe("datapad");
    expect(partitions.get(TUI_FIXTURE_LOOT_CONTAINER)).toBe("hidden");
    expect(partitions.get(`${TUI_FIXTURE_CACHE_CONTAINER}:sealed`)).toBe("hidden");
    expect(partitions.get("other-player:field-pack")).toBe("hidden");
    expect(visibleInventoryRowsFor3dParity(state, context).map((row) => row.container)).toEqual([
      `${TUI_FIXTURE_PLAYER_ID}:field-pack`,
      `${TUI_FIXTURE_CHARACTER_ID}:pouch`,
      "district-exchange",
    ]);
  });

  it("surfaces one open loot/cache container only after the caller proves the 3D loot gate", () => {
    const { state } = createTuiPlayStateFixture();
    const lootContext = {
      playerId: TUI_FIXTURE_PLAYER_ID,
      characterId: TUI_FIXTURE_CHARACTER_ID,
      openLootContainer: TUI_FIXTURE_LOOT_CONTAINER,
    };
    const cacheContext = {
      playerId: TUI_FIXTURE_PLAYER_ID,
      characterId: TUI_FIXTURE_CHARACTER_ID,
      openLootContainer: TUI_FIXTURE_CACHE_CONTAINER,
    };

    expect(visibleInventoryRowsFor3dParity(state, lootContext).map((row) => row.container)).toContain(TUI_FIXTURE_LOOT_CONTAINER);
    expect(visibleInventoryRowsFor3dParity(state, lootContext).map((row) => row.container)).not.toContain(`${TUI_FIXTURE_CACHE_CONTAINER}:sealed`);
    expect(visibleInventoryRowsFor3dParity(state, cacheContext).map((row) => row.container)).toContain(`${TUI_FIXTURE_CACHE_CONTAINER}:sealed`);
    expect(visibleInventoryRowsFor3dParity(state, cacheContext).map((row) => row.container)).not.toContain(TUI_FIXTURE_LOOT_CONTAINER);
  });
  it("re-verifies SP1 /inv scoping against the TUI fixture partition", () => {
    const { slice, state } = createTuiPlayStateFixture();
    const registry = createVerbRegistry({
      state,
      slice,
      inventoryIdentity: { playerId: TUI_FIXTURE_PLAYER_ID, characterId: TUI_FIXTURE_CHARACTER_ID },
    });

    const result = registry.executeLine("/inv");
    const data = result?.data as {
      totalStacks: number;
      totalAvailable: number;
      rows: Array<{ container: string; item: string }>;
    };

    expect(result?.text).toContain("INV 3 STACKS");
    expect(data.totalStacks).toBe(3);
    expect(data.totalAvailable).toBe(4);
    expect(data.rows.map((row) => row.container)).toEqual([
      `${TUI_FIXTURE_PLAYER_ID}:field-pack`,
      `${TUI_FIXTURE_CHARACTER_ID}:pouch`,
      "district-exchange",
    ]);
    expect(data.rows.map((row) => row.container)).not.toContain(TUI_FIXTURE_LOOT_CONTAINER);
    expect(data.rows.map((row) => row.container)).not.toContain(`${TUI_FIXTURE_CACHE_CONTAINER}:sealed`);
    expect(data.rows.map((row) => row.container)).not.toContain("other-player:field-pack");
  });

});
