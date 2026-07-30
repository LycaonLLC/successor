import { describe, expect, it } from "vitest";
import {
  ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
  actorSprintRecoveryLocked,
  advanceClickRouteFromAuthority,
  cancelClickMove,
  clampMoveAgainstPropBounds,
  clampToMovementBounds,
  CLICK_MOVE_ARRIVAL_RADIUS_CELLS,
  CLICK_ROUTE_MAX_EXPANSIONS,
  CLICK_ROUTE_MAX_REPLANS,
  CLICK_ROUTE_NEIGHBOR_ORDER,
  clickMoveOctantVector,
  clickMoveStalled,
  clickMoveTarget,
  clickRouteCellWalkable,
  clickRouteDiagonalClear,
  clickRouteIndex,
  clickRouteNeedsBlockerReplan,
  clickRouteReplanCount,
  clickRouteWaypoints,
  completeClickMove,
  drainClickMoveEvents,
  earliestMovementKey,
  facingFromMovementKeys,
  installClickRoute,
  isBlockedAt,
  latestMovementKey,
  moveIfUnblocked,
  movementObstacleRevision,
  movementSprintIntent,
  movementVectorFromKeys,
  planClickRoute,
  PLAYER_COLLISION_RADIUS_CELLS,
  resolveCircleMove,
  rotationLocked,
  setClickMoveTarget,
  setSprintToggleEnabled,
  sprintToggleEnabled,
  toggleSprint,
  type ClickMoveEvent,
  type MovementBlocker,
} from "./movementSystem";

const radius = PLAYER_COLLISION_RADIUS_CELLS;
const thinVerticalWall: MovementBlocker = { left: 5, top: 0, right: 5.295, bottom: 10 };

function resolve(origin: { x: number; y: number }, delta: { x: number; y: number }, blockers: readonly MovementBlocker[] = [thinVerticalWall]) {
  return resolveCircleMove(origin, delta, radius, blockers, { x: 0, y: 0 });
}

function circleOverlapsBlocker(center: { x: number; y: number }, blocker: MovementBlocker): boolean {
  if (center.x >= blocker.left && center.x <= blocker.right && center.y >= blocker.top && center.y <= blocker.bottom) {
    return true;
  }
  const closestX = Math.max(blocker.left, Math.min(blocker.right, center.x));
  const closestY = Math.max(blocker.top, Math.min(blocker.bottom, center.y));
  return Math.hypot(center.x - closestX, center.y - closestY) < radius - 0.0001;
}

function expectClear(center: { x: number; y: number }, blockers: readonly MovementBlocker[]): void {
  expect(blockers.some((blocker) => circleOverlapsBlocker(center, blocker))).toBe(false);
}


describe("movementSystem", () => {
  it("combines held movement keys into normalized eight-way movement", () => {
    const keys = new Set(["KeyD", "KeyS"]);
    const vector = movementVectorFromKeys(keys);

    expect(earliestMovementKey(keys)).toBe("KeyD");
    expect(latestMovementKey(keys)).toBe("KeyS");
    expect(vector.x).toBeCloseTo(Math.SQRT1_2);
    expect(vector.y).toBeCloseTo(Math.SQRT1_2);
    expect(facingFromMovementKeys(keys, "right")).toBe("front_right");
  });

  it("lets the latest opposing key win on each axis", () => {
    expect(movementVectorFromKeys(["KeyD", "KeyA"])).toEqual({ x: -1, y: 0 });
    expect(movementVectorFromKeys(["KeyW", "KeyD", "KeyS"])).toEqual({ x: Math.SQRT1_2, y: Math.SQRT1_2 });
  });

  it("maps physical WASD to immutable world cardinals", () => {
    const expectedWorldVectors = {
      KeyW: { vector: { x: 0, y: -1 }, facing: "back" },
      KeyA: { vector: { x: -1, y: 0 }, facing: "left" },
      KeyS: { vector: { x: 0, y: 1 }, facing: "front" },
      KeyD: { vector: { x: 1, y: 0 }, facing: "right" },
    } as const;
    for (const [key, expected] of Object.entries(expectedWorldVectors)) {
      expect(movementVectorFromKeys([key]), `${key} world vector`).toEqual(expected.vector);
      expect(facingFromMovementKeys([key], "front"), `${key} facing`).toBe(expected.facing);
    }
  });

  it("ignores non-movement keys and preserves fallback facing", () => {
    const keys = new Set(["Space", "KeyI"]);

    expect(earliestMovementKey(keys)).toBeNull();
    expect(latestMovementKey(keys)).toBeNull();
    expect(movementVectorFromKeys(keys)).toEqual({ x: 0, y: 0 });
    expect(facingFromMovementKeys(keys, "left")).toBe("left");
  });

  it("detects right mouse as the held rotation lock", () => {
    expect(rotationLocked(new Set(["MouseRight", "KeyS"]))).toBe(true);
    expect(rotationLocked(new Set(["ControlLeft", "KeyS"]))).toBe(false);
    expect(rotationLocked(new Set(["ShiftLeft", "KeyS"]))).toBe(false);
    expect(rotationLocked(new Set(["KeyS"]))).toBe(false);
  });

  it("clamps movement into playable area bounds", () => {
    expect(clampToMovementBounds({ width: 20, height: 12 }, { x: -2, y: 40 })).toEqual({ x: 1, y: 10 });
  });

  it("preserves legacy blocked-cell diagonal slide semantics", () => {
    const cases = [
      { blocked: "5,5", next: { x: 5.2, y: 5.2 }, expected: { x: 5.2, y: 4 } },
      { blocked: "5,2", next: { x: 5.2, y: 2.8 }, expected: { x: 5.2, y: 4 } },
      { blocked: "2,5", next: { x: 2.8, y: 5.2 }, expected: { x: 2.8, y: 4 } },
      { blocked: "2,2", next: { x: 2.8, y: 2.8 }, expected: { x: 2.8, y: 4 } },
    ];

    for (const testCase of cases) {
      const blocked = new Set([testCase.blocked]);

      expect(isBlockedAt(blocked, testCase.next)).toBe(true);
      expect(moveIfUnblocked({ x: 4, y: 4 }, { width: 20, height: 12 }, blocked, testCase.next)).toEqual(testCase.expected);
    }
    expect(moveIfUnblocked({ x: 4, y: 4 }, { width: 20, height: 12 }, new Set(["5,5"]), { x: 6.2, y: 5.2 })).toEqual({ x: 6.2, y: 4 });
  });

  it("stops before the first blocked cell sample when no open legacy slide axis exists", () => {
    const blocked = new Set(["5,7", "5,4", "4,7"]);

    expect(moveIfUnblocked({ x: 4, y: 7.1 }, { width: 20, height: 12 }, blocked, { x: 5.8, y: 7.1 })).toEqual({ x: 4, y: 7.1 });
    const stopped = moveIfUnblocked({ x: 4, y: 4 }, { width: 20, height: 12 }, blocked, { x: 5.8, y: 7.1 });
    expect(isBlockedAt(blocked, stopped)).toBe(false);
    expect(stopped.x).toBeGreaterThan(4);
    expect(stopped.y).toBeGreaterThan(4);
    expect(stopped.y).toBeLessThan(7);
  });

  it("sweeps head-on movement to one radius plus skin from the wall face without crossing", () => {
    const result = resolve({ x: 2, y: 5 }, { x: 10, y: 0 });

    expect(result.x).toBeGreaterThanOrEqual(thinVerticalWall.left - radius - 0.0021);
    expect(result.x).toBeLessThanOrEqual(thinVerticalWall.left - radius - 0.0019);
    expect(result.y).toBeCloseTo(5);
    expectClear(result, [thinVerticalWall]);
  });

  it("does not stick when starting flush with a wall face and moving tangent or away", () => {
    const flush = { x: thinVerticalWall.left - radius, y: 2 };

    const tangent = resolve(flush, { x: 0, y: 2 });
    expect(tangent.x).toBeCloseTo(flush.x);
    expect(tangent.y).toBeCloseTo(4);
    expectClear(tangent, [thinVerticalWall]);

    const away = resolve(flush, { x: -1, y: 0 });
    expect(away.x).toBeCloseTo(flush.x - 1);
    expect(away.y).toBeCloseTo(flush.y);
    expectClear(away, [thinVerticalWall]);
  });

  it("slides diagonal movement along a wall by cancelling only the normal component", () => {
    const result = resolve({ x: 4.6, y: 2 }, { x: 1, y: 1 });

    expect(result.x).toBeGreaterThanOrEqual(thinVerticalWall.left - radius - 0.0015);
    expect(result.x).toBeLessThanOrEqual(thinVerticalWall.left - radius - 0.0013);
    expect(result.y).toBeCloseTo(3, 3);
    expectClear(result, [thinVerticalWall]);
  });

  it("handles a grazing rounded-corner trace without entering the box", () => {
    const box: MovementBlocker = { left: 5, top: 5, right: 6, bottom: 6 };
    const result = resolve({ x: 4, y: 4 }, { x: 2, y: 2 }, [box]);

    expect(result.x).toBeCloseTo(4.786, 3);
    expect(result.y).toBeCloseTo(4.786, 3);
    expectClear(result, [box]);
  });

  it("keeps a corner sprint outside every box while tracing around the outside corner", () => {
    const blockers: MovementBlocker[] = [
      { left: 5, top: 5, right: 5.295, bottom: 7 },
      { left: 5, top: 5, right: 7, bottom: 5.295 },
    ];
    const distance = 1.7 * Math.SQRT1_2;
    const steps = Math.ceil(Math.hypot(distance, -distance) / (radius * 0.5));
    let position = { x: 4.25, y: 6.35 };
    for (let step = 0; step < steps; step += 1) {
      position = resolve(position, { x: distance / steps, y: -distance / steps }, blockers);
      expectClear(position, blockers);
    }

    expect(position.x).toBeGreaterThan(4.69);
    expect(position.y).toBeLessThan(5.3);
    expectClear(position, blockers);
  });

  it("self-heals an origin inside a box to the nearest face plus radius, then moves normally", () => {
    const origin = { x: 5.15, y: 6 };
    const healed = resolve(origin, { x: 0, y: 0 });

    expect(healed.x).toBeCloseTo(thinVerticalWall.right + radius, 3);
    expect(healed.y).toBeCloseTo(6);
    expectClear(healed, [thinVerticalWall]);

    const moved = resolve(healed, { x: 0, y: 0.8 });
    expect(moved.x).toBeCloseTo(healed.x);
    expect(moved.y).toBeGreaterThan(healed.y + 0.79);
    expectClear(moved, [thinVerticalWall]);
  });

  it("moves out of a shallow door-sill overlap instead of trapping the pawn", () => {
    const lowerLeftDoorSill: MovementBlocker = { left: 502.658, top: 511.921, right: 502.868, bottom: 512 };
    const origin = { x: 502.94, y: 512.29 };

    expect(circleOverlapsBlocker(origin, lowerLeftDoorSill)).toBe(true);
    const moved = resolve(origin, { x: 0, y: 0.435 }, [lowerLeftDoorSill]);

    expect(moved.y).toBeGreaterThan(origin.y + 0.3);
    expectClear(moved, [lowerLeftDoorSill]);
  });

  it("glides through the shelter door-sill corner instead of treating it as a square blocker", () => {
    const blockers: MovementBlocker[] = [
      { left: 502.658, top: 511.895, right: 502.921, bottom: 511.921 },
      { left: 504.026, top: 511.895, right: 504.158, bottom: 511.921 },
    ];
    const origin = { x: 503.15, y: 512.35 };
    const result = resolve(origin, { x: 0, y: -3 }, blockers);

    expect(result.y).toBeLessThan(511);
    expect(result.x).toBeGreaterThan(origin.x);
    expectClear(result, blockers);
  });

  it("walks through a 1.116-cell door gap centered and brushes through a jamb by sliding", () => {
    const doorBlockers: MovementBlocker[] = [
      { left: 1, top: 5, right: 2.442, bottom: 5.295 },
      { left: 3.558, top: 5, right: 5, bottom: 5.295 },
    ];
    const centered = resolve({ x: 3, y: 5.9 }, { x: 0, y: -1.7 }, doorBlockers);
    expect(centered.x).toBeCloseTo(3);
    expect(centered.y).toBeLessThan(4.3);
    expectClear(centered, doorBlockers);

    const brushed = resolve({ x: 2.73, y: 5.15 }, { x: 0, y: -1 }, doorBlockers);
    expect(brushed.x).toBeGreaterThanOrEqual(2.742);
    expect(brushed.y).toBeLessThan(4.3);
    expectClear(brushed, doorBlockers);
  });

  it("cannot tunnel an anchor-centered actor through a 0.295-cell wall band", () => {
    const result = clampMoveAgainstPropBounds({ x: 2, y: 5 }, { x: 12, y: 5 }, [thinVerticalWall]);
    const resultCenter = {
      x: result.x + ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
      y: result.y + ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
    };

    expect(resultCenter.x).toBeLessThan(thinVerticalWall.left);
    expect(resultCenter.x).toBeGreaterThanOrEqual(thinVerticalWall.left - radius - 0.0021);
    expectClear(resultCenter, [thinVerticalWall]);
  });

  it("matches the Rust swept-circle parity scenario table within two milli-cells", () => {
    // Rust mirror: crates/successor-sim/src/authority/swept_circle.rs.
    const cases: Array<{
      label: string;
      origin: { x: number; y: number };
      delta: { x: number; y: number };
      blockers: MovementBlocker[];
      expected: { x: number; y: number };
    }> = [
      {
        label: "head-on stop",
        origin: { x: 2, y: 5 },
        delta: { x: 10, y: 0 },
        blockers: [thinVerticalWall],
        expected: { x: 4.698, y: 5 },
      },
      {
        label: "diagonal slide",
        origin: { x: 4.6, y: 2 },
        delta: { x: 1, y: 1 },
        blockers: [thinVerticalWall],
        expected: { x: 4.699, y: 3 },
      },
      {
        label: "corner",
        origin: { x: 4, y: 4 },
        delta: { x: 2, y: 2 },
        blockers: [{ left: 5, top: 5, right: 6, bottom: 6 }],
        expected: { x: 4.786, y: 4.786 },
      },
      {
        label: "door-gap pass",
        origin: { x: 3, y: 5.9 },
        delta: { x: 0, y: -1.7 },
        blockers: [
          { left: 1, top: 5, right: 2.442, bottom: 5.295 },
          { left: 3.558, top: 5, right: 5, bottom: 5.295 },
        ],
        expected: { x: 3, y: 4.2 },
      },
      {
        label: "origin-inside recovery",
        origin: { x: 5.15, y: 6 },
        delta: { x: 0, y: 0 },
        blockers: [thinVerticalWall],
        expected: { x: 5.596, y: 6 },
      },
    ];

    for (const testCase of cases) {
      const actual = resolve(testCase.origin, testCase.delta, testCase.blockers);
      expect(Math.abs(actual.x - testCase.expected.x), testCase.label).toBeLessThanOrEqual(0.002);
      expect(Math.abs(actual.y - testCase.expected.y), testCase.label).toBeLessThanOrEqual(0.002);
    }
  });
});

describe("click-to-move navigation intent", () => {
  function drained(state: object): ClickMoveEvent[] {
    const out: ClickMoveEvent[] = [];
    drainClickMoveEvents(state, out);
    out.length = 0;
    return out;
  }

  it("walks the set/retarget/arrived lifecycle with one marker event per transition", () => {
    const state = {};
    const events = drained(state);

    setClickMoveTarget(state, 8, 5, "area-a", 100);
    expect(clickMoveTarget(state)).toEqual({ x: 8, y: 5, areaId: "area-a" });
    setClickMoveTarget(state, 10, 6, "area-a", 200);
    completeClickMove(state);

    drainClickMoveEvents(state, events);
    expect(events.map((event) => event.kind)).toEqual(["set", "retarget", "arrived"]);
    expect(events[2]).toMatchObject({ x: 10, y: 6, areaId: "area-a" });
    expect(clickMoveTarget(state)).toBeNull();
  });

  it("cancels once and stays silent when nothing is targeted", () => {
    const state = {};
    const events = drained(state);

    setClickMoveTarget(state, 3, 3, "area-a", 0);
    cancelClickMove(state, "manual-input");
    cancelClickMove(state, "manual-input");
    completeClickMove(state);

    drainClickMoveEvents(state, events);
    expect(events.map((event) => event.kind)).toEqual(["set", "cancelled"]);
    expect(clickMoveTarget(state)).toBeNull();
  });

  it("rejects non-finite destinations", () => {
    const state = {};
    drained(state);
    setClickMoveTarget(state, Number.NaN, 5, "area-a", 0);
    expect(clickMoveTarget(state)).toBeNull();
  });

  it("steers with keyboard-grammar octants and per-axis deadzones", () => {
    const out = { x: 0, y: 0 };

    // Full diagonal — normalized to ±√½ like held WASD diagonals.
    expect(clickMoveOctantVector({ x: 10, y: 10 }, { x: 4, y: 4 }, out)).toEqual({
      x: Math.SQRT1_2,
      y: Math.SQRT1_2,
    });
    // Near-axis: the minor axis snaps off inside its deadzone.
    expect(clickMoveOctantVector({ x: 10, y: 4.1 }, { x: 4, y: 4 }, out)).toEqual({ x: 1, y: 0 });
    // Inside the arrival radius: no step.
    expect(
      clickMoveOctantVector({ x: 4 + CLICK_MOVE_ARRIVAL_RADIUS_CELLS * 0.9, y: 4 }, { x: 4, y: 4 }, out),
    ).toBeNull();
  });

  it("flags a stall only after the no-progress window and rearms on progress", () => {
    const state = {};
    drained(state);
    setClickMoveTarget(state, 20, 5, "area-a", 0);

    expect(clickMoveStalled(state, { x: 4, y: 5 }, 0)).toBe(false);
    // Blocked against a wall: same position, time passing.
    expect(clickMoveStalled(state, { x: 4, y: 5 }, 1400)).toBe(false);
    expect(clickMoveStalled(state, { x: 4, y: 5 }, 1600)).toBe(true);
    // Real progress rearms the watchdog.
    expect(clickMoveStalled(state, { x: 6, y: 5 }, 1700)).toBe(false);
    expect(clickMoveStalled(state, { x: 6, y: 5 }, 3100)).toBe(false);
    expect(clickMoveStalled(state, { x: 6, y: 5 }, 3300)).toBe(true);
  });
  it("isolates lifecycle events between concurrent game states", () => {
    const first = {};
    const second = {};
    setClickMoveTarget(first, 1, 2, "one");
    setClickMoveTarget(second, 3, 4, "two");
    cancelClickMove(first, "cleared");
    completeClickMove(second);

    const firstEvents: ClickMoveEvent[] = [];
    drainClickMoveEvents(first, firstEvents);
    expect(firstEvents.map((event) => event.kind)).toEqual(["set", "cancelled"]);
    expect(firstEvents.every((event) => event.areaId === "one")).toBe(true);

    const secondEvents: ClickMoveEvent[] = [];
    drainClickMoveEvents(second, secondEvents);
    expect(secondEvents.map((event) => event.kind)).toEqual(["set", "arrived"]);
    expect(secondEvents.every((event) => event.areaId === "two")).toBe(true);
  });
});

describe("persistent sprint toggle", () => {
  it("flips per-state and defaults off", () => {
    const state = {};
    const other = {};
    expect(sprintToggleEnabled(state)).toBe(false);
    expect(toggleSprint(state)).toBe(true);
    expect(sprintToggleEnabled(state)).toBe(true);
    expect(sprintToggleEnabled(other)).toBe(false);
    setSprintToggleEnabled(state, false);
    expect(sprintToggleEnabled(state)).toBe(false);
  });

  it("reads the authority sprint-recovery lock with a false fallback", () => {
    expect(actorSprintRecoveryLocked(null)).toBe(false);
    expect(actorSprintRecoveryLocked(undefined)).toBe(false);
    expect(actorSprintRecoveryLocked({})).toBe(false);
    expect(actorSprintRecoveryLocked({ mobility: null })).toBe(false);
    expect(actorSprintRecoveryLocked({ mobility: {} })).toBe(false);
    expect(actorSprintRecoveryLocked({ mobility: { sprintRecoveryLocked: false } })).toBe(false);
    expect(actorSprintRecoveryLocked({ mobility: { sprintRecoveryLocked: true } })).toBe(true);
  });
});

describe("click-route planner", () => {
  const bounds = { width: 24, height: 18 };

  it("keeps the fixed eight-neighbor order contract", () => {
    expect(CLICK_ROUTE_NEIGHBOR_ORDER.map((step) => `${step.dx},${step.dy}`)).toEqual([
      "1,0",
      "-1,0",
      "0,1",
      "0,-1",
      "1,-1",
      "1,1",
      "-1,1",
      "-1,-1",
    ]);
  });

  it("routes around a blocked obstacle instead of walking through it", () => {
    const blocked = new Set(["6,5", "6,4", "6,6"]);
    const plan = planClickRoute({ x: 4.2, y: 5.2 }, { x: 9.4, y: 5.2 }, bounds, blocked, []);
    expect(plan).not.toBeNull();
    expect(plan!.waypoints.length).toBeGreaterThan(0);
    // No waypoint may sit in a blocked cell center.
    for (const waypoint of plan!.waypoints) {
      expect(blocked.has(`${Math.floor(waypoint.x)},${Math.floor(waypoint.y)}`)).toBe(false);
    }
    // Path must leave the start column and reach the goal column.
    expect(plan!.waypoints.some((waypoint) => waypoint.x >= 9)).toBe(true);
  });

  it("inflates blockers by the player radius so tight gaps stay closed", () => {
    // Slab face at x=6.5. Cell (5,5) actor-anchor (5.5,5.5) -> ground center
    // (6.0,6.0) sits 0.5 cells west of the face (> radius 0.3) so it stays open.
    // Cell (6,5) actor-anchor (6.5,5.5) -> ground center (7.0,6.0) is inside the
    // slab, so radius inflation closes it.
    const slab: MovementBlocker = { left: 6.5, top: 3, right: 6.9, bottom: 8 };
    expect(clickRouteCellWalkable(5, 5, bounds, new Set(), [slab])).toBe(true);
    expect(clickRouteCellWalkable(6, 5, bounds, new Set(), [slab])).toBe(false);
    const plan = planClickRoute({ x: 4.5, y: 5.5 }, { x: 9.5, y: 5.5 }, bounds, new Set(), [slab]);
    expect(plan).not.toBeNull();
    for (const waypoint of plan!.waypoints) {
      expect(isBlockedAt(new Set(), waypoint, [slab])).toBe(false);
    }
  });

  it("refuses diagonal corner cuts when either orthogonal neighbor is blocked", () => {
    // Diagonal NE from (4,5) into (5,4) needs orthogonals (5,5) and (4,4) clear
    // AND the destination clear. Block the destination jamb cell.
    const blockedDest = new Set(["5,4"]);
    expect(clickRouteDiagonalClear(4, 5, 1, -1, bounds, blockedDest, [])).toBe(false);
    expect(clickRouteDiagonalClear(4, 5, 1, 0, bounds, blockedDest, [])).toBe(true);
    // Block only the east orthogonal corner — diagonal must still refuse.
    const blockedCorner = new Set(["5,5"]);
    expect(clickRouteDiagonalClear(4, 5, 1, -1, bounds, blockedCorner, [])).toBe(false);
    const plan = planClickRoute({ x: 4.5, y: 5.5 }, { x: 5.5, y: 4.5 }, bounds, blockedDest, []);
    // Must not take the single diagonal step through the blocked destination.
    if (plan) {
      const first = plan.waypoints[0]!;
      const firstIsDiagonal = Math.floor(first.x) === 5 && Math.floor(first.y) === 4;
      expect(firstIsDiagonal).toBe(false);
    }
  });

  it("returns null for unreachable targets and respects the expansion budget", () => {
    // Sealed room: goal inside a ring of blocked cells.
    const blocked = new Set([
      "8,4", "9,4", "10,4",
      "8,5", "10,5",
      "8,6", "9,6", "10,6",
    ]);
    expect(planClickRoute({ x: 4.5, y: 5.5 }, { x: 9.5, y: 5.5 }, bounds, blocked, [])).toBeNull();
    // Expansion budget exhausted on a large open field with a tiny budget.
    const tiny = planClickRoute({ x: 2.5, y: 2.5 }, { x: 20.5, y: 15.5 }, bounds, new Set(), [], 1);
    expect(tiny).toBeNull();
    expect(CLICK_ROUTE_MAX_EXPANSIONS).toBeGreaterThan(1);
  });

  it("advances waypoints from authority-streamed position only", () => {
    const state = {};
    setClickMoveTarget(state, 10.5, 5.5, "area-a", 0);
    const installed = installClickRoute(
      state,
      { x: 4.5, y: 5.5 },
      bounds,
      new Set(),
      [],
    );
    expect(installed).toBe(true);
    expect(clickRouteWaypoints(state).length).toBeGreaterThan(0);
    const first = clickRouteWaypoints(state)[0]!;
    // Far authority: still steering at the first waypoint.
    expect(advanceClickRouteFromAuthority(state, { x: 4.5, y: 5.5 })).toEqual(first);
    expect(clickRouteIndex(state)).toBe(0);
    // Authority arrives on the first waypoint: index advances.
    const next = advanceClickRouteFromAuthority(state, { x: first.x, y: first.y });
    expect(clickRouteIndex(state)).toBeGreaterThan(0);
    // Final authority on the goal clears the route steer (null → arrived).
    const goal = clickRouteWaypoints(state)[clickRouteWaypoints(state).length - 1]!;
    // Jump authority through remaining waypoints.
    let guard = 0;
    let steer = next;
    while (steer && guard < 64) {
      steer = advanceClickRouteFromAuthority(state, { x: steer.x, y: steer.y });
      guard += 1;
    }
    expect(advanceClickRouteFromAuthority(state, { x: goal.x, y: goal.y })).toBeNull();
  });

  it("replans when the blocker revision changes and bounds the replan budget", () => {
    const state = {};
    setClickMoveTarget(state, 12.5, 5.5, "area-a", 0);
    expect(installClickRoute(state, { x: 4.5, y: 5.5 }, bounds, new Set(), [], false)).toBe(true);
    const revisionOpen = movementObstacleRevision(new Set(), []);
    expect(clickRouteNeedsBlockerReplan(state, new Set(), [])).toBe(false);
    const wall: MovementBlocker = { left: 8, top: 0, right: 8.4, bottom: 12 };
    expect(clickRouteNeedsBlockerReplan(state, new Set(), [wall])).toBe(true);
    expect(movementObstacleRevision(new Set(), [wall])).not.toBe(revisionOpen);
    // Burn the replan budget.
    for (let i = 0; i < CLICK_ROUTE_MAX_REPLANS; i += 1) {
      expect(installClickRoute(state, { x: 4.5, y: 5.5 }, bounds, new Set(), [wall], true)).toBe(true);
    }
    expect(clickRouteReplanCount(state)).toBe(CLICK_ROUTE_MAX_REPLANS);
    expect(installClickRoute(state, { x: 4.5, y: 5.5 }, bounds, new Set(), [wall], true)).toBe(false);
  });

  it("shares sprint intent between keyboard shift and the persistent toggle", () => {
    const state = {};
    expect(movementSprintIntent(state, [])).toBe(false);
    expect(movementSprintIntent(state, ["ShiftLeft"])).toBe(true);
    setSprintToggleEnabled(state, true);
    expect(movementSprintIntent(state, [])).toBe(true);
    expect(movementSprintIntent(state, ["KeyD"])).toBe(true);
  });
});
