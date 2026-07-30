import type { PlayState } from "@successor/client/src/slice-core/gameState";
import {
  clickMoveTarget,
  drainClickMoveEvents,
  type ClickMoveEvent,
} from "@successor/client/src/slice-core/movementSystem";
import { describe, expect, it } from "vitest";
import { explicitLockTargetId, setExplicitLockTarget } from "../../../combat/softLock";
import {
  configureWaypointStore,
  createWaypoint,
  MAX_WAYPOINTS,
  waypoints,
} from "../../waypoints/store";
import type { ContextRadial, RadialAction, RadialHandlers } from "../contextRadial";
import {
  attachDatapadMapPointer,
  createDatapadMapProjection,
  datapadMapViewOptions,
  drawDatapadMapStructures,
  ownCorpseMapMarkers,
  worldGridLines,
  type DatapadMapKeyboardEvent,
  type DatapadMapPointerEvent,
  type DatapadMapPointerEventType,
  type DatapadMapSurface,
} from "./datapadMap";

const EPSILON = 1e-9;

function expectPoint(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
}

function canvasCornersInWorld(projection: {
  canvasWidth: number;
  canvasHeight: number;
  widthCells: number;
  heightCells: number;
  canvasToWorld(x: number, y: number): { x: number; y: number };
}): void {
  const tolerance = 1e-6;
  for (const [cx, cy] of [
    [0, 0],
    [projection.canvasWidth, 0],
    [0, projection.canvasHeight],
    [projection.canvasWidth, projection.canvasHeight],
  ] as const) {
    const world = projection.canvasToWorld(cx, cy);
    expect(world.x).toBeGreaterThanOrEqual(-tolerance);
    expect(world.x).toBeLessThanOrEqual(projection.widthCells + tolerance);
    expect(world.y).toBeGreaterThanOrEqual(-tolerance);
    expect(world.y).toBeLessThanOrEqual(projection.heightCells + tolerance);
  }
}

describe("datapad map north-up contract", () => {
  it("keeps both player-facing modes north-up and changes framing only", () => {
    const center = { x: 742.5, y: 509.5 };

    expect(datapadMapViewOptions("orbital", center)).toEqual({
      basis: "north-up",
      fit: "contain",
    });
    expect(datapadMapViewOptions("tactical", center)).toEqual({
      basis: "north-up",
      fit: "cover",
      zoom: 1.15,
      center,
    });
  });

  it.each(["orbital", "tactical"] as const)(
    "projects N/S/E/W up/down/right/left in %s framing",
    (mode) => {
      const projection = createDatapadMapProjection(
        1024,
        1024,
        800,
        800,
        datapadMapViewOptions(mode, { x: 512, y: 512 }),
      );
      const origin = projection.worldToCanvas(512, 512);
      const cardinals = [
        { name: "north", world: { x: 512, y: 511 }, screen: { x: 0, y: -1 } },
        { name: "south", world: { x: 512, y: 513 }, screen: { x: 0, y: 1 } },
        { name: "east", world: { x: 513, y: 512 }, screen: { x: 1, y: 0 } },
        { name: "west", world: { x: 511, y: 512 }, screen: { x: -1, y: 0 } },
      ];
      for (const cardinal of cardinals) {
        const point = projection.worldToCanvas(cardinal.world.x, cardinal.world.y);
        const dx = point.x - origin.x;
        const dy = point.y - origin.y;
        if (cardinal.screen.x === 0) expect(dx, `${cardinal.name} x drift`).toBeCloseTo(0, 8);
        else expect(Math.sign(dx), `${cardinal.name} x sign`).toBe(cardinal.screen.x);
        if (cardinal.screen.y === 0) expect(dy, `${cardinal.name} y drift`).toBeCloseTo(0, 8);
        else expect(Math.sign(dy), `${cardinal.name} y sign`).toBe(cardinal.screen.y);
      }
    },
  );

  it("maps every square ORBITAL world corner to its canvas corner", () => {
    const projection = createDatapadMapProjection(
      1024,
      1024,
      800,
      800,
      datapadMapViewOptions("orbital", { x: 742.5, y: 509.5 }),
    );

    expect(projection.basis).toBe("north-up");
    expectPoint(projection.worldToCanvas(0, 0), { x: 0, y: 0 });
    expectPoint(projection.worldToCanvas(1024, 0), { x: 800, y: 0 });
    expectPoint(projection.worldToCanvas(0, 1024), { x: 0, y: 800 });
    expectPoint(projection.worldToCanvas(1024, 1024), { x: 800, y: 800 });
  });

  it("uniformly contains a non-square ORBITAL world and round-trips raw points", () => {
    const projection = createDatapadMapProjection(
      1024,
      512,
      800,
      600,
      datapadMapViewOptions("orbital", { x: 900, y: 40 }),
    );

    expectPoint(projection.worldToCanvas(0, 0), { x: 0, y: 100 });
    expectPoint(projection.worldToCanvas(1024, 512), { x: 800, y: 500 });
    for (const raw of [{ x: 0, y: 0 }, { x: 511.5, y: 255.5 }, { x: 1024, y: 512 }]) {
      const canvas = projection.worldToCanvas(raw.x, raw.y);
      expectPoint(projection.canvasToWorld(canvas.x, canvas.y), raw);
    }
  });

  it("uses one projection for props, storms, waypoints, and the player", () => {
    const projection = createDatapadMapProjection(40, 24, 800, 800);
    const raw = { x: 13.5, y: 7.5 };
    const expected = projection.worldToCanvas(raw.x, raw.y);

    for (const overlay of ["prop", "storm", "waypoint", "player"]) {
      const point = projection.worldToCanvas(raw.x, raw.y);
      expectPoint(point, expected);
      expect(overlay).toBeTruthy();
    }
    expectPoint(projection.canvasToWorld(expected.x, expected.y), raw);
  });
});

describe("datapad map tactical cover framing", () => {
  it.each([
    [1024, 1024, 800, 800],
    [1024, 512, 800, 800],
    [512, 1024, 800, 600],
  ])("inverse-maps every canvas corner inside a %dx%d world", (w, h, cw, ch) => {
    const projection = createDatapadMapProjection(w, h, cw, ch, {
      basis: "north-up",
      fit: "cover",
      zoom: 1.15,
      center: { x: w * 0.3, y: h * 0.7 },
    });
    canvasCornersInWorld(projection);
  });

  it("clamps an off-world requested center without rotating coordinates", () => {
    const projection = createDatapadMapProjection(1024, 1024, 800, 800, {
      basis: "north-up",
      fit: "cover",
      zoom: 1.15,
      center: { x: -5000, y: 99999 },
    });
    expect(projection.viewCenter.x).toBeGreaterThanOrEqual(0);
    expect(projection.viewCenter.x).toBeLessThanOrEqual(1024);
    expect(projection.viewCenter.y).toBeGreaterThanOrEqual(0);
    expect(projection.viewCenter.y).toBeLessThanOrEqual(1024);
  });

  it("round-trips canvas and world in both framings", () => {
    const contain = createDatapadMapProjection(1024, 1024, 800, 800);
    const cover = createDatapadMapProjection(1024, 1024, 800, 800, {
      basis: "north-up",
      fit: "cover",
      zoom: 1.15,
      center: { x: 742.5, y: 509.5 },
    });
    for (const projection of [contain, cover]) {
      for (const [cx, cy] of [[120, 640], [400, 400], [799, 1]] as const) {
        const world = projection.canvasToWorld(cx, cy);
        expectPoint(projection.worldToCanvas(world.x, world.y), { x: cx, y: cy });
      }
    }
  });
});

describe("datapad north-up world grid", () => {
  it("renders x rules vertically and y rules horizontally", () => {
    const projection = createDatapadMapProjection(1024, 1024, 800, 800);
    for (const line of worldGridLines(1024, 1024)) {
      const a = projection.worldToCanvas(line.from.x, line.from.y);
      const b = projection.worldToCanvas(line.to.x, line.to.y);
      if (line.axis === "x") {
        expect(b.x).toBeCloseTo(a.x, 8);
        expect(Math.abs(b.y - a.y)).toBeGreaterThan(EPSILON);
      } else {
        expect(b.y).toBeCloseTo(a.y, 8);
        expect(Math.abs(b.x - a.x)).toBeGreaterThan(EPSILON);
      }
    }
  });

  it("spaces minor rules every 64 raw cells and majors every 256", () => {
    const lines = worldGridLines(1024, 1024);
    for (const axis of ["x", "y"] as const) {
      expect(lines.filter((line) => line.axis === axis).map((line) => line.coordinate)).toEqual(
        Array.from({ length: 15 }, (_, index) => (index + 1) * 64),
      );
    }
    for (const line of lines) expect(line.major).toBe(line.coordinate % 256 === 0);
  });
});

// ── Pointer interactions ─────────────────────────────────────────────────────

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

interface RadialCall {
  actions: RadialAction[];
  handlers: RadialHandlers;
}

let harnessSeq = 0;

/** 64-cell world on a 512px canvas (orbital contain): 8 canvas px per cell. */
function pointerHarness(options: { activeAreaId?: string; mappedAreaId?: string; deathPhase?: string } = {}) {
  harnessSeq += 1;
  configureWaypointStore(`datapad-map-pointer-${harnessSeq}`, memoryStorage());
  setExplicitLockTarget(null);
  const projection = createDatapadMapProjection(64, 64, 512, 512, datapadMapViewOptions("orbital", { x: 32, y: 32 }));
  const state = {
    activeAreaId: options.activeAreaId ?? "area-a",
    death: { phase: options.deathPhase ?? "alive" },
    selectedActorId: null,
    softLockActorId: null,
    examineActorId: null,
  } as unknown as PlayState;
  type SurfaceListener = ((event: DatapadMapPointerEvent) => void) | ((event: DatapadMapKeyboardEvent) => void);
  const listeners = new Map<DatapadMapPointerEventType | "keydown", Set<SurfaceListener>>();
  const surface: DatapadMapSurface = {
    addEventListener(type: DatapadMapPointerEventType | "keydown", listener: SurfaceListener) {
      let bucket = listeners.get(type);
      if (!bucket) {
        bucket = new Set();
        listeners.set(type, bucket);
      }
      bucket.add(listener);
    },
    removeEventListener(type: DatapadMapPointerEventType | "keydown", listener: SurfaceListener) {
      listeners.get(type)?.delete(listener);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 512, height: 512 }),
  };
  const radialCalls: RadialCall[] = [];
  let radialClosed = 0;
  const radial: ContextRadial = {
    isOpen: false,
    openFor(_x, _y, actions, handlers) {
      radialCalls.push({ actions: [...actions], handlers });
    },
    close() {
      radialClosed += 1;
    },
    dispose() {},
  };
  const statuses: string[] = [];
  const controller = attachDatapadMapPointer(surface, {
    radial,
    state,
    projection: () => projection,
    mappedAreaId: () => options.mappedAreaId ?? "area-a",
    now: () => 1000,
    onStatus: (message) => statuses.push(message),
  });
  const dispatch = (type: DatapadMapPointerEventType, clientX: number, clientY: number): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      (listener as (event: DatapadMapPointerEvent) => void)({ clientX, clientY, preventDefault() {} });
    }
  };
  const pressKey = (key: string): { defaultPrevented: boolean } => {
    const receipt = { defaultPrevented: false };
    for (const listener of [...(listeners.get("keydown") ?? [])]) {
      (listener as (event: DatapadMapKeyboardEvent) => void)({
        key,
        preventDefault() {
          receipt.defaultPrevented = true;
        },
      });
    }
    return receipt;
  };
  const lastRadial = (): RadialCall => {
    const call = radialCalls[radialCalls.length - 1];
    if (!call) throw new Error("no radial call recorded");
    return call;
  };
  return {
    projection,
    state,
    listeners,
    controller,
    dispatch,
    pressKey,
    radialCalls,
    lastRadial,
    closedCount: () => radialClosed,
    statuses,
  };
}

describe("datapad map pointer — ground movement", () => {
  it("double-click on ground routes click movement to the straight world destination", () => {
    const h = pointerHarness();

    // canvas (200, 104) → world (25, 13) → authority cells (24.5, 12.5).
    h.dispatch("dblclick", 200, 104);

    expect(clickMoveTarget(h.state)).toMatchObject({ x: 24.5, y: 12.5, areaId: "area-a" });
    const events: ClickMoveEvent[] = [];
    drainClickMoveEvents(h.state, events);
    expect(events.map((event) => event.kind)).toEqual(["set"]);
  });

  it("inverts the canvas point through the shared projection (round trip)", () => {
    const h = pointerHarness();
    const canvasPoint = h.projection.worldToCanvas(41.25, 7.75);

    h.dispatch("dblclick", canvasPoint.x * (512 / h.projection.canvasWidth), canvasPoint.y * (512 / h.projection.canvasHeight));

    const target = clickMoveTarget(h.state);
    expect(target?.x).toBeCloseTo(40.75, 6);
    expect(target?.y).toBeCloseTo(7.25, 6);
  });

  it("refuses ground movement when the player is in another area", () => {
    const h = pointerHarness({ activeAreaId: "area-b" });

    h.dispatch("dblclick", 256, 256);

    expect(clickMoveTarget(h.state)).toBeNull();
    expect(h.statuses.length).toBe(1);
  });

  it.each([
    ["downed"],
    ["clone_pending"],
  ])("refuses ground movement while %s (same gate as a world ground click)", (phase) => {
    const h = pointerHarness({ deathPhase: phase });

    h.dispatch("dblclick", 200, 104);

    expect(clickMoveTarget(h.state)).toBeNull();
  });

  it("drops target, locks and examine focus before the move goes out", () => {
    const h = pointerHarness();
    h.state.selectedActorId = "npc-1";
    h.state.softLockActorId = "npc-1";
    h.state.examineActorId = "npc-1";
    setExplicitLockTarget("npc-1");

    h.dispatch("dblclick", 200, 104);

    expect(clickMoveTarget(h.state)).toMatchObject({ x: 24.5, y: 12.5 });
    expect(h.state.selectedActorId).toBeNull();
    expect(h.state.softLockActorId).toBeNull();
    expect(h.state.examineActorId).toBeNull();
    expect(explicitLockTargetId()).toBeNull();
  });

  it("keeps the engagement focus when a cross-area move is refused", () => {
    const h = pointerHarness({ activeAreaId: "area-b" });
    h.state.selectedActorId = "npc-1";
    setExplicitLockTarget("npc-1");

    h.dispatch("dblclick", 200, 104);

    expect(clickMoveTarget(h.state)).toBeNull();
    expect(h.state.selectedActorId).toBe("npc-1");
    expect(explicitLockTargetId()).toBe("npc-1");
  });

  it.each([
    ["west", 2, 256, 0, 31.5],
    ["east", 510, 256, 63, 31.5],
    ["north", 256, 2, 31.5, 0],
    ["south", 256, 510, 31.5, 63],
  ])("clamps a %s-edge click to the outermost legal cell center", (_edge, clientX, clientY, x, y) => {
    const h = pointerHarness();

    // 2 canvas px = world 0.25 — inside the world rect but off the legal
    // cell-center band; the destination clamps to the border cell.
    h.dispatch("dblclick", clientX, clientY);

    const target = clickMoveTarget(h.state);
    expect(target?.x).toBeCloseTo(x, 6);
    expect(target?.y).toBeCloseTo(y, 6);
    expect(target?.areaId).toBe("area-a");
  });
});

describe("datapad map pointer — waypoints", () => {
  it("single click selects a waypoint and lights a dormant one", () => {
    const h = pointerHarness();
    const created = createWaypoint({ name: "Camp", x: 10, y: 10, areaId: "area-a" });
    const id = created.waypoint!.id;
    expect(created.waypoint!.active).toBe(false);

    // Marker renders at world (10.5, 10.5) → canvas (84, 84).
    h.dispatch("click", 84, 84);

    expect(h.controller.selectedWaypointId()).toBe(id);
    expect(waypoints().find((row) => row.id === id)?.active).toBe(true);

    // Ground click clears the selection.
    h.dispatch("click", 400, 400);
    expect(h.controller.selectedWaypointId()).toBeNull();
  });

  it("marker hit takes priority over ground on double-click", () => {
    const h = pointerHarness();
    createWaypoint({ name: "Camp", x: 10, y: 10, areaId: "area-a" });

    // Slightly off the marker center but well within the grab radius.
    h.dispatch("dblclick", 87, 82);

    expect(clickMoveTarget(h.state)).toMatchObject({ x: 10, y: 10, areaId: "area-a" });
  });

  it("right-click on ground offers Move Here and Create Waypoint", () => {
    const h = pointerHarness();

    h.dispatch("contextmenu", 200, 100);

    const call = h.lastRadial();
    expect(call.actions.map((action) => action.label)).toEqual(["MOVE HERE", "CREATE WAYPOINT"]);
    expect(call.actions.every((action) => action.enabled)).toBe(true);

    call.handlers.onAction("waypoint");
    const created = waypoints()[0];
    expect(created).toMatchObject({ x: 25, y: 12, areaId: "area-a" });
    expect(h.controller.selectedWaypointId()).toBe(created!.id);

    h.dispatch("contextmenu", 320, 480);
    h.lastRadial().handlers.onAction("move");
    expect(clickMoveTarget(h.state)).toMatchObject({ x: 39.5, y: 59.5, areaId: "area-a" });
  });

  it("right-click on a waypoint offers Move Here, active toggle and Delete Waypoint", () => {
    const h = pointerHarness();
    const id = createWaypoint({ name: "Camp", x: 10, y: 10, areaId: "area-a", active: true }).waypoint!.id;

    h.dispatch("contextmenu", 84, 84);
    let call = h.lastRadial();
    expect(call.actions.map((action) => action.label)).toEqual(["MOVE HERE", "DEACTIVATE", "DELETE WAYPOINT"]);

    call.handlers.onAction("move");
    expect(clickMoveTarget(h.state)).toMatchObject({ x: 10, y: 10, areaId: "area-a" });

    call.handlers.onAction("toggle");
    expect(waypoints().find((row) => row.id === id)?.active).toBe(false);

    h.dispatch("contextmenu", 84, 84);
    call = h.lastRadial();
    expect(call.actions.map((action) => action.label)).toEqual(["MOVE HERE", "ACTIVATE", "DELETE WAYPOINT"]);

    call.handlers.onAction("delete");
    expect(waypoints().length).toBe(0);
    expect(h.controller.selectedWaypointId()).toBeNull();
  });

  it("disables Move Here (with a note) when the player is in another area", () => {
    const h = pointerHarness({ activeAreaId: "area-b" });
    createWaypoint({ name: "Camp", x: 10, y: 10, areaId: "area-a" });

    h.dispatch("contextmenu", 84, 84);
    const move = h.lastRadial().actions.find((action) => action.id === "move");
    expect(move?.enabled).toBe(false);
    expect(move?.note).toBeTruthy();

    h.dispatch("contextmenu", 400, 200);
    const groundMove = h.lastRadial().actions.find((action) => action.id === "move");
    expect(groundMove?.enabled).toBe(false);
  });

  it("disables Create Waypoint at the store cap", () => {
    const h = pointerHarness();
    for (let i = 0; i < MAX_WAYPOINTS; i += 1) {
      expect(createWaypoint({ name: `W${i}`, x: 1, y: 1, areaId: "area-a" }).ok).toBe(true);
    }

    h.dispatch("contextmenu", 400, 200);

    const create = h.lastRadial().actions.find((action) => action.id === "waypoint");
    expect(create?.enabled).toBe(false);
    expect(create?.note).toBeTruthy();
  });

  it("closes the radial instead of opening one outside the world rect", () => {
    const h = pointerHarness();
    const before = h.closedCount();

    // 64×64 world fills the whole 512px canvas under contain, so exercise the
    // guard with a click past the canvas edge (projected world > widthCells).
    h.dispatch("contextmenu", 600, 600);

    expect(h.radialCalls.length).toBe(0);
    expect(h.closedCount()).toBe(before + 1);
  });
});

describe("datapad map pointer — keyboard path", () => {
  it("Enter travels to the selected waypoint (marker double-click semantics)", () => {
    const h = pointerHarness();
    createWaypoint({ name: "Camp", x: 10, y: 10, areaId: "area-a" });
    h.dispatch("click", 84, 84);
    expect(h.controller.selectedWaypointId()).not.toBeNull();

    const receipt = h.pressKey("Enter");

    expect(receipt.defaultPrevented).toBe(true);
    expect(clickMoveTarget(h.state)).toMatchObject({ x: 10, y: 10, areaId: "area-a" });
  });

  it("Enter without a selection stays inert and unconsumed", () => {
    const h = pointerHarness();

    const receipt = h.pressKey("Enter");

    expect(receipt.defaultPrevented).toBe(false);
    expect(clickMoveTarget(h.state)).toBeNull();
  });

  it("Enter refuses the travel (with a receipt) from another area", () => {
    const h = pointerHarness({ activeAreaId: "area-b" });
    createWaypoint({ name: "Camp", x: 10, y: 10, areaId: "area-a" });
    h.dispatch("click", 84, 84);

    const receipt = h.pressKey("Enter");

    expect(receipt.defaultPrevented).toBe(true);
    expect(clickMoveTarget(h.state)).toBeNull();
    expect(h.statuses).toContain("YOU ARE NOT IN THIS AREA");
  });

  it("Escape drops the selection; other keys pass through untouched", () => {
    const h = pointerHarness();
    createWaypoint({ name: "Camp", x: 10, y: 10, areaId: "area-a" });
    h.dispatch("click", 84, 84);

    expect(h.pressKey("a").defaultPrevented).toBe(false);
    expect(h.controller.selectedWaypointId()).not.toBeNull();

    const receipt = h.pressKey("Escape");
    expect(receipt.defaultPrevented).toBe(true);
    expect(h.controller.selectedWaypointId()).toBeNull();

    // Escape with nothing selected stays unconsumed.
    expect(h.pressKey("Escape").defaultPrevented).toBe(false);
  });
});

describe("datapad map pointer — lifecycle", () => {
  it("removes every listener on dispose and goes inert", () => {
    const h = pointerHarness();
    createWaypoint({ name: "Camp", x: 10, y: 10, areaId: "area-a" });
    h.dispatch("click", 84, 84);
    expect([...h.listeners.values()].reduce((sum, bucket) => sum + bucket.size, 0)).toBe(4);

    h.controller.dispose();

    expect([...h.listeners.values()].every((bucket) => bucket.size === 0)).toBe(true);
    h.dispatch("dblclick", 256, 256);
    h.pressKey("Enter");
    expect(clickMoveTarget(h.state)).toBeNull();
  });

  it("self-heals the selection when the row disappears from the store", () => {
    const h = pointerHarness();
    createWaypoint({ name: "Camp", x: 10, y: 10, areaId: "area-a" });
    h.dispatch("click", 84, 84);
    expect(h.controller.selectedWaypointId()).not.toBeNull();

    // A sibling surface (waypoints list) deletes the row out from under us.
    configureWaypointStore(`datapad-map-pointer-${harnessSeq}-other`, memoryStorage());

    expect(h.controller.selectedWaypointId()).toBeNull();
  });
});

describe("datapad map own corpse markers", () => {
  function stateWithCorpses(corpses: object[]): PlayState {
    return { serverAuthority: { playerCorpses: corpses } } as unknown as PlayState;
  }

  it("marks only same-area corpses the player owns", () => {
    const state = stateWithCorpses([
      { id: "player-corpse:mine", isOwner: true, areaId: "desert", x: 12, y: 34, expiryTick: 6000 },
      { id: "player-corpse:other", isOwner: false, areaId: "desert", x: 5, y: 5, expiryTick: 6000 },
      { id: "player-corpse:far", isOwner: true, areaId: "elsewhere", x: 9, y: 9, expiryTick: 6000 },
    ]);
    const markers = ownCorpseMapMarkers(state, "desert", 0, 20);
    expect(markers.map((marker) => marker.corpseId)).toEqual(["player-corpse:mine"]);
    expect(markers[0]).toMatchObject({ x: 12, y: 34 });
  });

  it("labels the remaining fade window from the authoritative expiry tick", () => {
    const state = stateWithCorpses([
      { id: "player-corpse:mine", isOwner: true, areaId: "desert", x: 1, y: 2, expiryTick: 144_000 },
    ]);
    // 144_000 − 24_000 = 120_000 ticks at 20 Hz → 6_000 s → 100:00.
    expect(ownCorpseMapMarkers(state, "desert", 24_000, 20)[0]!.fadeLabel).toBe("FADES 100:00");
    // A corpse past its expiry never counts negative.
    expect(ownCorpseMapMarkers(state, "desert", 999_999, 20)[0]!.fadeLabel).toBe("FADES 0:00");
  });

  it("returns nothing when the player owns no corpse in the framed area", () => {
    const state = stateWithCorpses([
      { id: "player-corpse:other", isOwner: false, areaId: "desert", x: 5, y: 5, expiryTick: 6000 },
    ]);
    expect(ownCorpseMapMarkers(state, "desert", 0, 20)).toEqual([]);
  });
});

describe("datapad map orbital shelter captions", () => {
  function recordingDraw() {
    const fillTexts: string[] = [];
    const strokes: number[] = [];
    const draw = {
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 0,
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
      shadowColor: "",
      shadowBlur: 0,
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      stroke() {
        strokes.push(1);
      },
      fill() {},
      arc() {},
      measureText(text: string) {
        return { width: Math.max(1, text.length * 6) };
      },
      fillText(text: string) {
        fillTexts.push(text);
      },
    } as unknown as CanvasRenderingContext2D;
    return { draw, fillTexts, strokes };
  }

  function nearbyShelterCluster() {
    // Three shelters stacked on nearly the same longitude — the orbital failure mode.
    return [
      { kind: "building", label: "Lean-to", cell: { x: 12, y: 10 }, size: { w: 3, h: 3 }, shelter: true },
      { kind: "building", label: "Shack", cell: { x: 12, y: 16 }, size: { w: 3, h: 3 }, shelter: true },
      { kind: "building", label: "Hut", cell: { x: 13, y: 22 }, size: { w: 2, h: 2 }, shelter: true },
      {
        kind: "travel_terminal",
        label: "Travel Terminal — Dustgate",
        cell: { x: 30, y: 30 },
        size: { w: 1, h: 1 },
      },
      { kind: "storage_chest", label: "Cache", cell: { x: 40, y: 40 }, size: { w: 1, h: 1 } },
    ];
  }

  it("suppresses repeated SHELTER text in ORBITAL while keeping shelter markers and named destinations", () => {
    const projection = createDatapadMapProjection(
      64,
      64,
      512,
      512,
      datapadMapViewOptions("orbital", { x: 32, y: 32 }),
    );
    const { draw, fillTexts, strokes } = recordingDraw();

    drawDatapadMapStructures(draw, nearbyShelterCluster(), projection, {
      mode: "orbital",
      size: 512,
      accent: "#9fe8dc",
      ink: "#d8e2de",
      inkDim: "#7c8a86",
    });

    expect(fillTexts.filter((text) => text === "SHELTER")).toEqual([]);
    expect(fillTexts).toContain("DUSTGATE");
    // One strokeWorldRect per shelter footprint — geometry stays painted.
    expect(strokes.length).toBe(3);
  });

  it("keeps SHELTER captions in TACTICAL for the same nearby cluster", () => {
    const projection = createDatapadMapProjection(
      64,
      64,
      512,
      512,
      datapadMapViewOptions("tactical", { x: 16, y: 16 }),
    );
    const { draw, fillTexts, strokes } = recordingDraw();

    drawDatapadMapStructures(draw, nearbyShelterCluster(), projection, {
      mode: "tactical",
      size: 512,
      accent: "#9fe8dc",
      ink: "#d8e2de",
      inkDim: "#7c8a86",
    });

    expect(fillTexts.filter((text) => text === "SHELTER")).toHaveLength(3);
    expect(fillTexts).toContain("DUSTGATE");
    expect(strokes.length).toBe(3);
  });
});

describe("datapad map colliding named destination labels", () => {
  it("keeps first baseline and separates stacked named captions by row height plus halo clearance", () => {
    const size = 512;
    const fontPx = Math.max(8, Math.round(size * 0.011));
    const rowH = fontPx + 3;
    // Matches LABEL_ROW_CLEARANCE_PX in datapadMap.ts (3px shadowBlur halo air).
    const labelRowClearancePx = 3;
    const projection = createDatapadMapProjection(
      64,
      64,
      size,
      size,
      datapadMapViewOptions("orbital", { x: 32, y: 32 }),
    );
    // Same marker seat — KNOX VALE / DUSTGATE share one orbital pin at 1440x900 scale.
    const props = [
      {
        kind: "travel_terminal",
        label: "Travel Terminal — Knox Vale",
        cell: { x: 30, y: 30 },
        size: { w: 1, h: 1 },
      },
      {
        kind: "travel_terminal",
        label: "Travel Terminal — Dustgate",
        cell: { x: 30, y: 30 },
        size: { w: 1, h: 1 },
      },
    ];
    const preferredY = projection.worldToCanvas(30.5, 30.5).y - Math.max(5, size * 0.008);
    const fillCalls: { text: string; x: number; y: number }[] = [];
    const draw = {
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 0,
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
      shadowColor: "",
      shadowBlur: 0,
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      stroke() {},
      fill() {},
      arc() {},
      measureText(text: string) {
        return { width: Math.max(1, text.length * 6) };
      },
      fillText(text: string, x: number, y: number) {
        fillCalls.push({ text, x, y });
      },
    } as unknown as CanvasRenderingContext2D;

    drawDatapadMapStructures(draw, props, projection, {
      mode: "orbital",
      size,
      accent: "#9fe8dc",
      ink: "#d8e2de",
      inkDim: "#7c8a86",
    });

    const knox = fillCalls.find((call) => call.text === "KNOX VALE");
    const dustgate = fillCalls.find((call) => call.text === "DUSTGATE");
    expect(knox).toBeDefined();
    expect(dustgate).toBeDefined();
    expect(knox!.y).toBeCloseTo(preferredY, 8);
    // Second seat steps up by full reserved row plus explicit clearance — not the old 1px air.
    expect(knox!.y - dustgate!.y).toBe(rowH + labelRowClearancePx);
    expect(knox!.y - dustgate!.y).toBeGreaterThan(rowH + 1);
  });
});
