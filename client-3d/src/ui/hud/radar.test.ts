// @vitest-environment happy-dom
import { createPlayState, type PlayState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { clickMoveTarget } from "@successor/client/src/slice-core/movementSystem";
import { describe, expect, it } from "vitest";
import { explicitLockTargetId, setExplicitLockTarget } from "../../combat/softLock";
import {
  CLICK_GRAB_PX,
  classifyRadarContact,
  classifyRadarWaypoint,
  mountRadar,
  radarClickAction,
  radarPointInScope,
  RADIUS_CELLS,
  SCOPE_RIM_PX,
  worldGridRef,
} from "./radar";

describe("radar north-up contract", () => {
  it.each([
    ["north", 0, -1, 0, -1],
    ["south", 0, 1, 0, 1],
    ["east", 1, 0, 1, 0],
    ["west", -1, 0, -1, 0],
  ] as const)("plots raw %s at the matching screen cardinal", (_name, dx, dy, sx, sy) => {
    const contact = classifyRadarContact(dx, dy, "hostile");
    const waypoint = classifyRadarWaypoint(dx, dy);

    expect(contact).toMatchObject({ xCells: sx, yCells: sy, rimClamped: false });
    expect(waypoint).toMatchObject({ xCells: sx, yCells: sy, rimClamped: false });
  });

  it("keeps an in-range east contact directly right", () => {
    const contact = classifyRadarContact(RADIUS_CELLS, 0, "hostile");

    expect(contact).not.toBeNull();
    expect(contact?.clazz).toBe("hostile");
    expect(contact?.rimClamped).toBe(false);
    expect(contact?.xCells).toBe(RADIUS_CELLS);
    expect(contact?.yCells).toBe(0);
    expect(contact?.dCells).toBe(RADIUS_CELLS);
  });

  it("uses the same raw north-up basis for grid references", () => {
    expect(worldGridRef(512, 512, 1024, 1024)).toBe("E 0 · N 0");
    expect(worldGridRef(515, 515, 1024, 1024)).toBe("E 3 · N -3");
    expect(worldGridRef(512, 511, 1024, 1024)).toBe("E 0 · N 1");
    expect(worldGridRef(516, 512, 1024, 1024)).toBe("E 4 · N 0");
    expect(worldGridRef(90, 86, 176, 176)).toBe("E 2 · N 2");
  });

  it("rim-clamps hostile and yellow contacts without changing bearing", () => {
    const hostile = classifyRadarContact(RADIUS_CELLS * 2, 0, "hostile");
    const alerted = classifyRadarContact(RADIUS_CELLS, RADIUS_CELLS, "alerted");

    expect(hostile).toMatchObject({
      clazz: "hostile",
      rimClamped: true,
      xCells: RADIUS_CELLS,
      yCells: 0,
      dCells: RADIUS_CELLS * 2,
    });
    expect(alerted?.clazz).toBe("passive");
    expect(alerted?.rimClamped).toBe(true);
    expect(alerted?.dCells).toBeCloseTo(RADIUS_CELLS * Math.SQRT2, 5);
    expect(alerted?.xCells).toBeCloseTo(RADIUS_CELLS * Math.SQRT1_2, 5);
    expect(alerted?.yCells).toBeCloseTo(RADIUS_CELLS * Math.SQRT1_2, 5);
  });

  it("pins an out-of-range east waypoint to the right rim", () => {
    const waypoint = classifyRadarWaypoint(RADIUS_CELLS * 2, 0);

    expect(waypoint.rimClamped).toBe(true);
    expect(waypoint.dCells).toBe(RADIUS_CELLS * 2);
    expect(waypoint.xCells).toBe(RADIUS_CELLS);
    expect(waypoint.yCells).toBe(0);
    expect(Math.hypot(waypoint.xCells, waypoint.yCells)).toBeCloseTo(RADIUS_CELLS, 4);
  });

  it("drops out-of-range civilians but keeps in-range civilians dim", () => {
    expect(classifyRadarContact(RADIUS_CELLS + 1, 0, null)).toBeNull();

    const civilian = classifyRadarContact(6, 8, undefined);
    expect(civilian).toMatchObject({
      clazz: "civilian",
      rimClamped: false,
      xCells: 6,
      yCells: 8,
      dCells: 10,
    });
  });
});

describe("radar click grammar (pure)", () => {
  const center = 50;
  const scale = 1;

  it("selects the actor dot under the click (dot beats ground)", () => {
    const contacts = [{ id: "npc-a", xCells: 10, yCells: -5 }];

    const action = radarClickAction(contacts, 61, 44, center, scale);

    expect(action).toEqual({ kind: "select", actorId: "npc-a" });
  });

  it("prefers the nearest dot when several sit inside the grab radius", () => {
    const contacts = [
      { id: "far", xCells: 8, yCells: 0 },
      { id: "near", xCells: 12, yCells: 0 },
    ];

    const action = radarClickAction(contacts, 61, 50, center, scale);

    expect(action).toEqual({ kind: "select", actorId: "near" });
  });

  it("inverts an open-scope click through the north-up basis to a world offset", () => {
    const action = radarClickAction([{ id: "npc-a", xCells: 10, yCells: -5 }], 80, 20, center, scale);

    expect(action).toEqual({ kind: "move", dxCells: 30, dyCells: -30 });
  });

  it("recovers fractional cell offsets under a real pixel scale", () => {
    const realScale = 71 / 96;
    const action = radarClickAction([], 78 + 12.5 * realScale, 78 - 33.25 * realScale, 78, realScale);

    expect(action?.kind).toBe("move");
    if (action?.kind !== "move") return;
    expect(action.dxCells).toBeCloseTo(12.5, 6);
    expect(action.dyCells).toBeCloseTo(-33.25, 6);
  });

  it("ignores clicks beyond the scope rim", () => {
    expect(radarClickAction([], center + RADIUS_CELLS + 1, center, center, scale)).toBeNull();
  });

  it("keeps the dot grab radius modest so ground stays reachable near dots", () => {
    expect(CLICK_GRAB_PX).toBeLessThanOrEqual(14);
    const justOutside = radarClickAction([{ id: "npc-a", xCells: 0, yCells: 0 }], center + CLICK_GRAB_PX + 1, center, center, scale);
    expect(justOutside).toEqual({ kind: "move", dxCells: CLICK_GRAB_PX + 1, dyCells: 0 });
  });
});

describe("radar scope circle (pure)", () => {
  it("keeps the visible circle inside the square canvas", () => {
    expect(SCOPE_RIM_PX).toBeLessThan(78);
  });

  it("accepts the center and the rim, rejects just past the rim", () => {
    expect(radarPointInScope(78, 78)).toBe(true);
    expect(radarPointInScope(78 + SCOPE_RIM_PX, 78)).toBe(true);
    expect(radarPointInScope(78 + SCOPE_RIM_PX + 0.5, 78)).toBe(false);
  });

  it("rejects all four transparent square corners", () => {
    for (const [x, y] of [[2, 2], [154, 2], [2, 154], [154, 154]] as const) {
      expect(radarPointInScope(x, y)).toBe(false);
    }
  });
});

// ── Mounted wiring (happy-dom): clicks reach selection + click-move ─────────

function radarSlice(): SliceSnapshot {
  return {
    schema: "test",
    tick: 1,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Test", width: 64, height: 64, level: 0 },
    areas: [{ id: "area-a", name: "Area A", kind: "overworld", width: 64, height: 64, level: 0 }],
    stateHash: "hash",
    camera: { followActor: "player", zoom: 1 },
    actors: [
      {
        id: "player",
        entity: "1:1",
        areaId: "area-a",
        label: "Player",
        role: "player",
        sprite: "s",
        poseSet: "idle",
        direction: "front",
        cell: { x: 32, y: 32 },
        route: [],
      },
    ],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  } as unknown as SliceSnapshot;
}

function authorityActor(
  id: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): PlayState["serverAuthority"]["actors"][string] {
  return {
    id,
    label: id,
    areaId: "area-a",
    x,
    y,
    direction: "front",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    ...extra,
  } as unknown as PlayState["serverAuthority"]["actors"][string];
}

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

/** Screen px of a cell offset on the mounted scope (156px face, 96c radius). */
function scopePx(cells: number): number {
  return 78 + cells * (71 / 96);
}

function clickScope(shell: HTMLElement, clientX: number, clientY: number): void {
  const scope = shell.querySelector<HTMLCanvasElement>(".sc3d-radar-scope");
  if (!scope) throw new Error("scope canvas missing");
  scope.dispatchEvent(new MouseEvent("click", { clientX, clientY, bubbles: true }));
}

describe("radar mounted pointer input", () => {
  it("left-click on a contact dot selects that actor; hostile dots soft-lock", async () => {
    const slice = radarSlice();
    const state = createPlayState(slice, "player");
    state.serverAuthority.actors.player = authorityActor("player", 32.5, 32.5, { factionId: "settlers" });
    state.serverAuthority.actors.civ = authorityActor("civ", 52.5, 32.5);
    state.serverAuthority.actors.raider = authorityActor("raider", 32.5, 12.5, { factionId: "raiders", aiAttitude: "hostile" });
    const shell = document.createElement("div");
    document.body.appendChild(shell);
    const radar = mountRadar(shell, state, slice);
    await frames(2);

    clickScope(shell, scopePx(20), scopePx(0));
    expect(state.selectedActorId).toBe("civ");
    expect(state.softLockActorId).toBeNull();

    clickScope(shell, scopePx(0), scopePx(-20));
    expect(state.selectedActorId).toBe("raider");
    expect(state.softLockActorId).toBe("raider");

    radar.dispose();
    shell.remove();
  });

  it("left-click on open scope sets the full click-move target; dispose detaches", async () => {
    const slice = radarSlice();
    const state = createPlayState(slice, "player");
    state.serverAuthority.actors.player = authorityActor("player", 32.5, 32.5);
    const shell = document.createElement("div");
    document.body.appendChild(shell);
    const radar = mountRadar(shell, state, slice);
    await frames(2);

    const scope = shell.querySelector<HTMLCanvasElement>(".sc3d-radar-scope");
    if (!scope) throw new Error("scope canvas missing");
    clickScope(shell, scopePx(-30), scopePx(20));
    const target = clickMoveTarget(state);
    expect(target?.areaId).toBe("area-a");
    expect(target?.x).toBeCloseTo(2.5, 5);
    expect(target?.y).toBeCloseTo(52.5, 5);

    // Beyond the rim: no retarget.
    clickScope(shell, 1, 1);
    expect(clickMoveTarget(state)?.x).toBeCloseTo(2.5, 5);

    radar.dispose();
    expect(window.__successor3dRadar).toBeUndefined();
    // The click listener is detached with the pane: a stray click on the
    // orphaned canvas can no longer retarget movement.
    scope.dispatchEvent(new MouseEvent("click", { clientX: scopePx(10), clientY: scopePx(10), bubbles: true }));
    expect(clickMoveTarget(state)?.x).toBeCloseTo(2.5, 5);
    shell.remove();
  });

  it("ignores pointer geometry outside the visible circle — corners and rim-adjacent dots pass through", async () => {
    const slice = radarSlice();
    const state = createPlayState(slice, "player");
    state.serverAuthority.actors.player = authorityActor("player", 32.5, 32.5);
    // Far-east contact rim-clamps to (149, 78): its 11px grab ring pokes past
    // the 76.5px scope circle. Clicks in that sliver belong to the world.
    state.serverAuthority.actors.far = authorityActor("far", 32.5 + 200, 32.5, { factionId: "raiders", aiAttitude: "hostile" });
    const shell = document.createElement("div");
    document.body.appendChild(shell);
    const radar = mountRadar(shell, state, slice);
    await frames(2);

    // All four transparent square corners: no selection, no move.
    for (const [x, y] of [[2, 2], [154, 2], [2, 154], [154, 154]] as const) {
      clickScope(shell, x, y);
    }
    expect(state.selectedActorId).toBeNull();
    expect(clickMoveTarget(state)).toBeNull();

    // Inside the dot's grab radius but outside the circle: still pass-through.
    clickScope(shell, 155.9, 78);
    expect(state.selectedActorId).toBeNull();

    // Same grab distance from the dot on the inside of the circle: selects.
    clickScope(shell, 143, 78);
    expect(state.selectedActorId).toBe("far");

    radar.dispose();
    shell.remove();
  });

  it("consumes contextmenu only inside the circle; dispose detaches it", async () => {
    const slice = radarSlice();
    const state = createPlayState(slice, "player");
    state.serverAuthority.actors.player = authorityActor("player", 32.5, 32.5);
    const shell = document.createElement("div");
    document.body.appendChild(shell);
    const radar = mountRadar(shell, state, slice);
    await frames(2);
    const scope = shell.querySelector<HTMLCanvasElement>(".sc3d-radar-scope");
    if (!scope) throw new Error("scope canvas missing");
    const menuAt = (clientX: number, clientY: number): boolean => {
      const event = new MouseEvent("contextmenu", { clientX, clientY, bubbles: true, cancelable: true });
      scope.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(menuAt(78, 78)).toBe(true);
    expect(menuAt(2, 2)).toBe(false);

    radar.dispose();
    expect(menuAt(78, 78)).toBe(false);
    shell.remove();
  });

  it("gates open-scope travel on death.phase === alive, like a world ground click", async () => {
    const slice = radarSlice();
    const state = createPlayState(slice, "player");
    state.serverAuthority.actors.player = authorityActor("player", 32.5, 32.5);
    state.serverAuthority.actors.civ = authorityActor("civ", 52.5, 32.5);
    const shell = document.createElement("div");
    document.body.appendChild(shell);
    const radar = mountRadar(shell, state, slice);
    await frames(2);

    for (const phase of ["downed", "clone_pending"] as const) {
      state.death.phase = phase;
      clickScope(shell, scopePx(-30), scopePx(20));
      expect(clickMoveTarget(state)).toBeNull();
    }
    // Dot selection stays available while downed (matches world actor clicks).
    state.death.phase = "downed";
    clickScope(shell, scopePx(20), scopePx(0));
    expect(state.selectedActorId).toBe("civ");

    state.death.phase = "alive";
    clickScope(shell, scopePx(-30), scopePx(20));
    expect(clickMoveTarget(state)?.x).toBeCloseTo(2.5, 5);

    radar.dispose();
    shell.remove();
  });

  it("open-scope travel drops target, locks and examine focus first", async () => {
    const slice = radarSlice();
    const state = createPlayState(slice, "player");
    state.serverAuthority.actors.player = authorityActor("player", 32.5, 32.5);
    const shell = document.createElement("div");
    document.body.appendChild(shell);
    const radar = mountRadar(shell, state, slice);
    await frames(2);
    state.selectedActorId = "civ";
    state.softLockActorId = "raider";
    state.examineActorId = "civ";
    setExplicitLockTarget("raider");

    clickScope(shell, scopePx(-30), scopePx(20));

    expect(clickMoveTarget(state)?.x).toBeCloseTo(2.5, 5);
    expect(state.selectedActorId).toBeNull();
    expect(state.softLockActorId).toBeNull();
    expect(state.examineActorId).toBeNull();
    expect(explicitLockTargetId()).toBeNull();

    radar.dispose();
    shell.remove();
  });
});
