// @vitest-environment happy-dom
import { createPlayState, type PlayState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { afterEach, describe, expect, it } from "vitest";
import { configureWaypointStore, waypoints } from "../waypoints/store";
import {
  completedSteps,
  firstStepsGuidance,
  firstStepsStorageKey,
  loadFirstSteps,
  MOVE_DONE_CELLS,
  mountFirstSteps,
  saveFirstSteps,
  type FirstStepId,
  type FirstStepsController,
  type FirstStepsObservation,
  type FirstStepsRecord,
} from "./firstSteps";

function slice(): SliceSnapshot {
  return {
    schema: "test",
    tick: 1,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Test", width: 64, height: 64, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 64, height: 64, level: 0 }],
    stateHash: "hash",
    camera: { followActor: "player", zoom: 1 },
    actors: [
      {
        id: "player",
        entity: "1:1",
        areaId: "open-desert-overworld",
        label: "Field Observer",
        role: "player",
        sprite: "s",
        poseSet: "idle",
        direction: "front",
        cell: { x: 12, y: 13 },
        route: [],
      },
      {
        id: "camp-trainer",
        entity: "1:2",
        areaId: "open-desert-overworld",
        label: "Knox Vale",
        role: "profession_trainer",
        sprite: "s",
        poseSet: "idle",
        direction: "front",
        // Mirrors the fixture contract: a REAL walk (~7 cells) from spawn,
        // beyond TRAINER_REACHED so the objective cannot auto-resolve at boot.
        cell: { x: 17, y: 18 },
        route: [],
      },
      {
        id: "grok",
        entity: "1:3",
        areaId: "open-desert-overworld",
        label: "GR0K",
        role: "scripted_player",
        sprite: "s",
        poseSet: "idle",
        direction: "right",
        cell: { x: 10, y: 14 },
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

function memoryStorage(): Storage {
  const rows = new Map<string, string>();
  return {
    get length() { return rows.size; },
    clear: () => rows.clear(),
    getItem: (key: string) => rows.get(key) ?? null,
    key: (index: number) => [...rows.keys()][index] ?? null,
    removeItem: (key: string) => { rows.delete(key); },
    setItem: (key: string, value: string) => { rows.set(key, value); },
  } as Storage;
}

function observation(overrides: Partial<FirstStepsObservation> = {}): FirstStepsObservation {
  return {
    movedCells: 0,
    trainerReached: false,
    interactAvailable: false,
    interactWindowOpen: false,
    targetSelected: false,
    actQueued: false,
    ...overrides,
  };
}

function record(done: FirstStepId[] = []): FirstStepsRecord {
  return { done: new Set(done), waypointId: null };
}

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    // Executor form: this package's tsc lib predates Promise.withResolvers.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

let keySeq = 0;
interface Harness {
  state: PlayState;
  controller: FirstStepsController;
  root: HTMLElement;
  storage: Storage;
  characterKey: string;
  converseOpen: { value: boolean };
  lootOpen: { value: boolean };
}

function authorityActor(id: string, x: number, y: number): PlayState["serverAuthority"]["actors"][string] {
  return {
    id,
    label: id === "camp-trainer" ? "Knox Vale" : id,
    areaId: "open-desert-overworld",
    x,
    y,
    direction: "front",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
  } as unknown as PlayState["serverAuthority"]["actors"][string];
}

interface HarnessOptions {
  prime?: (storage: Storage, characterKey: string) => void;
  /** Seed the authoritative player actor at spawn (default true). */
  seedAuthority?: boolean;
}

function mountHarness(options: HarnessOptions = {}): Harness {
  keySeq += 1;
  const characterKey = `first-steps-test-${keySeq}`;
  const storage = memoryStorage();
  // Waypoint store is a page singleton: bind it to this test's fresh storage.
  configureWaypointStore(characterKey, storage);
  options.prime?.(storage, characterKey);
  const worldSlice = slice();
  const state = createPlayState(worldSlice, "player");
  if (options.seedAuthority !== false) {
    state.serverAuthority.actors.player = authorityActor("player", 12.5, 13.5);
  }
  const root = document.createElement("div");
  const converseOpen = { value: false };
  const lootOpen = { value: false };
  const controller = mountFirstSteps(root, state, worldSlice, {
    characterKey,
    storage,
    converseWindowOpen: () => converseOpen.value,
    lootWindowOpen: () => lootOpen.value,
  });
  return { state, controller, root, storage, characterKey, converseOpen, lootOpen };
}

let active: Harness | null = null;

afterEach(() => {
  active?.controller.dispose();
  active = null;
});

describe("first steps guidance order", () => {
  it("teaches MOVE alone first, then surfaces the trainer objective", () => {
    const fresh = record();
    expect(firstStepsGuidance(fresh, observation())).toEqual({ objectiveVisible: false, teach: "move" });
    expect(firstStepsGuidance(record(["move"]), observation())).toEqual({ objectiveVisible: true, teach: null });
  });

  it("shows USE only when an interactable is actually available, preempting ACT", () => {
    const moved = record(["move"]);
    expect(firstStepsGuidance(moved, observation({ targetSelected: true })).teach).toBe("act");
    expect(firstStepsGuidance(moved, observation({ targetSelected: true, interactAvailable: true })).teach).toBe("interact");
    expect(firstStepsGuidance(record(["move", "interact", "act"]), observation({ interactAvailable: true, targetSelected: true })))
      .toEqual({ objectiveVisible: true, teach: null });
  });

  it("completes steps from world actions even before their row shows", () => {
    expect(completedSteps(record(), observation({ movedCells: MOVE_DONE_CELLS }))).toEqual(["move"]);
    expect(completedSteps(record(), observation({ trainerReached: true }))).toEqual(["trainer"]);
    expect(completedSteps(record(["move", "trainer"]), observation({ trainerReached: true, actQueued: true }))).toEqual(["act"]);
    expect(completedSteps(record(["move", "trainer", "interact", "act"]), observation({ movedCells: 99, trainerReached: true, interactWindowOpen: true, actQueued: true }))).toEqual([]);
  });

  it("an interact window (loot cache OR converse with any NPC) completes USE only — never the trainer objective", () => {
    expect(completedSteps(record(), observation({ interactWindowOpen: true }))).toEqual(["interact"]);
  });
});

describe("first steps persistence", () => {
  it("round-trips done steps and the breadcrumb waypoint id", () => {
    const storage = memoryStorage();
    const key = firstStepsStorageKey("Round Trip");
    saveFirstSteps(storage, key, { done: new Set(["move", "trainer"]), waypointId: "wp_1" });
    const loaded = loadFirstSteps(storage, key);
    expect([...loaded.done].sort()).toEqual(["move", "trainer"]);
    expect(loaded.waypointId).toBe("wp_1");
  });

  it("treats an unreadable payload as a fresh record", () => {
    const storage = memoryStorage();
    const key = firstStepsStorageKey("bad");
    storage.setItem(key, "{not json");
    const loaded = loadFirstSteps(storage, key);
    expect(loaded.done.size).toBe(0);
    expect(loaded.waypointId).toBeNull();
  });
});

describe("first steps mount", () => {
  it("does not auto-resolve the objective at boot — the trainer is a real walk away", async () => {
    active = mountHarness();
    await frames(3);
    const stored = loadFirstSteps(active.storage, firstStepsStorageKey(active.characterKey));
    expect(stored.done.has("trainer")).toBe(false);
    expect(stored.done.has("move")).toBe(false);
  });

  it("ignores projection hydration: MOVE completes only from authority movement", async () => {
    active = mountHarness({ seedAuthority: false });
    await frames(2);
    // Client projection snapping to the authority spawn is NOT movement.
    active.state.player.x = 30;
    active.state.player.y = 30;
    await frames(2);
    let stored = loadFirstSteps(active.storage, firstStepsStorageKey(active.characterKey));
    expect(stored.done.has("move")).toBe(false);

    // Authority hydrates — baseline anchors HERE, still no movement.
    active.state.serverAuthority.actors.player = authorityActor("player", 30.5, 30.5);
    await frames(2);
    stored = loadFirstSteps(active.storage, firstStepsStorageKey(active.characterKey));
    expect(stored.done.has("move")).toBe(false);

    // A real authoritative walk completes MOVE.
    active.state.serverAuthority.actors.player!.x = 30.5 + MOVE_DONE_CELLS + 0.5;
    await frames(2);
    stored = loadFirstSteps(active.storage, firstStepsStorageKey(active.characterKey));
    expect(stored.done.has("move")).toBe(true);
  });

  it("seeds the trainer breadcrumb waypoint after first movement and clears it on arrival", async () => {
    active = mountHarness();
    await frames(2);
    const teachRow = active.root.querySelector<HTMLElement>('[data-ref="teach"]')!;
    const objectiveRow = active.root.querySelector<HTMLElement>('[data-ref="objective"]')!;
    expect(teachRow.hidden).toBe(false);
    expect(objectiveRow.hidden).toBe(true);
    expect(waypoints().length).toBe(0);

    // Walk away from the boot cell (and the trainer) — MOVE completes,
    // the objective + breadcrumb appear.
    const me = active.state.serverAuthority.actors.player!;
    me.x -= MOVE_DONE_CELLS + 0.5;
    await frames(2);
    expect(objectiveRow.hidden).toBe(false);
    const marks = waypoints();
    expect(marks.length).toBe(1);
    expect(marks[0]!.name).toBe("Knox Vale");
    expect(marks[0]!.active).toBe(true);
    expect(marks[0]!.areaId).toBe("open-desert-overworld");
    expect({ x: marks[0]!.x, y: marks[0]!.y }).toEqual({ x: 17, y: 18 });

    // Arrive at the trainer — objective resolves, breadcrumb is deleted, both persist.
    me.x = 17.5 - 1;
    me.y = 18.5;
    await frames(2);
    expect(objectiveRow.hidden).toBe(true);
    expect(waypoints().length).toBe(0);
    const stored = loadFirstSteps(active.storage, firstStepsStorageKey(active.characterKey));
    expect(stored.done.has("move")).toBe(true);
    expect(stored.done.has("trainer")).toBe(true);
    expect(stored.waypointId).toBeNull();
  });

  it("cache loot and unrelated converse complete USE only — the objective stands until Knox is reached", async () => {
    active = mountHarness();
    // Let the first frame anchor the authority movement baseline, THEN walk
    // away from the trainer so no arrival can fire.
    await frames(1);
    const me = active.state.serverAuthority.actors.player!;
    me.x -= MOVE_DONE_CELLS + 1;
    active.state.interactions.options.push({
      id: "loot:open-desert-cache-01",
      kind: "lootCache",
      label: "Camp Supply Cache",
      detail: "Loot",
      targetId: "open-desert-cache-01",
      distanceCells: 1,
    });
    await frames(2);
    const teachRow = active.root.querySelector<HTMLElement>('[data-ref="teach"]')!;
    const objectiveRow = active.root.querySelector<HTMLElement>('[data-ref="objective"]')!;
    expect(teachRow.hidden).toBe(false);
    expect(teachRow.querySelector('[data-ref="teachMain"]')!.textContent).toBe("USE");
    expect(objectiveRow.hidden).toBe(false);

    // Open the cache — USE done, objective + breadcrumb untouched.
    active.lootOpen.value = true;
    await frames(2);
    let stored = loadFirstSteps(active.storage, firstStepsStorageKey(active.characterKey));
    expect(stored.done.has("interact")).toBe(true);
    expect(stored.done.has("trainer")).toBe(false);
    expect(teachRow.hidden).toBe(true);
    expect(objectiveRow.hidden).toBe(false);
    expect(waypoints().length).toBe(1);

    // Talking to GR0K (any converse) must not mark the trainer found either.
    active.lootOpen.value = false;
    active.converseOpen.value = true;
    await frames(2);
    stored = loadFirstSteps(active.storage, firstStepsStorageKey(active.characterKey));
    expect(stored.done.has("trainer")).toBe(false);
    expect(objectiveRow.hidden).toBe(false);
    expect(waypoints().length).toBe(1);

    // Only physically reaching Knox resolves the objective.
    active.converseOpen.value = false;
    me.x = 17.5;
    me.y = 18.5 - 1;
    await frames(2);
    stored = loadFirstSteps(active.storage, firstStepsStorageKey(active.characterKey));
    expect(stored.done.has("trainer")).toBe(true);
    expect(objectiveRow.hidden).toBe(true);
    expect(waypoints().length).toBe(0);
  });

  it("click on a row dismisses that step for good", async () => {
    active = mountHarness();
    await frames(2);
    const teachRow = active.root.querySelector<HTMLElement>('[data-ref="teach"]')!;
    teachRow.click();
    await frames(2);
    const stored = loadFirstSteps(active.storage, firstStepsStorageKey(active.characterKey));
    expect(stored.done.has("move")).toBe(true);
    expect(teachRow.hidden).toBe(true);
  });

  it("mounts nothing for a fully guided character", async () => {
    active = mountHarness({ prime: (storage, characterKey) => {
      saveFirstSteps(storage, firstStepsStorageKey(characterKey), {
        done: new Set(["move", "trainer", "interact", "act"]),
        waypointId: null,
      });
    } });
    await frames(2);
    expect(active.root.children.length).toBe(0);
    expect(waypoints().length).toBe(0);
  });
});
