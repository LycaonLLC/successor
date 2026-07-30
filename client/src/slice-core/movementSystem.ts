import {
  clamp,
  directionFromVector,
  isMovementKey,
  movementKeyVector,
  type Cell,
  type Direction,
  type Point,
} from "./geometry";

/**
 * Movement is permanently world-cardinal. Keeping the literal on PlayState
 * preserves runtime/debug schema compatibility while making a rotated input
 * mode impossible to select accidentally.
 */
export type MovementInputMode = "world";

export interface MovementBounds {
  width: number;
  height: number;
}

export interface MovementBlocker {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export const PLAYER_COLLISION_RADIUS_CELLS = 0.3;
export const ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS = 0.5;
const legacyBlockedCellSweepStepCells = 0.12;
const circleDepenetrationEpsilonCells = 0.0001;
const traceSkinCells = 0.002;
const traceEpsilon = 0.000000001;
const maxInitialDepenetrationIterations = 4;
const maxTraceSlideIterations = 3;

/**
 * Presentation-side movement vector modifier (additive, examine-opener pattern):
 * the 3D client can install a modifier that slides the intent vector around
 * visual-only colliders (titan trunks etc.). Shared prediction still runs the
 * final cell/prop-bound clamp through moveIfUnblocked, so command send and
 * local prediction agree on the authoritative endpoint.
 */
export type MovementVectorModifier = (vector: Point) => Point;

let movementVectorModifier: MovementVectorModifier | null = null;

export function installMovementVectorModifier(modifier: MovementVectorModifier | null): void {
  movementVectorModifier = modifier;
}

export function movementVectorFromKeys(keys: Iterable<string>, _mode: MovementInputMode = "world"): Point {
  const raw = worldMovementVectorFromKeys(keys);
  if (!movementVectorModifier || (raw.x === 0 && raw.y === 0)) return raw;
  return movementVectorModifier(raw);
}

function worldMovementVectorFromKeys(keys: Iterable<string>): Point {
  let x = 0;
  let y = 0;
  for (const key of keys) {
    const vector = movementKeyVector(key);
    if (vector.x !== 0) x = vector.x;
    if (vector.y !== 0) y = vector.y;
  }
  if (x !== 0 && y !== 0) return { x: x * Math.SQRT1_2, y: y * Math.SQRT1_2 };
  return { x, y };
}

export function facingFromMovementKeys(keys: Iterable<string>, fallback: Direction, mode: MovementInputMode = "world"): Direction {
  const vector = movementVectorFromKeys(keys, mode);
  return directionFromVector(vector.x, vector.y, fallback);
}

export function isRotationLockKey(code: string): boolean {
  return code === "MouseRight";
}

export function isSprintKey(code: string): boolean {
  return code === "Shift" || code === "ShiftLeft" || code === "ShiftRight";
}

export function rotationLocked(keys: Iterable<string>): boolean {
  for (const key of keys) {
    if (isRotationLockKey(key)) return true;
  }
  return false;
}

export function earliestMovementKey(keys: Iterable<string>): string | null {
  for (const key of keys) {
    if (isMovementKey(key)) return key;
  }
  return null;
}

export function latestMovementKey(keys: Iterable<string>): string | null {
  const movementKeys = [...keys].filter(isMovementKey);
  return movementKeys[movementKeys.length - 1] ?? null;
}

export function moveIfUnblocked(
  current: Cell,
  bounds: MovementBounds,
  blocked: Set<string>,
  next: Cell,
  blockers: readonly MovementBlocker[] = [],
): Cell {
  const clamped = clampToMovementBounds(bounds, next);
  const cellClamped = blocked.size > 0
    ? slideMoveAgainstBlockedCells(current, clamped, (candidate) => blocked.has(`${Math.floor(candidate.x)},${Math.floor(candidate.y)}`))
    : clamped;
  if (blockers.length === 0) return cellClamped;
  resolveCircleMove(
    {
      x: current.x + ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
      y: current.y + ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
    },
    { x: cellClamped.x - current.x, y: cellClamped.y - current.y },
    PLAYER_COLLISION_RADIUS_CELLS,
    blockers,
    resolveMoveOutScratch,
  );
  return {
    x: resolveMoveOutScratch.x - ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
    y: resolveMoveOutScratch.y - ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
  };
}

export function clampMoveAgainstPropBounds(
  current: Cell,
  next: Cell,
  blockers: readonly MovementBlocker[] = [],
): Cell {
  if (blockers.length === 0) return { x: next.x, y: next.y };
  resolveCircleMove(
    {
      x: current.x + ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
      y: current.y + ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
    },
    { x: next.x - current.x, y: next.y - current.y },
    PLAYER_COLLISION_RADIUS_CELLS,
    blockers,
    resolveMoveOutScratch,
  );
  return {
    x: resolveMoveOutScratch.x - ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
    y: resolveMoveOutScratch.y - ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
  };
}

export function clampToMovementBounds(bounds: MovementBounds, next: Cell): Cell {
  return {
    x: clamp(next.x, 1, bounds.width - 2),
    y: clamp(next.y, 1, bounds.height - 2),
  };
}

export function isBlockedAt(blocked: Set<string>, pos: Cell, blockers: readonly MovementBlocker[] = []): boolean {
  if (blocked.has(`${Math.floor(pos.x)},${Math.floor(pos.y)}`)) return true;
  return circleIntersectsAnyBlocker(
    pos.x + ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
    pos.y + ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS,
    PLAYER_COLLISION_RADIUS_CELLS,
    blockers,
  );
}

/**
 * Swept circle-vs-AABB movement for player collision.
 *
 * Rust mirror: `crates/successor-sim/src/authority/swept_circle.rs`. Keep the
 * constants and scenario table aligned: player center is swept, radius is
 * 0.300 cells, skin is 0.002 cells, and at most three slide iterations run.
 *
 * The resolver first self-heals bad legacy positions with a small deepest-MTV
 * depenetration pass. Actual travel is then a swept segment trace against the
 * AABB faces plus the rounded corner caps of the circle-vs-box Minkowski sum:
 * advance to the earliest time of impact, back off by skin, remove the normal
 * component of the remaining delta, and iterate. That trace-slide shape is
 * parameter-free against thin walls and does not invent square blockers around
 * door-jamb corners.
 */
export function resolveCircleMove(
  origin: Cell,
  delta: Point,
  radius: number,
  blockers: readonly MovementBlocker[],
  out: Cell,
): Cell {
  out.x = origin.x;
  out.y = origin.y;
  const safeRadius = Math.max(0, Number.isFinite(radius) ? radius : 0);
  if (blockers.length === 0) {
    out.x += Number.isFinite(delta.x) ? delta.x : 0;
    out.y += Number.isFinite(delta.y) ? delta.y : 0;
    return out;
  }

  depenetrateInitialCirclePosition(out, safeRadius, blockers);

  let remainingX = Number.isFinite(delta.x) ? delta.x : 0;
  let remainingY = Number.isFinite(delta.y) ? delta.y : 0;
  for (let iteration = 0; iteration < maxTraceSlideIterations; iteration += 1) {
    const remainingDistance = Math.hypot(remainingX, remainingY);
    if (remainingDistance <= traceEpsilon) break;
    const hit = traceCircleAgainstBlockers(out.x, out.y, remainingX, remainingY, safeRadius, blockers, traceHitScratch);
    if (!hit.hit) {
      out.x += remainingX;
      out.y += remainingY;
      break;
    }

    const travelT = Math.max(0, hit.t - traceSkinCells / remainingDistance);
    out.x += remainingX * travelT;
    out.y += remainingY * travelT;

    const leftoverScale = Math.max(0, 1 - travelT);
    remainingX *= leftoverScale;
    remainingY *= leftoverScale;
    const normalComponent = remainingX * hit.normalX + remainingY * hit.normalY;
    if (normalComponent < 0) {
      remainingX -= hit.normalX * normalComponent;
      remainingY -= hit.normalY * normalComponent;
    }
  }

  return out;
}

function slideMoveAgainstBlockedCells(
  current: Cell,
  next: Cell,
  blockedAt: (candidate: Cell) => boolean,
): Cell {
  const direct = sweepMoveUntilBlocked(current, next, blockedAt, legacyBlockedCellSweepStepCells);
  if (!direct.blocked) return direct.position;

  const dx = next.x - current.x;
  const dy = next.y - current.y;
  const xCandidate = { x: next.x, y: current.y };
  const yCandidate = { x: current.x, y: next.y };
  const first = Math.abs(dx) >= Math.abs(dy) ? xCandidate : yCandidate;
  const second = first === xCandidate ? yCandidate : xCandidate;
  const firstSlide = sweepBlockedCellAxis(current, first, blockedAt);
  if (firstSlide) return firstSlide;
  const secondSlide = sweepBlockedCellAxis(current, second, blockedAt);
  if (secondSlide) return secondSlide;
  if (movedFrom(current, direct.position)) return direct.position;
  return current;
}

function sweepBlockedCellAxis(
  current: Cell,
  candidate: Cell,
  blockedAt: (candidate: Cell) => boolean,
): Cell | null {
  if (!movedFrom(current, candidate)) return null;
  const sweep = sweepMoveUntilBlocked(current, candidate, blockedAt, legacyBlockedCellSweepStepCells);
  return sweep.blocked ? null : sweep.position;
}

function sweepMoveUntilBlocked(
  current: Cell,
  next: Cell,
  blockedAt: (candidate: Cell) => boolean,
  sweepStepCells: number,
): { position: Cell; blocked: boolean } {
  if (!movedFrom(current, next)) return { position: current, blocked: blockedAt(current) };
  if (blockedAt(current)) return { position: current, blocked: true };
  const dx = next.x - current.x;
  const dy = next.y - current.y;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(distance / Math.max(0.001, sweepStepCells)));
  let lastX = current.x;
  let lastY = current.y;
  const sample = blockedCellSweepSampleScratch;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    sample.x = current.x + dx * t;
    sample.y = current.y + dy * t;
    if (blockedAt(sample)) return { position: { x: lastX, y: lastY }, blocked: true };
    lastX = sample.x;
    lastY = sample.y;
  }
  return { position: next, blocked: false };
}

function movedFrom(current: Cell, next: Cell): boolean {
  return current.x !== next.x || current.y !== next.y;
}

interface CircleTraceHit {
  hit: boolean;
  t: number;
  normalX: number;
  normalY: number;
}

interface CircleOverlap {
  depth: number;
  normalX: number;
  normalY: number;
}

const resolveMoveOutScratch: Cell = { x: 0, y: 0 };
const blockedCellSweepSampleScratch: Cell = { x: 0, y: 0 };
const traceHitScratch: CircleTraceHit = { hit: false, t: 1, normalX: 0, normalY: 0 };
const traceCandidateScratch: CircleTraceHit = { hit: false, t: 1, normalX: 0, normalY: 0 };
const overlapScratch: CircleOverlap = { depth: 0, normalX: 0, normalY: 0 };
const overlapCandidateScratch: CircleOverlap = { depth: 0, normalX: 0, normalY: 0 };

function depenetrateInitialCirclePosition(
  position: Cell,
  radius: number,
  blockers: readonly MovementBlocker[],
): void {
  for (let iteration = 0; iteration < maxInitialDepenetrationIterations; iteration += 1) {
    overlapScratch.depth = 0;
    overlapScratch.normalX = 0;
    overlapScratch.normalY = 0;
    for (const blocker of blockers) {
      if (!circleAabbOverlap(position.x, position.y, radius, blocker, overlapCandidateScratch)) continue;
      if (overlapCandidateScratch.depth > overlapScratch.depth) {
        overlapScratch.depth = overlapCandidateScratch.depth;
        overlapScratch.normalX = overlapCandidateScratch.normalX;
        overlapScratch.normalY = overlapCandidateScratch.normalY;
      }
    }
    if (overlapScratch.depth <= circleDepenetrationEpsilonCells) break;
    position.x += overlapScratch.normalX * (overlapScratch.depth + circleDepenetrationEpsilonCells);
    position.y += overlapScratch.normalY * (overlapScratch.depth + circleDepenetrationEpsilonCells);
  }
}

function traceCircleAgainstBlockers(
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
  blockers: readonly MovementBlocker[],
  out: CircleTraceHit,
): CircleTraceHit {
  out.hit = false;
  out.t = 1;
  out.normalX = 0;
  out.normalY = 0;
  for (const blocker of blockers) {
    if (!sweepSegmentAgainstRoundedAabb(x, y, dx, dy, radius, blocker, traceCandidateScratch)) continue;
    if (!out.hit || traceCandidateScratch.t < out.t) {
      out.hit = true;
      out.t = traceCandidateScratch.t;
      out.normalX = traceCandidateScratch.normalX;
      out.normalY = traceCandidateScratch.normalY;
    }
  }
  return out;
}

function sweepSegmentAgainstRoundedAabb(
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
  blocker: MovementBlocker,
  out: CircleTraceHit,
): boolean {
  out.hit = false;
  out.t = 1;
  out.normalX = 0;
  out.normalY = 0;

  if (circleAabbOverlap(x, y, radius, blocker, overlapCandidateScratch)) {
    out.normalX = overlapCandidateScratch.normalX;
    out.normalY = overlapCandidateScratch.normalY;
    if (dx * out.normalX + dy * out.normalY >= 0) return false;
    out.hit = true;
    out.t = 0;
    return true;
  }

  traceVerticalRoundedFace(out, x, y, dx, dy, blocker.left - radius, blocker.top, blocker.bottom, -1);
  traceVerticalRoundedFace(out, x, y, dx, dy, blocker.right + radius, blocker.top, blocker.bottom, 1);
  traceHorizontalRoundedFace(out, x, y, dx, dy, blocker.top - radius, blocker.left, blocker.right, -1);
  traceHorizontalRoundedFace(out, x, y, dx, dy, blocker.bottom + radius, blocker.left, blocker.right, 1);
  traceRoundedCorner(out, x, y, dx, dy, radius, blocker.left, blocker.top);
  traceRoundedCorner(out, x, y, dx, dy, radius, blocker.right, blocker.top);
  traceRoundedCorner(out, x, y, dx, dy, radius, blocker.left, blocker.bottom);
  traceRoundedCorner(out, x, y, dx, dy, radius, blocker.right, blocker.bottom);
  return out.hit;
}

function traceVerticalRoundedFace(
  out: CircleTraceHit,
  x: number,
  y: number,
  dx: number,
  dy: number,
  planeX: number,
  spanTop: number,
  spanBottom: number,
  normalX: number,
): void {
  if (Math.abs(dx) <= traceEpsilon || dx * normalX >= 0) return;
  const t = (planeX - x) / dx;
  if (t < -traceEpsilon || t > 1 + traceEpsilon) return;
  const contactY = y + dy * t;
  if (contactY < spanTop - traceEpsilon || contactY > spanBottom + traceEpsilon) return;
  keepEarliestTraceHit(out, t, normalX, 0);
}

function traceHorizontalRoundedFace(
  out: CircleTraceHit,
  x: number,
  y: number,
  dx: number,
  dy: number,
  planeY: number,
  spanLeft: number,
  spanRight: number,
  normalY: number,
): void {
  if (Math.abs(dy) <= traceEpsilon || dy * normalY >= 0) return;
  const t = (planeY - y) / dy;
  if (t < -traceEpsilon || t > 1 + traceEpsilon) return;
  const contactX = x + dx * t;
  if (contactX < spanLeft - traceEpsilon || contactX > spanRight + traceEpsilon) return;
  keepEarliestTraceHit(out, t, 0, normalY);
}

function traceRoundedCorner(
  out: CircleTraceHit,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
  cornerX: number,
  cornerY: number,
): void {
  const offsetX = x - cornerX;
  const offsetY = y - cornerY;
  const a = dx * dx + dy * dy;
  if (a <= traceEpsilon) return;
  const b = 2 * (offsetX * dx + offsetY * dy);
  const c = offsetX * offsetX + offsetY * offsetY - radius * radius;
  if (c <= 0) return;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return;
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  if (t < -traceEpsilon || t > 1 + traceEpsilon) return;
  const hitX = offsetX + dx * t;
  const hitY = offsetY + dy * t;
  const distance = Math.hypot(hitX, hitY);
  if (distance <= traceEpsilon) return;
  const normalX = hitX / distance;
  const normalY = hitY / distance;
  if (dx * normalX + dy * normalY >= 0) return;
  keepEarliestTraceHit(out, t, normalX, normalY);
}

function keepEarliestTraceHit(out: CircleTraceHit, t: number, normalX: number, normalY: number): void {
  if (t < -traceEpsilon || t > 1 + traceEpsilon) return;
  const clampedT = clamp(t, 0, 1);
  if (out.hit && clampedT >= out.t) return;
  out.hit = true;
  out.t = clampedT;
  out.normalX = normalX;
  out.normalY = normalY;
}

function circleIntersectsAnyBlocker(
  x: number,
  y: number,
  radius: number,
  blockers: readonly MovementBlocker[],
): boolean {
  for (const blocker of blockers) {
    if (circleAabbOverlap(x, y, radius, blocker, overlapCandidateScratch)) return true;
  }
  return false;
}

function circleAabbOverlap(
  x: number,
  y: number,
  radius: number,
  blocker: MovementBlocker,
  out: CircleOverlap,
): boolean {
  const inside = x >= blocker.left
    && x <= blocker.right
    && y >= blocker.top
    && y <= blocker.bottom;
  if (inside) {
    const leftDistance = Math.max(0, x - blocker.left);
    const rightDistance = Math.max(0, blocker.right - x);
    const topDistance = Math.max(0, y - blocker.top);
    const bottomDistance = Math.max(0, blocker.bottom - y);
    let faceDistance = leftDistance;
    out.normalX = -1;
    out.normalY = 0;
    if (rightDistance < faceDistance) {
      faceDistance = rightDistance;
      out.normalX = 1;
      out.normalY = 0;
    }
    if (topDistance < faceDistance) {
      faceDistance = topDistance;
      out.normalX = 0;
      out.normalY = -1;
    }
    if (bottomDistance < faceDistance) {
      faceDistance = bottomDistance;
      out.normalX = 0;
      out.normalY = 1;
    }
    out.depth = radius + faceDistance;
    return out.depth > circleDepenetrationEpsilonCells;
  }

  const closestX = clamp(x, blocker.left, blocker.right);
  const closestY = clamp(y, blocker.top, blocker.bottom);
  const offsetX = x - closestX;
  const offsetY = y - closestY;
  const distSq = offsetX * offsetX + offsetY * offsetY;
  const minClearance = Math.max(0, radius - circleDepenetrationEpsilonCells);
  if (distSq >= minClearance * minClearance) return false;
  const distance = Math.sqrt(distSq);
  if (distance <= traceEpsilon) {
    out.normalX = 1;
    out.normalY = 0;
    out.depth = radius;
    return true;
  }
  out.normalX = offsetX / distance;
  out.normalY = offsetY / distance;
  out.depth = radius - distance;
  return out.depth > circleDepenetrationEpsilonCells;
}

// ── Movement UX: click-to-move navigation + persistent sprint toggle ────────
//
// Presentation-side intent only. Both stores feed the EXISTING authoritative
// movement intents in runtimeUpdateSystem — they never create gameplay truth.
// State rides a WeakMap keyed by the PlayState object (softLock /
// movementVectorModifier module-store precedent) so gameState's schema stays
// untouched and per-test states remain isolated.
//
// Click routing is also presentation-only: an eight-neighbor grid walk over
// PlayState.blocked + movementBlockers with the ordinary 0.3-cell player
// radius. Waypoint arrival reads authority-streamed position; the client never
// writes position truth and never invents a second movement command.

/** Click-to-move destination in authority cell coordinates. */
export interface ClickMoveTarget {
  x: number;
  y: number;
  areaId: string;
}

export type ClickMoveEventKind = "set" | "retarget" | "arrived" | "cancelled";

/** Marker-facing lifecycle event (drained by the ground-marker FX). */
export interface ClickMoveEvent {
  kind: ClickMoveEventKind;
  x: number;
  y: number;
  areaId: string;
}

export type ClickMoveCancelReason =
  | "manual-input"
  | "input-locked"
  | "blocked"
  | "area-transition"
  | "combat"
  | "cleared"
  | "unreachable"
  | "replan-exhausted";

/** Close enough to stop: must exceed one sprint tick step (~0.22 cells). */
export const CLICK_MOVE_ARRIVAL_RADIUS_CELLS = 0.45;
/** Waypoint handoff uses the same arrival band as the final destination. */
export const CLICK_ROUTE_WAYPOINT_ARRIVAL_RADIUS_CELLS = CLICK_MOVE_ARRIVAL_RADIUS_CELLS;
/** Hard cap on A* node expansions (deterministic fail → ordinary stop). */
export const CLICK_ROUTE_MAX_EXPANSIONS = 384;
/** Compressed waypoint budget after corner collapse. */
export const CLICK_ROUTE_MAX_WAYPOINTS = 48;
/** Replans from blocker revision / authority stall before visible cancel. */
export const CLICK_ROUTE_MAX_REPLANS = 6;
/**
 * Fixed eight-neighbor order. Cardinals first (E,W,S,N) then diagonals
 * (NE,SE,SW,NW). Order is part of the deterministic contract — do not reshuffle.
 */
export const CLICK_ROUTE_NEIGHBOR_ORDER = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
] as const;

/** Per-axis snap-off; < arrival/√2 so a live target always yields an octant. */
const clickMoveAxisDeadzoneCells = 0.3;
/** No net authority progress toward the route for this long → replan/stall. */
const clickMoveStallTimeoutMs = 1500;
const clickMoveStallProgressEpsilonCells = 0.05;

export interface ClickRoutePlan {
  /** Cell-center anchors from first step through goal (start omitted). */
  waypoints: Cell[];
  expansions: number;
}

interface MovementUxEntry {
  clickTarget: ClickMoveTarget | null;
  sprintToggle: boolean;
  bestDistanceCells: number;
  lastProgressAtMs: number;
  clickMoveEvents: ClickMoveEvent[];
  routeWaypoints: Cell[];
  routeIndex: number;
  routeRevision: number;
  replanCount: number;
}

const movementUxEntries = new WeakMap<object, MovementUxEntry>();
const MAX_QUEUED_CLICK_MOVE_EVENTS = 32;

function movementUxEntry(state: object): MovementUxEntry {
  let entry = movementUxEntries.get(state);
  if (!entry) {
    entry = {
      clickTarget: null,
      sprintToggle: false,
      bestDistanceCells: Infinity,
      lastProgressAtMs: 0,
      clickMoveEvents: [],
      routeWaypoints: [],
      routeIndex: 0,
      routeRevision: 0,
      replanCount: 0,
    };
    movementUxEntries.set(state, entry);
  }
  return entry;
}

function clearClickRouteState(entry: MovementUxEntry): void {
  entry.routeWaypoints = [];
  entry.routeIndex = 0;
  entry.routeRevision = 0;
  entry.replanCount = 0;
}

function pushClickMoveEvent(entry: MovementUxEntry, kind: ClickMoveEventKind, target: ClickMoveTarget): void {
  if (entry.clickMoveEvents.length >= MAX_QUEUED_CLICK_MOVE_EVENTS) entry.clickMoveEvents.shift();
  entry.clickMoveEvents.push({ kind, x: target.x, y: target.y, areaId: target.areaId });
}

/** Set (or replace) the click destination. Emits `set` / `retarget`. */
export function setClickMoveTarget(state: object, x: number, y: number, areaId: string, nowMs = 0): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const entry = movementUxEntry(state);
  const kind: ClickMoveEventKind = entry.clickTarget ? "retarget" : "set";
  entry.clickTarget = { x, y, areaId };
  entry.bestDistanceCells = Infinity;
  entry.lastProgressAtMs = nowMs;
  clearClickRouteState(entry);
  pushClickMoveEvent(entry, kind, entry.clickTarget);
}

export function clickMoveTarget(state: object): ClickMoveTarget | null {
  return movementUxEntries.get(state)?.clickTarget ?? null;
}

/** Drop the destination (manual input, lock, block, transition…). Emits `cancelled`. */
export function cancelClickMove(state: object, _reason: ClickMoveCancelReason): void {
  const entry = movementUxEntries.get(state);
  if (!entry?.clickTarget) return;
  pushClickMoveEvent(entry, "cancelled", entry.clickTarget);
  entry.clickTarget = null;
  clearClickRouteState(entry);
}

/** Destination reached: clear and emit `arrived` (marker plays its landing beat). */
export function completeClickMove(state: object): void {
  const entry = movementUxEntries.get(state);
  if (!entry?.clickTarget) return;
  pushClickMoveEvent(entry, "arrived", entry.clickTarget);
  entry.clickTarget = null;
  clearClickRouteState(entry);
}

/** Move queued marker events into `out` (allocation-free consumer pattern). */
export function drainClickMoveEvents(state: object, out: ClickMoveEvent[]): void {
  const events = movementUxEntries.get(state)?.clickMoveEvents;
  if (!events) return;
  for (let i = 0; i < events.length; i += 1) out.push(events[i]!);
  events.length = 0;
}

/** Active compressed waypoints (empty when idle or not yet planned). */
export function clickRouteWaypoints(state: object): readonly Cell[] {
  return movementUxEntries.get(state)?.routeWaypoints ?? [];
}

export function clickRouteIndex(state: object): number {
  return movementUxEntries.get(state)?.routeIndex ?? 0;
}

export function clickRouteReplanCount(state: object): number {
  return movementUxEntries.get(state)?.replanCount ?? 0;
}

/**
 * Deterministic fingerprint of the structural obstacle field the router reads.
 * Rebuilt blocked sets / door blockers change the revision and force a replan.
 */
export function movementObstacleRevision(
  blocked: ReadonlySet<string>,
  blockers: readonly MovementBlocker[],
): number {
  let hash = (blocked.size * 7349 + blockers.length * 9176) | 0;
  for (const key of blocked) {
    let keyHash = 2166136261;
    for (let i = 0; i < key.length; i += 1) {
      keyHash ^= key.charCodeAt(i);
      keyHash = Math.imul(keyHash, 16777619);
    }
    hash = Math.imul(hash ^ keyHash, 16777619);
  }
  for (let i = 0; i < blockers.length; i += 1) {
    const blocker = blockers[i]!;
    hash = Math.imul(hash ^ (Math.floor(blocker.left * 1000) | 0), 16777619);
    hash = Math.imul(hash ^ (Math.floor(blocker.top * 1000) | 0), 16777619);
    hash = Math.imul(hash ^ (Math.floor(blocker.right * 1000) | 0), 16777619);
    hash = Math.imul(hash ^ (Math.floor(blocker.bottom * 1000) | 0), 16777619);
  }
  return hash | 0;
}

function clickRouteCellKey(ix: number, iy: number): number {
  // Pack signed grid coords; area bounds stay well inside 16-bit range.
  return ((ix & 0xffff) << 16) | (iy & 0xffff);
}

/**
 * Actor-anchor sample for grid cell (ix, iy). Matches live positions whose
 * floor() cell is (ix, iy) and whose collision circle is centered at anchor +
 * ACTOR_ANCHOR_TO_GROUND_CENTER_CELLS (isBlockedAt contract).
 */
function clickRouteCellAnchor(ix: number, iy: number): Cell {
  return { x: ix + 0.5, y: iy + 0.5 };
}

function clickRouteQuantize(pos: { x: number; y: number }): { ix: number; iy: number } {
  return { ix: Math.floor(pos.x), iy: Math.floor(pos.y) };
}

/**
 * Cell clearance under the ordinary player radius. Uses the same blocked-cell +
 * circle-vs-blocker predicate as live movement (`isBlockedAt` on the cell's
 * actor-anchor sample).
 */
export function clickRouteCellWalkable(
  ix: number,
  iy: number,
  bounds: MovementBounds,
  blocked: ReadonlySet<string>,
  blockers: readonly MovementBlocker[],
): boolean {
  const anchor = clickRouteCellAnchor(ix, iy);
  if (anchor.x < 1 || anchor.y < 1 || anchor.x > bounds.width - 2 || anchor.y > bounds.height - 2) {
    return false;
  }
  return !isBlockedAt(blocked as Set<string>, anchor, blockers);
}

/**
 * Diagonal steps require both orthogonal corners clear — no corner cutting
 * through a blocked jamb.
 */
export function clickRouteDiagonalClear(
  fromIx: number,
  fromIy: number,
  dx: number,
  dy: number,
  bounds: MovementBounds,
  blocked: ReadonlySet<string>,
  blockers: readonly MovementBlocker[],
): boolean {
  if (dx === 0 || dy === 0) return true;
  // Destination must be clear, and both orthogonal corners — never clip a
  // blocked jamb with a diagonal shortcut.
  return clickRouteCellWalkable(fromIx + dx, fromIy + dy, bounds, blocked, blockers)
    && clickRouteCellWalkable(fromIx + dx, fromIy, bounds, blocked, blockers)
    && clickRouteCellWalkable(fromIx, fromIy + dy, bounds, blocked, blockers);
}

function clickRouteHeuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  // Octile distance in milli-cells keeps integer ordering stable.
  const diag = Math.min(dx, dy);
  const straight = Math.max(dx, dy) - diag;
  return diag * 1414 + straight * 1000;
}

function compressClickRouteCells(cells: readonly Cell[]): Cell[] {
  if (cells.length <= 2) return cells.map((cell) => ({ x: cell.x, y: cell.y }));
  const out: Cell[] = [{ x: cells[0]!.x, y: cells[0]!.y }];
  for (let i = 1; i < cells.length - 1; i += 1) {
    const prev = out[out.length - 1]!;
    const cur = cells[i]!;
    const next = cells[i + 1]!;
    const abx = Math.sign(cur.x - prev.x);
    const aby = Math.sign(cur.y - prev.y);
    const bcx = Math.sign(next.x - cur.x);
    const bcy = Math.sign(next.y - cur.y);
    if (abx !== bcx || aby !== bcy) out.push({ x: cur.x, y: cur.y });
  }
  const goal = cells[cells.length - 1]!;
  const tail = out[out.length - 1]!;
  if (tail.x !== goal.x || tail.y !== goal.y) out.push({ x: goal.x, y: goal.y });
  if (out.length <= CLICK_ROUTE_MAX_WAYPOINTS) return out;
  // Evenly sample when a pathological corridor still exceeds the budget.
  const sampled: Cell[] = [];
  const last = out.length - 1;
  for (let i = 0; i < CLICK_ROUTE_MAX_WAYPOINTS - 1; i += 1) {
    const index = Math.round((i * last) / (CLICK_ROUTE_MAX_WAYPOINTS - 1));
    const cell = out[index]!;
    const prev = sampled[sampled.length - 1];
    if (!prev || prev.x !== cell.x || prev.y !== cell.y) sampled.push({ x: cell.x, y: cell.y });
  }
  const goalCell = out[last]!;
  const sampledTail = sampled[sampled.length - 1];
  if (!sampledTail || sampledTail.x !== goalCell.x || sampledTail.y !== goalCell.y) {
    sampled.push({ x: goalCell.x, y: goalCell.y });
  }
  return sampled;
}

/**
 * Deterministic eight-neighbor route over blocked cells + radius-inflated
 * blockers. Returns null when the goal is uncleared or the expansion budget
 * is exhausted. Pure: no PlayState writes.
 */
export function planClickRoute(
  from: { x: number; y: number },
  goal: { x: number; y: number },
  bounds: MovementBounds,
  blocked: ReadonlySet<string>,
  blockers: readonly MovementBlocker[] = [],
  maxExpansions = CLICK_ROUTE_MAX_EXPANSIONS,
): ClickRoutePlan | null {
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(goal.x) || !Number.isFinite(goal.y)) {
    return null;
  }
  const start = clickRouteQuantize(from);
  const end = clickRouteQuantize(goal);
  if (!clickRouteCellWalkable(end.ix, end.iy, bounds, blocked, blockers)) return null;

  // Already in the goal cell: single waypoint at the exact click anchor.
  if (start.ix === end.ix && start.iy === end.iy) {
    return { waypoints: [{ x: goal.x, y: goal.y }], expansions: 0 };
  }

  // Start may be slightly overlapped after depenetration; allow the search to
  // leave it even when the quantize cell itself currently fails clearance.
  const startWalkable = clickRouteCellWalkable(start.ix, start.iy, bounds, blocked, blockers);

  const startKey = clickRouteCellKey(start.ix, start.iy);
  const goalKey = clickRouteCellKey(end.ix, end.iy);
  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>();
  gScore.set(startKey, 0);
  const open: number[] = [startKey];
  const closed = new Set<number>();
  let expansions = 0;

  const decode = (key: number): { ix: number; iy: number } => {
    const ix = (key >> 16) & 0xffff;
    const iy = key & 0xffff;
    return {
      ix: ix >= 0x8000 ? ix - 0x10000 : ix,
      iy: iy >= 0x8000 ? iy - 0x10000 : iy,
    };
  };

  while (open.length > 0 && expansions < maxExpansions) {
    let bestIndex = 0;
    let bestKey = open[0]!;
    let bestF = Infinity;
    let bestH = Infinity;
    let bestY = 0;
    let bestX = 0;
    for (let i = 0; i < open.length; i += 1) {
      const key = open[i]!;
      const cell = decode(key);
      const g = gScore.get(key) ?? 1_000_000_000;
      const h = clickRouteHeuristic(cell.ix, cell.iy, end.ix, end.iy);
      const f = g + h;
      if (
        f < bestF
        || (f === bestF && h < bestH)
        || (f === bestF && h === bestH && cell.iy < bestY)
        || (f === bestF && h === bestH && cell.iy === bestY && cell.ix < bestX)
      ) {
        bestIndex = i;
        bestKey = key;
        bestF = f;
        bestH = h;
        bestY = cell.iy;
        bestX = cell.ix;
      }
    }
    const currentKey = bestKey;
    open[bestIndex] = open[open.length - 1]!;
    open.pop();
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    expansions += 1;

    if (currentKey === goalKey) {
      const pathKeys = [currentKey];
      let cursor = currentKey;
      while (cameFrom.has(cursor)) {
        cursor = cameFrom.get(cursor)!;
        pathKeys.push(cursor);
      }
      pathKeys.reverse();
      const centers: Cell[] = [];
      for (let i = 1; i < pathKeys.length; i += 1) {
        const cell = decode(pathKeys[i]!);
        centers.push(clickRouteCellAnchor(cell.ix, cell.iy));
      }
      // Final waypoint is the exact clicked anchor (not just the cell center).
      if (centers.length === 0) centers.push({ x: goal.x, y: goal.y });
      else {
        centers[centers.length - 1] = { x: goal.x, y: goal.y };
      }
      return { waypoints: compressClickRouteCells(centers), expansions };
    }

    const current = decode(currentKey);
    const currentG = gScore.get(currentKey) ?? 1_000_000_000;
    for (let n = 0; n < CLICK_ROUTE_NEIGHBOR_ORDER.length; n += 1) {
      const step = CLICK_ROUTE_NEIGHBOR_ORDER[n]!;
      const nix = current.ix + step.dx;
      const niy = current.iy + step.dy;
      const neighborKey = clickRouteCellKey(nix, niy);
      if (closed.has(neighborKey)) continue;
      const neighborWalkable = clickRouteCellWalkable(nix, niy, bounds, blocked, blockers);
      if (!neighborWalkable) continue;
      // Leaving a temporarily uncleared start cell is allowed; every other
      // step still enforces no-corner-cut against the live field.
      if (currentKey !== startKey || startWalkable) {
        if (!clickRouteDiagonalClear(current.ix, current.iy, step.dx, step.dy, bounds, blocked, blockers)) {
          continue;
        }
      } else if (step.dx !== 0 && step.dy !== 0) {
        // From an uncleared start, only cardinal escapes — never cut a corner.
        continue;
      }
      const stepCost = step.dx !== 0 && step.dy !== 0 ? 1414 : 1000;
      const tentative = currentG + stepCost;
      if (tentative >= (gScore.get(neighborKey) ?? 1_000_000_000)) continue;
      cameFrom.set(neighborKey, currentKey);
      gScore.set(neighborKey, tentative);
      if (!open.includes(neighborKey)) open.push(neighborKey);
    }
  }
  return null;
}

/**
 * Install a fresh route on the click-move entry. Returns false when planning
 * fails (caller should cancel + stop). Counts against the replan budget when
 * `countReplan` is true.
 */
export function installClickRoute(
  state: object,
  from: { x: number; y: number },
  bounds: MovementBounds,
  blocked: ReadonlySet<string>,
  blockers: readonly MovementBlocker[],
  countReplan = false,
): boolean {
  const entry = movementUxEntries.get(state);
  const target = entry?.clickTarget;
  if (!entry || !target) return false;
  if (countReplan) {
    if (entry.replanCount >= CLICK_ROUTE_MAX_REPLANS) return false;
    entry.replanCount += 1;
  }
  const plan = planClickRoute(from, target, bounds, blocked, blockers);
  if (!plan || plan.waypoints.length === 0) {
    // Preserve replanCount so the budget still exhausts on repeated failure;
    // only drop the stale waypoint list.
    entry.routeWaypoints = [];
    entry.routeIndex = 0;
    entry.routeRevision = 0;
    return false;
  }
  entry.routeWaypoints = plan.waypoints;
  entry.routeIndex = 0;
  entry.routeRevision = movementObstacleRevision(blocked, blockers);
  entry.bestDistanceCells = Infinity;
  return true;
}

/**
 * Advance waypoint index from authority-streamed position. Returns the active
 * steering anchor, or null when the final destination is reached.
 */
export function advanceClickRouteFromAuthority(
  state: object,
  authority: { x: number; y: number },
): Cell | null {
  const entry = movementUxEntries.get(state);
  if (!entry?.clickTarget || entry.routeWaypoints.length === 0) return entry?.clickTarget ?? null;
  while (entry.routeIndex < entry.routeWaypoints.length) {
    const waypoint = entry.routeWaypoints[entry.routeIndex]!;
    const distance = Math.hypot(waypoint.x - authority.x, waypoint.y - authority.y);
    if (distance > CLICK_ROUTE_WAYPOINT_ARRIVAL_RADIUS_CELLS) return waypoint;
    entry.routeIndex += 1;
  }
  return null;
}

/**
 * Octant step toward the target under the same world-cardinal grammar as the
 * keyboard (diagonals normalized to ±√½). Returns null when within the
 * arrival radius. Writes into `out`; never allocates.
 *
 * Route following prefers floor(cell) deltas so a waypoint on the same row/column
 * stays cardinal even when the continuous anchor sits on a half-cell (player at
 * integer coords vs cell-center waypoints). Geometric deadzones still apply when
 * the floor cells already match (final approach to an exact click anchor).
 */
export function clickMoveOctantVector(
  target: { x: number; y: number },
  player: { x: number; y: number },
  out: Point,
): Point | null {
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  if (Math.hypot(dx, dy) <= CLICK_MOVE_ARRIVAL_RADIUS_CELLS) return null;
  const cellDx = Math.floor(target.x) - Math.floor(player.x);
  const cellDy = Math.floor(target.y) - Math.floor(player.y);
  let sx = 0;
  let sy = 0;
  if (cellDx !== 0 || cellDy !== 0) {
    sx = Math.sign(cellDx);
    sy = Math.sign(cellDy);
  } else {
    sx = Math.abs(dx) > clickMoveAxisDeadzoneCells ? Math.sign(dx) : 0;
    sy = Math.abs(dy) > clickMoveAxisDeadzoneCells ? Math.sign(dy) : 0;
  }
  if (sx === 0 && sy === 0) return null;
  if (sx !== 0 && sy !== 0) {
    out.x = sx * Math.SQRT1_2;
    out.y = sy * Math.SQRT1_2;
  } else {
    out.x = sx;
    out.y = sy;
  }
  return out;
}

/**
 * Stuck watchdog against authority-streamed progress. Updates its own
 * bookkeeping; true means the route should replan or cancel.
 */
export function clickMoveStalled(
  state: object,
  authority: { x: number; y: number },
  nowMs: number,
): boolean {
  const entry = movementUxEntries.get(state);
  const target = entry?.clickTarget;
  if (!entry || !target) return false;
  const steer = entry.routeIndex < entry.routeWaypoints.length
    ? entry.routeWaypoints[entry.routeIndex]!
    : target;
  const distance = Math.hypot(steer.x - authority.x, steer.y - authority.y);
  // First sample after set/retarget: bestDistance starts at Infinity, so this
  // arm always records the baseline and lastProgressAtMs from setClickMoveTarget
  // (including 0) stays meaningful — never treat 0 as "unset".
  if (distance < entry.bestDistanceCells - clickMoveStallProgressEpsilonCells) {
    entry.bestDistanceCells = distance;
    entry.lastProgressAtMs = nowMs;
    return false;
  }
  return nowMs - entry.lastProgressAtMs > clickMoveStallTimeoutMs;
}

/** True when the stored route's obstacle fingerprint no longer matches live field. */
export function clickRouteNeedsBlockerReplan(
  state: object,
  blocked: ReadonlySet<string>,
  blockers: readonly MovementBlocker[],
): boolean {
  const entry = movementUxEntries.get(state);
  if (!entry?.clickTarget) return false;
  if (entry.routeWaypoints.length === 0) return true;
  return entry.routeRevision !== movementObstacleRevision(blocked, blockers);
}

/** Apply the installed presentation modifier (flora steering) to any vector. */
export function modifiedMovementVector(vector: Point): Point {
  if (!movementVectorModifier || (vector.x === 0 && vector.y === 0)) return vector;
  return movementVectorModifier(vector);
}

// ── Sprint toggle (RuneScape-style persistent run) ───────────────────────────

/** True while the persistent run toggle is on (intent survives the lockout). */
export function sprintToggleEnabled(state: object): boolean {
  return movementUxEntries.get(state)?.sprintToggle === true;
}

export function setSprintToggleEnabled(state: object, enabled: boolean): void {
  movementUxEntry(state).sprintToggle = enabled;
}

/** Flip the toggle (key edge / HUD click); returns the new value. */
export function toggleSprint(state: object): boolean {
  const entry = movementUxEntry(state);
  entry.sprintToggle = !entry.sprintToggle;
  return entry.sprintToggle;
}

/**
 * Presentation sprint *intent* before Action/recovery gates: held shift OR
 * the persistent toggle. Keyboard and click-route share this bit; runtime
 * still strips the request while the authority recovery lock is projected.
 */
export function movementSprintIntent(state: object, keys: Iterable<string>): boolean {
  if (sprintToggleEnabled(state)) return true;
  for (const key of keys) {
    if (isSprintKey(key)) return true;
  }
  return false;
}

/**
 * Authority sprint lockout projection: the sim sets `sprintRecoveryLocked`
 * when sprint exhausts Action, forces walking, and clears it only at full
 * Action. Absent field (older snapshots) reads as unlocked.
 */
export function actorSprintRecoveryLocked(
  actor: { mobility?: { sprintRecoveryLocked?: boolean } | null } | null | undefined,
): boolean {
  return actor?.mobility?.sprintRecoveryLocked === true;
}
