import { authorityIssuedAtServerTick } from "@successor/client/src/slice-core/authorityCommandSystem";
import {
  northUpScreenVectorFromWorld,
  worldVectorFromNorthUpScreen,
  type Point,
} from "@successor/client/src/slice-core/geometry";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { setClickMoveTarget } from "@successor/client/src/slice-core/movementSystem";
import { currentArea, propsForArea } from "@successor/client/src/slice-core/worldQueries";
import { canIssueGroundMove, clearEngagementFocusForGroundMove } from "../../../boot/groundMove";
import { biomeIdFromSliceArea, effectiveWorldSeedFromSliceArea } from "../../../render/terrain";
import { paintTerrainPixel } from "../../../render/terrain/procgen";
import { normalizedMagnitude, weatherEventsFromState, type WeatherEventView } from "../../../render/weather/storm";
import {
  createWaypoint,
  defaultWaypointName,
  deleteWaypoint,
  MAX_WAYPOINTS,
  setWaypointActive,
  waypointCount,
  waypoints,
  type Waypoint,
} from "../../waypoints/store";
import type { ContextRadial } from "../contextRadial";
import type { WindowContentHandle, WindowContext } from "../windowManager";

/**
 * DATAPAD · MAP — the planetary survey pane (TACTICAL / ORBITAL framings).
 *
 * SATELLITE BASE: the actual planet, not an illustration — every pixel is
 * `paintTerrainPixel(worldSeed, cell+0.5, …)` at 1 px/cell, the same
 * deterministic function the terrain streamer bakes the ground from, so the
 * map IS the world. The 1024² bake amortizes across frames (top-down row
 * sweep) and presents as the datapad pulling imagery: a scan line with
 * un-scanned rows dark. Cached per (area, seed, biome) for the session.
 *
 * OVERLAY (redrawn per frame): a north-up world-coordinate survey grid in
 * both framings (64-cell minor / 256-cell major),
 * structure markers from the live slice props,
 * the player blip, and STORM SYSTEMS from the server-authoritative
 * `state.weather` mirror — zone circle at true center/radius, phase-styled
 * (warning: dashed ring + sweep heading arrow; active: filled threat disc;
 * decay: fading ring), with a telemetry strip reading severity (magnitude),
 * radius, phase time and full-clear ETA (`resolvesAtTick`). During idle the
 * strip forecasts the next system window — the datapad is the reason the
 * player knows the schedule.
 */

const MINOR_GRID_CELLS = 64;
const MAJOR_GRID_CELLS = 256;
const BAKE_ROWS_PER_UPDATE = 24;
/** Modest headroom above the derived minimum cover zoom for the TACTICAL framing. */
const TACTICAL_ZOOM_MARGIN = 1.15;

export type DatapadMapMode = "tactical" | "orbital";
export type DatapadMapBasis = "north-up";

/**
 * Canvas projection for the datapad map.
 *
 * The world remains in raw authority coordinates. Only presentation crosses
 * this boundary, and the inverse is used for pointer hit-testing.
 *
 * Both TACTICAL and ORBITAL preserve raw world axes: north is screen-up, east
 * is screen-right. They differ only in framing. ORBITAL contains the whole
 * area; TACTICAL centers near the player and covers the viewport.
 *
 * TACTICAL edge behavior: when cover + `center` cannot both keep the focus
 * inset and all canvas corners in-world, keeping the focus visible wins. The
 * far side truthfully shows out-of-world void rather than fabricated terrain.
 */

/** Focus stays at least this fraction inside each half-extent of the canvas. */
const FOCUS_VISIBLE_INSET = 0.85;

/** See the framing contract above. */
export interface DatapadMapViewOptions {
  /** Presentation basis. North-up is the only supported world contract. */
  basis?: DatapadMapBasis;
  /** "contain" (default) fits the whole projected world; "cover" fills every canvas pixel with real world. */
  fit?: "contain" | "cover";
  /**
   * Margin multiplier above the base scale for the chosen fit. Under cover
   * it multiplies the derived minimum cover zoom and is clamped to ≥ 1 so
   * the corner guarantee always holds.
   */
  zoom?: number;
  /**
   * Desired raw-world view center; clamped so the visible canvas stays in
   * world bounds. Under cover, focus visibility takes precedence over the
   * corner guarantee when the two are geometrically incompatible.
   */
  center?: Point;
}

export interface DatapadMapProjection {
  basis: DatapadMapBasis;
  widthCells: number;
  heightCells: number;
  canvasWidth: number;
  canvasHeight: number;
  scale: number;
  /** Smallest zoom above the full fit at which every canvas corner lands inside world bounds. */
  minCoverZoom: number;
  /** Applied (clamped) raw-world center of the view. */
  viewCenter: Point;
  worldToCanvas(x: number, y: number): Point;
  canvasToWorld(x: number, y: number): Point;
}

/** One source of truth for the two player-facing map modes. */
export function datapadMapViewOptions(mode: DatapadMapMode, center: Point): DatapadMapViewOptions {
  return mode === "tactical"
    ? {
        basis: "north-up",
        fit: "cover",
        zoom: TACTICAL_ZOOM_MARGIN,
        center,
      }
    : {
        basis: "north-up",
        fit: "contain",
      };
}

export function createDatapadMapProjection(
  widthCells: number,
  heightCells: number,
  canvasWidth: number,
  canvasHeight: number,
  view: DatapadMapViewOptions = {},
): DatapadMapProjection {
  if (!(widthCells > 0) || !(heightCells > 0) || !(canvasWidth > 0) || !(canvasHeight > 0)) {
    throw new Error("datapad map: projection dimensions must be positive");
  }
  // Deliberately not selected from runtime data: framing may vary, compass
  // basis may not. Old/stale callers cannot reactivate a rotated map.
  const basis: DatapadMapBasis = "north-up";
  const projectVector = northUpScreenVectorFromWorld;
  const unprojectVector = worldVectorFromNorthUpScreen;

  // World-rect corners in the selected presentation basis bound the full map.
  const worldCorners = [
    projectVector(0, 0),
    projectVector(widthCells, 0),
    projectVector(0, heightCells),
    projectVector(widthCells, heightCells),
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const corner of worldCorners) {
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
  }
  const fitScale = Math.min(canvasWidth / (maxX - minX), canvasHeight / (maxY - minY));

  // Inverse-project the canvas corners (as deltas from the canvas center) at
  // the fit scale. Both supported inverse transforms are linear, so deltas map exactly;
  // the world-axis bbox of the four corners is what must fit inside the world
  // rect for full-cover framing. Derived, not assumed square.
  let coverHalfX = 0;
  let coverHalfY = 0;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const delta = unprojectVector(
      (sx * canvasWidth) / (2 * fitScale),
      (sy * canvasHeight) / (2 * fitScale),
    );
    coverHalfX = Math.max(coverHalfX, Math.abs(delta.x));
    coverHalfY = Math.max(coverHalfY, Math.abs(delta.y));
  }
  const minCoverZoom = Math.max((2 * coverHalfX) / widthCells, (2 * coverHalfY) / heightCells);

  const cover = view.fit === "cover";
  const zoom = cover ? Math.max(1, view.zoom ?? 1) * minCoverZoom : view.zoom ?? 1;
  const scale = fitScale * zoom;

  // Visible world half-extents at the final scale. Per-axis clamping of the
  // requested center minimizes |Δ| on each axis independently — the closest
  // legal aim at the target that keeps every canvas corner in-world.
  const halfX = coverHalfX / zoom;
  const halfY = coverHalfY / zoom;
  const desired = view.center ?? { x: widthCells / 2, y: heightCells / 2 };
  const viewCenter = {
    x: halfX >= widthCells - halfX ? widthCells / 2 : Math.min(Math.max(desired.x, halfX), widthCells - halfX),
    y: halfY >= heightCells - halfY ? heightCells / 2 : Math.min(Math.max(desired.y, halfY), heightCells - halfY),
  };
  const projectedCenter = projectVector(viewCenter.x, viewCenter.y);
  if (cover && view.center) {
    // Focus-visibility precedence (see contract note above): blend the
    // bounds-clamped center toward the (world-clamped) focus by the minimal
    // amount that keeps the focus inside the canvas with a small inset.
    // The blend stays in raw world space between two in-world points, so
    // the center itself can never leave world bounds. A no-op whenever the
    // bounds clamp already keeps the focus comfortably visible.
    const focus = {
      x: Math.min(Math.max(view.center.x, 0), widthCells),
      y: Math.min(Math.max(view.center.y, 0), heightCells),
    };
    const projectedFocus = projectVector(focus.x, focus.y);
    const projectedHalfX = (canvasWidth / (2 * scale)) * FOCUS_VISIBLE_INSET;
    const projectedHalfY = (canvasHeight / (2 * scale)) * FOCUS_VISIBLE_INSET;
    const dx = Math.abs(projectedFocus.x - projectedCenter.x);
    const dy = Math.abs(projectedFocus.y - projectedCenter.y);
    const allowed = Math.min(
      dx > 0 ? projectedHalfX / dx : Infinity,
      dy > 0 ? projectedHalfY / dy : Infinity,
    );
    if (allowed < 1) {
      const t = 1 - allowed;
      viewCenter.x += t * (focus.x - viewCenter.x);
      viewCenter.y += t * (focus.y - viewCenter.y);
      const projected = projectVector(viewCenter.x, viewCenter.y);
      projectedCenter.x = projected.x;
      projectedCenter.y = projected.y;
    }
  }
  const halfCanvasX = canvasWidth / 2;
  const halfCanvasY = canvasHeight / 2;

  return {
    basis,
    widthCells,
    heightCells,
    canvasWidth,
    canvasHeight,
    scale,
    minCoverZoom,
    viewCenter,
    worldToCanvas(x: number, y: number): Point {
      const projected = projectVector(x, y);
      return {
        x: halfCanvasX + (projected.x - projectedCenter.x) * scale,
        y: halfCanvasY + (projected.y - projectedCenter.y) * scale,
      };
    },
    canvasToWorld(x: number, y: number): Point {
      return unprojectVector(
        (x - halfCanvasX) / scale + projectedCenter.x,
        (y - halfCanvasY) / scale + projectedCenter.y,
      );
    },
  };
}

/** One raw-world coordinate rule for the canonical north-up survey. */
export interface WorldGridLine {
  axis: "x" | "y";
  coordinate: number;
  major: boolean;
  from: Point;
  to: Point;
}

/** World-stable vertical and horizontal rules for both map framings. */
export function worldGridLines(widthCells: number, heightCells: number): WorldGridLine[] {
  const lines: WorldGridLine[] = [];
  for (let x = MINOR_GRID_CELLS; x < widthCells; x += MINOR_GRID_CELLS) {
    lines.push({
      axis: "x",
      coordinate: x,
      major: x % MAJOR_GRID_CELLS === 0,
      from: { x, y: 0 },
      to: { x, y: heightCells },
    });
  }
  for (let y = MINOR_GRID_CELLS; y < heightCells; y += MINOR_GRID_CELLS) {
    lines.push({
      axis: "y",
      coordinate: y,
      major: y % MAJOR_GRID_CELLS === 0,
      from: { x: 0, y },
      to: { x: widthCells, y },
    });
  }
  return lines;
}

interface SatelliteBake {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  rowBuffer: ImageData;
  widthCells: number;
  heightCells: number;
  rowsDone: number;
  seed: number;
  biome: "desert" | "forest";
}

/** Session-scoped bake cache — reopening the datapad never rebakes. */
const bakeCache = new Map<string, SatelliteBake>();

function bakeFor(areaId: string, widthCells: number, heightCells: number, seed: number, biome: "desert" | "forest"): SatelliteBake {
  const key = `${areaId}:${seed}:${biome}:${widthCells}x${heightCells}`;
  const existing = bakeCache.get(key);
  if (existing) return existing;
  const canvas = document.createElement("canvas");
  canvas.width = widthCells;
  canvas.height = heightCells;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("datapad map: satellite canvas 2d context unavailable");
  ctx.fillStyle = "#090b0c";
  ctx.fillRect(0, 0, widthCells, heightCells);
  const bake: SatelliteBake = {
    canvas,
    ctx,
    rowBuffer: ctx.createImageData(widthCells, 1),
    widthCells,
    heightCells,
    rowsDone: 0,
    seed,
    biome,
  };
  bakeCache.set(key, bake);
  return bake;
}

/** Advance the row sweep; returns true while rows remain. */
function advanceBake(bake: SatelliteBake, maxRows: number): boolean {
  if (bake.rowsDone >= bake.heightCells) return false;
  const end = Math.min(bake.heightCells, bake.rowsDone + maxRows);
  const data = bake.rowBuffer.data;
  for (let z = bake.rowsDone; z < end; z += 1) {
    for (let x = 0; x < bake.widthCells; x += 1) {
      // Cell centers — identical sampling family to the terrain streamer.
      paintTerrainPixel(bake.seed, x + 0.5, z + 0.5, data, x * 4, bake.biome);
    }
    bake.ctx.putImageData(bake.rowBuffer, 0, z);
  }
  bake.rowsDone = end;
  return bake.rowsDone < bake.heightCells;
}

interface StormReadout {
  headline: string;
  detail: string;
  tone: "idle" | "warning" | "active" | "decay";
}

export interface DatapadMapPane {
  root: HTMLElement;
  update(timeMs: number): void;
  onResized(): void;
  dispose(): void;
}

export interface DatapadMapPaneDeps {
  /** Shared right-click radial — passed explicitly, never reached for globally. */
  radial: ContextRadial;
}

// ── Pointer interactions (survey navigation) ────────────────────────────────
//
// The map is a command surface, not just a picture:
//   · single click on a waypoint marker selects it (and lights it up if it
//     was dormant); single click on open ground clears the selection;
//   · double click on ground routes click-movement straight to that raw
//     world cell (same authority-cell contract as a world ground click);
//   · right click opens the shared context radial — Move Here / Create
//     Waypoint on ground, Move Here / Activate·Deactivate / Delete Waypoint
//     on a marker.
// All hit-testing runs through the live projection inverse, so both TACTICAL
// and ORBITAL framings share one coordinate rule.

/** Marker grab radius in CSS px — usable without inflating the drawn glyphs. */
export const MAP_WAYPOINT_GRAB_PX = 12;

export type DatapadMapPointerEventType = "click" | "dblclick" | "contextmenu";

/** Structural pointer-event slice — lets node tests drive plain objects. */
export interface DatapadMapPointerEvent {
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

/** Structural keyboard slice — the survey's small honest keyboard path. */
export interface DatapadMapKeyboardEvent {
  key: string;
  preventDefault(): void;
}

/** Structural canvas slice — satisfied by HTMLCanvasElement and test fakes. */
export interface DatapadMapSurface {
  addEventListener(type: DatapadMapPointerEventType, listener: (event: DatapadMapPointerEvent) => void): void;
  addEventListener(type: "keydown", listener: (event: DatapadMapKeyboardEvent) => void): void;
  removeEventListener(type: DatapadMapPointerEventType, listener: (event: DatapadMapPointerEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: DatapadMapKeyboardEvent) => void): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

export interface DatapadMapPointerDeps {
  radial: ContextRadial;
  /** The same PlayState mirror the world input drives (movement authority). */
  state: PlayState;
  /** Projection of the currently painted frame (null before the first paint). */
  projection(): DatapadMapProjection | null;
  /** Area the map currently frames. */
  mappedAreaId(): string;
  now(): number;
  /** Player-facing receipts: create/toggle/delete statuses and refusals. */
  onStatus?(message: string): void;
}

export interface DatapadMapPointer {
  /** Selected waypoint id — self-heals to null once the row is gone. */
  selectedWaypointId(): string | null;
  dispose(): void;
}

export function attachDatapadMapPointer(surface: DatapadMapSurface, deps: DatapadMapPointerDeps): DatapadMapPointer {
  let selectedId: string | null = null;

  interface SurfacePoint {
    projection: DatapadMapProjection;
    x: number;
    y: number;
    grabPx: number;
  }

  const surfacePoint = (event: DatapadMapPointerEvent): SurfacePoint | null => {
    const projection = deps.projection();
    const rect = surface.getBoundingClientRect();
    if (!projection || rect.width <= 0 || rect.height <= 0) return null;
    return {
      projection,
      x: ((event.clientX - rect.left) / rect.width) * projection.canvasWidth,
      y: ((event.clientY - rect.top) / rect.height) * projection.canvasHeight,
      grabPx: MAP_WAYPOINT_GRAB_PX * (projection.canvasWidth / rect.width),
    };
  };

  const hitWaypoint = (point: SurfacePoint): Waypoint | null => {
    const areaId = deps.mappedAreaId();
    let best: Waypoint | null = null;
    let bestDistSq = point.grabPx * point.grabPx;
    for (const waypoint of waypoints()) {
      if (waypoint.areaId !== areaId) continue;
      const marker = point.projection.worldToCanvas(waypoint.x + 0.5, waypoint.y + 0.5);
      const dx = point.x - marker.x;
      const dy = point.y - marker.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= bestDistSq) {
        bestDistSq = distSq;
        best = waypoint;
      }
    }
    return best;
  };

  const inWorld = (projection: DatapadMapProjection, world: Point): boolean =>
    world.x >= 0 && world.y >= 0 && world.x <= projection.widthCells && world.y <= projection.heightCells;

  /** Route click movement to a render-space world point (cell + 0.5 basis). */
  const moveToWorld = (projection: DatapadMapProjection, worldX: number, worldY: number): boolean => {
    const areaId = deps.mappedAreaId();
    if (areaId !== deps.state.activeAreaId) {
      deps.onStatus?.("YOU ARE NOT IN THIS AREA");
      return false;
    }
    // Same gate as a world ground click: movement orders are for the living.
    if (!canIssueGroundMove(deps.state)) return false;
    // Clamp to the legal cell-center band ([0.5, cells − 0.5] in render
    // space) so edge clicks still land on a real authority cell after the
    // −0.5 conversion below.
    const x = Math.min(projection.widthCells - 0.5, Math.max(0.5, worldX));
    const y = Math.min(projection.heightCells - 0.5, Math.max(0.5, worldY));
    // Same pre-move grammar as a world ground click: drop the engagement
    // focus (target/lock/examine) before the order goes out.
    clearEngagementFocusForGroundMove(deps.state);
    // The survey renders cells at cell + 0.5 — convert back to authority cells.
    setClickMoveTarget(deps.state, x - 0.5, y - 0.5, areaId, deps.now());
    return true;
  };

  const onClick = (event: DatapadMapPointerEvent): void => {
    const point = surfacePoint(event);
    if (!point) return;
    const hit = hitWaypoint(point);
    if (!hit) {
      selectedId = null;
      return;
    }
    selectedId = hit.id;
    if (!hit.active) deps.onStatus?.(setWaypointActive(hit.id, true).status);
  };

  const onDblClick = (event: DatapadMapPointerEvent): void => {
    const point = surfacePoint(event);
    if (!point) return;
    const hit = hitWaypoint(point);
    if (hit) {
      selectedId = hit.id;
      moveToWorld(point.projection, hit.x + 0.5, hit.y + 0.5);
      return;
    }
    const world = point.projection.canvasToWorld(point.x, point.y);
    if (!inWorld(point.projection, world)) return;
    moveToWorld(point.projection, world.x, world.y);
  };

  const onContextMenu = (event: DatapadMapPointerEvent): void => {
    event.preventDefault();
    const point = surfacePoint(event);
    if (!point) {
      deps.radial.close();
      return;
    }
    const sameArea = deps.mappedAreaId() === deps.state.activeAreaId;
    const offAreaNote = sameArea ? null : "You are not in this area";
    const hit = hitWaypoint(point);
    if (hit) {
      selectedId = hit.id;
      deps.radial.openFor(event.clientX, event.clientY, [
        { id: "move", label: "MOVE HERE", enabled: sameArea, note: offAreaNote },
        { id: "toggle", label: hit.active ? "DEACTIVATE" : "ACTIVATE", enabled: true, note: null },
        { id: "delete", label: "DELETE WAYPOINT", enabled: true, note: null },
      ], {
        onAction: (actionId) => {
          const current = waypoints().find((row) => row.id === hit.id);
          if (!current) {
            deps.onStatus?.("WAYPOINT GONE");
            return;
          }
          if (actionId === "move") {
            moveToWorld(point.projection, current.x + 0.5, current.y + 0.5);
          } else if (actionId === "toggle") {
            deps.onStatus?.(setWaypointActive(current.id, !current.active).status);
          } else if (actionId === "delete") {
            deps.onStatus?.(deleteWaypoint(current.id).status);
            if (selectedId === current.id) selectedId = null;
          }
        },
        onDisabled: (note) => deps.onStatus?.(note || "DENIED"),
      });
      return;
    }
    const world = point.projection.canvasToWorld(point.x, point.y);
    if (!inWorld(point.projection, world)) {
      deps.radial.close();
      return;
    }
    const capped = waypointCount() >= MAX_WAYPOINTS;
    deps.radial.openFor(event.clientX, event.clientY, [
      { id: "move", label: "MOVE HERE", enabled: sameArea, note: offAreaNote },
      { id: "waypoint", label: "CREATE WAYPOINT", enabled: !capped, note: capped ? "Waypoint limit reached" : null },
    ], {
      onAction: (actionId) => {
        if (actionId === "move") {
          moveToWorld(point.projection, world.x, world.y);
          return;
        }
        const projection = point.projection;
        const result = createWaypoint({
          name: defaultWaypointName(),
          x: Math.min(projection.widthCells - 1, Math.max(0, Math.floor(world.x))),
          y: Math.min(projection.heightCells - 1, Math.max(0, Math.floor(world.y))),
          areaId: deps.mappedAreaId(),
        });
        deps.onStatus?.(result.status);
        if (result.ok && result.waypoint) selectedId = result.waypoint.id;
      },
      onDisabled: (note) => deps.onStatus?.(note || "DENIED"),
    });
  };

  // Small honest keyboard path: the only keyboard semantics the survey can
  // promise unambiguously are "travel to the selected waypoint" (Enter —
  // mirrors a marker double-click) and "drop the selection" (Escape).
  // Arbitrary-point travel stays pointer-only; we do not fake it.
  const onKeyDown = (event: DatapadMapKeyboardEvent): void => {
    if (event.key === "Escape") {
      if (selectedId === null) return;
      event.preventDefault();
      selectedId = null;
      return;
    }
    if (event.key !== "Enter") return;
    const selected = selectedId === null ? undefined : waypoints().find((row) => row.id === selectedId);
    if (!selected) return;
    event.preventDefault();
    const projection = deps.projection();
    if (!projection) return;
    moveToWorld(projection, selected.x + 0.5, selected.y + 0.5);
  };

  surface.addEventListener("click", onClick);
  surface.addEventListener("dblclick", onDblClick);
  surface.addEventListener("contextmenu", onContextMenu);
  surface.addEventListener("keydown", onKeyDown);

  return {
    selectedWaypointId(): string | null {
      if (selectedId !== null && !waypoints().some((row) => row.id === selectedId)) selectedId = null;
      return selectedId;
    },
    dispose(): void {
      surface.removeEventListener("click", onClick);
      surface.removeEventListener("dblclick", onDblClick);
      surface.removeEventListener("contextmenu", onContextMenu);
      surface.removeEventListener("keydown", onKeyDown);
    },
  };
}

/** One same-area OWN corpse row, projected for the survey overlay. */
export interface OwnCorpseMapMarker {
  corpseId: string;
  x: number;
  y: number;
  fadeLabel: string;
}

/**
 * Same-area corpses the PLAYER owns — the survey marks only YOUR remains
 * (other players' bags never gain map intel), and only on the framed area.
 * The label is the honest countdown to the authoritative 120-minute fade.
 */
export function ownCorpseMapMarkers(state: PlayState, areaId: string, nowTick: number, tickRateHz: number): OwnCorpseMapMarker[] {
  const markers: OwnCorpseMapMarker[] = [];
  for (const corpse of state.serverAuthority.playerCorpses) {
    if (!corpse.isOwner || corpse.areaId !== areaId) continue;
    markers.push({
      corpseId: corpse.id,
      x: corpse.x,
      y: corpse.y,
      fadeLabel: `FADES ${formatTicks(Math.max(0, corpse.expiryTick - nowTick), Math.max(1, tickRateHz))}`,
    });
  }
  return markers;
}

export function createDatapadMapPane(ctx: WindowContext, deps: DatapadMapPaneDeps): DatapadMapPane {
  const { state, slice } = ctx;

  const root = document.createElement("div");
  root.className = "scp-map";
  root.innerHTML = `
    <header class="scp-map-head">
      <span class="scp-map-title" data-ref="planet"></span>
      <span class="scp-map-sub" data-ref="coords"></span>
    </header>
    <nav class="scp-map-modes" data-ref="modes" aria-label="Map framing">
      <button type="button" class="scp-map-mode" data-mode="tactical" aria-pressed="false">TACTICAL</button>
      <button type="button" class="scp-map-mode" data-mode="orbital" aria-pressed="true">ORBITAL</button>
    </nav>
    <div class="scp-map-viewport" data-ref="viewport">
      <canvas class="scp-map-canvas" data-ref="canvas" tabindex="0" role="application"
        aria-label="Planetary survey map. Enter travels to the selected waypoint; Escape clears the selection."></canvas>
    </div>
    <footer class="scp-map-foot">
      <span class="scp-map-storm" data-ref="storm"></span>
      <span class="scp-map-status" data-ref="status" role="status" hidden></span>
    </footer>
  `;

  const planetEl = ref(root, "planet");
  const coordsEl = ref(root, "coords");
  const viewportEl = ref(root, "viewport");
  const modesEl = ref(root, "modes");
  const canvas = ref(root, "canvas") as HTMLCanvasElement;
  const stormEl = ref(root, "storm");
  const statusEl = ref(root, "status");
  const drawMaybe = canvas.getContext("2d");
  if (!drawMaybe) throw new Error("datapad map: overlay canvas 2d context unavailable");
  // Re-bind with the narrowed type: control-flow narrowing of the nullable
  // const does not survive into the update() closure below.
  const draw: CanvasRenderingContext2D = drawMaybe;

  let cssSize = 0;
  let backingSize = 0;
  let mapProjection: DatapadMapProjection | null = null;
  let mode: DatapadMapMode = "orbital";
  let appliedPlanet = "";
  let appliedCoords = "";
  let appliedStorm = "";
  let appliedTone = "";
  let hoverCellX = Number.NaN;
  let hoverCellY = Number.NaN;

  function applyMode(): void {
    root.dataset.mode = mode;
    viewportEl.dataset.mode = mode;
    for (const button of modesEl.querySelectorAll<HTMLButtonElement>(".scp-map-mode")) {
      button.setAttribute("aria-pressed", button.dataset.mode === mode ? "true" : "false");
    }
  }
  applyMode();

  modesEl.addEventListener("click", (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".scp-map-mode");
    const next = button?.dataset.mode;
    if ((next !== "tactical" && next !== "orbital") || next === mode) return;
    mode = next;
    // Repaint before publishing the selected DOM state. The window manager's
    // next animation-frame update can be delayed under a loaded renderer; if
    // the mode attributes changed first, observers briefly saw ORBITAL while
    // the canvas still held the opaque TACTICAL frame. A framing selection is
    // one visual transaction: projection, pixels, and controls agree when the
    // click returns.
    update(performance.now());
    applyMode();
  });

  canvas.addEventListener("pointermove", (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || !mapProjection) return;
    const canvasX = ((event.clientX - rect.left) / rect.width) * mapProjection.canvasWidth;
    const canvasY = ((event.clientY - rect.top) / rect.height) * mapProjection.canvasHeight;
    const world = mapProjection.canvasToWorld(canvasX, canvasY);
    hoverCellX = world.x;
    hoverCellY = world.y;
  });

  canvas.addEventListener("pointerleave", () => {
    hoverCellX = Number.NaN;
    hoverCellY = Number.NaN;
  });

  let statusFlashTimer = 0;
  const flashStatus = (message: string): void => {
    window.clearTimeout(statusFlashTimer);
    statusEl.textContent = message;
    statusEl.hidden = false;
    statusFlashTimer = window.setTimeout(() => {
      statusEl.hidden = true;
    }, 1400);
  };

  const pointer = attachDatapadMapPointer(canvas, {
    radial: deps.radial,
    state,
    projection: () => mapProjection,
    mappedAreaId: () => currentArea(slice, state).id,
    now: () => performance.now(),
    onStatus: flashStatus,
  });

  const accent = readToken("--sc3d-accent", "#9fe8dc");
  const ink = readToken("--sc3d-ink", "#d8e2de");
  const inkDim = readToken("--sc3d-ink-dim", "#7c8a86");

  function layout(): void {
    const rect = viewportEl.getBoundingClientRect();
    const size = Math.max(64, Math.floor(Math.min(rect.width, rect.height)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const backing = Math.max(128, Math.floor(size * dpr));
    if (size === cssSize && backing === backingSize) return;
    cssSize = size;
    backingSize = backing;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.width = backing;
    canvas.height = backing;
  }

  function update(timeMs: number): void {
    const area = currentArea(slice, state);
    const areaId = area.id;
    const biome = biomeIdFromSliceArea(slice, areaId);
    const seed = effectiveWorldSeedFromSliceArea(slice, areaId);
    const bake = bakeFor(areaId, area.width, area.height, seed, biome);
    advanceBake(bake, BAKE_ROWS_PER_UPDATE);

    layout();
    const size = backingSize;
    if (size <= 0) return;
    mapProjection = createDatapadMapProjection(
      area.width,
      area.height,
      size,
      size,
      datapadMapViewOptions(mode, { x: state.player.x + 0.5, y: state.player.y + 0.5 }),
    );

    // ── Base imagery ────────────────────────────────────────────────────
    draw.imageSmoothingEnabled = false;
    draw.clearRect(0, 0, size, size);
    draw.save();
    setRasterTransform(draw, mapProjection);
    draw.drawImage(bake.canvas, 0, 0, area.width, area.height);
    draw.restore();

    // Un-scanned band + scan line while the bake sweeps. The sweep is in raw
    // world rows, then projected like every other map surface.
    if (bake.rowsDone < bake.heightCells) {
      const scanY = bake.rowsDone;
      drawWorldPolygon(
        draw,
        mapProjection,
        [{ x: 0, y: scanY }, { x: area.width, y: scanY }, { x: area.width, y: area.height }, { x: 0, y: area.height }],
        "rgba(6, 8, 9, 0.92)",
      );
      drawWorldSegment(draw, mapProjection, { x: 0, y: scanY }, { x: area.width, y: scanY }, withAlpha(accent, 0.55), 2);
      drawWorldSegment(draw, mapProjection, { x: 0, y: Math.max(0, scanY - 10) }, { x: area.width, y: Math.max(0, scanY - 10) }, withAlpha(accent, 0.12), 10);
    }

    // ── Grid ─────────────────────────────────────────────────────────────
    // Both framings use the same raw north-up grid. Only framing changes;
    // world direction never does. Rules are clipped to the real world rect.
    // Double-stroked (dark underlay + light hairline) so rules read on both
    // bright sand and dark loam without ever shouting.
    draw.save();
    worldRectPath(draw, mapProjection, 0, 0, area.width, area.height);
    draw.clip();
    const gridLines = worldGridLines(area.width, area.height);
    for (const line of gridLines) {
      const underlay = `rgba(18, 14, 8, ${line.major ? 0.4 : 0.22})`;
      drawWorldSegment(draw, mapProjection, line.from, line.to, underlay, line.major ? 1.6 : 1.2);
      drawWorldSegment(draw, mapProjection, line.from, line.to, withAlpha(line.major ? accent : ink, line.major ? 0.4 : 0.14), 1);
      if (!line.major) continue;
      drawWorldGridLabel(draw, mapProjection, line, size, inkDim);
    }
    draw.restore();
    // Frame hairline.
    draw.strokeStyle = withAlpha(accent, 0.4);
    draw.strokeRect(0.5, 0.5, size - 1, size - 1);
    drawMapCardinals(draw, size, accent, inkDim);

    // ── Structures ───────────────────────────────────────────────────────
    draw.textBaseline = "alphabetic";
    const labels = createLabelPlacer();
    drawDatapadMapStructures(
      draw,
      propsForArea(slice, areaId),
      mapProjection,
      {
        mode,
        size,
        accent,
        ink,
        inkDim,
        labels,
      },
    );

    // ── Storm systems ────────────────────────────────────────────────────
    const tick = state.serverAuthority.snapshotTick;
    const tickRateHz = slice.tickRateHz > 0 ? slice.tickRateHz : 30;
    let readout: StormReadout | null = null;
    for (const event of weatherEventsFromState(state)) {
      if (event.areaId !== areaId) continue;
      readout = describeStorm(event, tick, tickRateHz) ?? readout;
      if (event.phase === "idle") continue;
      drawStormZone(draw, event, mapProjection, timeMs);
    }

    // ── Client waypoints ─────────────────────────────────────────────────
    drawWaypoints(
      draw,
      areaId,
      mapProjection,
      size,
      timeMs,
      accent,
      ink,
      hoverCellX,
      hoverCellY,
      state.player.x + 0.5,
      state.player.y + 0.5,
      labels,
      pointer.selectedWaypointId(),
    );

    // ── Own remains ──────────────────────────────────────────────────────
    // High-contrast amber X (the storm-family accent) over a dark underlay
    // disc — drawn only for same-area corpses the player owns, with the
    // remaining-fade countdown. Static on purpose: a corpse is a fact, not
    // a spectacle (calm/reduced-motion contract).
    const nowTick = authorityIssuedAtServerTick(state, tickRateHz, slice.tick);
    for (const marker of ownCorpseMapMarkers(state, areaId, nowTick, tickRateHz)) {
      const point = mapProjection.worldToCanvas(marker.x + 0.5, marker.y + 0.5);
      const r = Math.max(4, size * 0.007);
      dot(draw, point.x, point.y, r * 1.7, "rgba(14, 10, 4, 0.8)");
      draw.strokeStyle = "rgba(232, 178, 64, 0.95)";
      draw.lineWidth = 1.6;
      draw.beginPath();
      draw.arc(point.x, point.y, r * 1.7, 0, Math.PI * 2);
      draw.stroke();
      draw.lineWidth = 1.8;
      draw.beginPath();
      draw.moveTo(point.x - r * 0.72, point.y - r * 0.72);
      draw.lineTo(point.x + r * 0.72, point.y + r * 0.72);
      draw.moveTo(point.x + r * 0.72, point.y - r * 0.72);
      draw.lineTo(point.x - r * 0.72, point.y + r * 0.72);
      draw.stroke();
      label(draw, `YOUR REMAINS · ${marker.fadeLabel}`, point.x, point.y - r * 2.6, "#e8b240", size, labels);
    }

    // ── Player blip ──────────────────────────────────────────────────────
    const playerPoint = mapProjection.worldToCanvas(state.player.x + 0.5, state.player.y + 0.5);
    const pulse = 0.5 + 0.5 * Math.sin(timeMs * 0.005);
    draw.strokeStyle = withAlpha("#ffffff", 0.35 + 0.35 * pulse);
    draw.lineWidth = 1;
    draw.beginPath();
    draw.arc(playerPoint.x, playerPoint.y, 4 + pulse * 3, 0, Math.PI * 2);
    draw.stroke();
    dot(draw, playerPoint.x, playerPoint.y, 2.2, "#ffffff");

    // ── Text readouts (diff-gated DOM) ───────────────────────────────────
    const planetText = `${(area.name || areaId).toUpperCase()} · ${mode === "tactical" ? "TACTICAL VIEW" : "ORBITAL SURVEY"}`;
    if (planetText !== appliedPlanet) {
      appliedPlanet = planetText;
      planetEl.textContent = planetText;
    }
    const coordsText = `POS ${Math.round(state.player.x)} · ${Math.round(state.player.y)}${bake.rowsDone < bake.heightCells ? " · ACQUIRING IMAGERY" : ""}`;
    if (coordsText !== appliedCoords) {
      appliedCoords = coordsText;
      coordsEl.textContent = coordsText;
    }
    const stormText = readout ? `${readout.headline} · ${readout.detail}` : "ATMOSPHERICS · NO DATA";
    if (stormText !== appliedStorm) {
      appliedStorm = stormText;
      stormEl.textContent = stormText;
    }
    const tone = readout?.tone ?? "idle";
    if (tone !== appliedTone) {
      appliedTone = tone;
      stormEl.dataset.tone = tone;
    }
  }

  return {
    root,
    update,
    onResized: layout,
    dispose(): void {
      window.clearTimeout(statusFlashTimer);
      pointer.dispose();
      root.remove();
    },
  };
}

/** Live slice props the map can mark (structures only; tiles/gathers skipped). */
export type DatapadMapStructureProp = {
  kind: string;
  label?: string;
  cell: { x: number; y: number };
  size: { w: number; h: number };
  visible?: boolean;
  shelter?: boolean;
};

/**
 * Structure overlay for the survey pane.
 *
 * ORBITAL frames the whole area: generic `SHELTER` captions stack into unreadable
 * columns when many nearby shelters share a longitude. Keep the shelter footprint
 * marker, suppress only that generic caption in orbital mode. TACTICAL still paints
 * SHELTER text; named destinations (travel terminals) and other markers are unchanged.
 */
export function drawDatapadMapStructures(
  draw: CanvasRenderingContext2D,
  props: readonly DatapadMapStructureProp[],
  projection: DatapadMapProjection,
  options: {
    mode: DatapadMapMode;
    size: number;
    accent: string;
    ink: string;
    inkDim: string;
    labels?: LabelPlacer;
  },
): void {
  const { mode, size, accent, ink, inkDim } = options;
  const labels = options.labels ?? createLabelPlacer();
  for (const prop of props) {
    if (prop.visible === false) continue;
    if (prop.kind === "tile" || prop.kind === "gather_point" || prop.kind === "ai_test_cover") continue;
    const worldX = prop.cell.x + prop.size.w / 2;
    const worldY = prop.cell.y + prop.size.h / 2;
    const point = projection.worldToCanvas(worldX, worldY);
    const shelter = prop.shelter === true;
    if (shelter) {
      draw.strokeStyle = withAlpha(accent, 0.95);
      draw.lineWidth = 1.5;
      strokeWorldRect(draw, projection, prop.cell.x, prop.cell.y, prop.size.w, prop.size.h);
      // Presentation-only: orbital keeps geometry, drops repeated generic text.
      if (mode === "tactical") {
        const labelPoint = projection.worldToCanvas(worldX, prop.cell.y);
        label(draw, "SHELTER", labelPoint.x, labelPoint.y - 3, accent, size, labels);
      }
    } else if (prop.kind === "travel_terminal") {
      diamond(draw, point.x, point.y, Math.max(3.5, size * 0.006), withAlpha(accent, 0.95));
      // Place identity only (C2 label diet): "Travel Terminal — Dustgate"
      // marks the map as DUSTGATE — the diamond IS the terminal glyph.
      label(draw, placeQualifier(prop.label || "TERMINAL").toUpperCase(), point.x, point.y - Math.max(5, size * 0.008), inkDim, size, labels);
    } else if (prop.kind === "storage_chest") {
      dot(draw, point.x, point.y, Math.max(1.5, size * 0.0022), withAlpha(ink, 0.8));
    } else {
      dot(draw, point.x, point.y, Math.max(1.2, size * 0.0016), withAlpha(inkDim, 0.55));
    }
  }
}

function setRasterTransform(draw: CanvasRenderingContext2D, projection: DatapadMapProjection): void {
  const origin = projection.worldToCanvas(0, 0);
  const xBasis = projection.worldToCanvas(1, 0);
  const yBasis = projection.worldToCanvas(0, 1);
  draw.setTransform(
    xBasis.x - origin.x,
    xBasis.y - origin.y,
    yBasis.x - origin.x,
    yBasis.y - origin.y,
    origin.x,
    origin.y,
  );
}

function drawWorldPolygon(
  draw: CanvasRenderingContext2D,
  projection: DatapadMapProjection,
  points: Point[],
  fillStyle: string,
): void {
  draw.fillStyle = fillStyle;
  draw.beginPath();
  const first = projection.worldToCanvas(points[0]!.x, points[0]!.y);
  draw.moveTo(first.x, first.y);
  for (const point of points.slice(1)) {
    const projected = projection.worldToCanvas(point.x, point.y);
    draw.lineTo(projected.x, projected.y);
  }
  draw.closePath();
  draw.fill();
}

function drawWorldSegment(
  draw: CanvasRenderingContext2D,
  projection: DatapadMapProjection,
  from: Point,
  to: Point,
  strokeStyle: string,
  lineWidth: number,
): void {
  const start = projection.worldToCanvas(from.x, from.y);
  const end = projection.worldToCanvas(to.x, to.y);
  draw.strokeStyle = strokeStyle;
  draw.lineWidth = lineWidth;
  draw.beginPath();
  draw.moveTo(start.x, start.y);
  draw.lineTo(end.x, end.y);
  draw.stroke();
}

function worldRectPath(
  draw: CanvasRenderingContext2D,
  projection: DatapadMapProjection,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const corners = [
    projection.worldToCanvas(x, y),
    projection.worldToCanvas(x + width, y),
    projection.worldToCanvas(x + width, y + height),
    projection.worldToCanvas(x, y + height),
  ];
  draw.beginPath();
  draw.moveTo(corners[0]!.x, corners[0]!.y);
  for (const corner of corners.slice(1)) draw.lineTo(corner.x, corner.y);
  draw.closePath();
}

function strokeWorldRect(
  draw: CanvasRenderingContext2D,
  projection: DatapadMapProjection,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  worldRectPath(draw, projection, x, y, width, height);
  draw.stroke();
}

/** Sparse raw coordinate tag for the north-up grid. */
function drawWorldGridLabel(
  draw: CanvasRenderingContext2D,
  projection: DatapadMapProjection,
  line: WorldGridLine,
  size: number,
  color: string,
): void {
  const anchor = projection.worldToCanvas(line.from.x, line.from.y);
  if (line.axis === "x") {
    if (anchor.x < 0 || anchor.x > size) return;
    drawGridCoordinate(draw, `${line.coordinate}`, anchor.x + 3, Math.max(4, anchor.y + 4), size, color);
  } else {
    if (anchor.y < 0 || anchor.y > size) return;
    drawGridCoordinate(draw, `${line.coordinate}`, Math.max(4, anchor.x + 4), anchor.y + 3, size, color);
  }
}

/** Explicit compass rose: the same immutable orientation in both map modes. */
function drawMapCardinals(
  draw: CanvasRenderingContext2D,
  size: number,
  accent: string,
  dim: string,
): void {
  const inset = Math.max(10, size * 0.018);
  const center = size / 2;
  draw.save();
  draw.font = `600 ${Math.max(9, Math.round(size * 0.014))}px ui-monospace, monospace`;
  draw.textAlign = "center";
  draw.textBaseline = "middle";
  draw.shadowColor = "rgba(4, 6, 7, 0.95)";
  draw.shadowBlur = 3;
  draw.fillStyle = accent;
  draw.fillText("N", center, inset);
  draw.fillStyle = dim;
  draw.fillText("E", size - inset, center);
  draw.fillText("S", center, size - inset);
  draw.fillText("W", inset, center);
  draw.restore();
}

function drawGridCoordinate(
  draw: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  draw.fillStyle = withAlpha(color, 0.75);
  draw.font = `${Math.max(8, Math.round(size * 0.011))}px ui-monospace, monospace`;
  draw.textBaseline = "top";
  draw.shadowColor = "rgba(10, 8, 5, 0.9)";
  draw.shadowBlur = 3;
  draw.fillText(text, x, y);
  draw.shadowBlur = 0;
  draw.shadowColor = "transparent";
}

function describeStorm(event: WeatherEventView, tick: number, tickRateHz: number): StormReadout {
  const name = event.eventType.toUpperCase();
  // Absent magnitude = baseline register (matches storm.ts blind fallback) —
  // the readout must never claim SEV 100% (or 0%) for a baseline system.
  const magnitude = normalizedMagnitude(event.magnitude);
  const severity = `SEV ${Math.round(magnitude * 100)}%`;
  const phaseEnds = typeof event.phaseEndsAtTick === "number" ? event.phaseEndsAtTick : tick;
  const phaseLeft = formatTicks(Math.max(0, phaseEnds - tick), tickRateHz);
  const resolvesAt = typeof event.resolvesAtTick === "number" ? event.resolvesAtTick : phaseEnds;
  const clears = formatTicks(Math.max(0, resolvesAt - tick), tickRateHz);
  if (event.phase === "idle") {
    return { headline: "ATMOSPHERICS NOMINAL", detail: `NEXT SYSTEM ETA ${phaseLeft}`, tone: "idle" };
  }
  if (event.phase === "warning") {
    return {
      headline: `⚠ ${name} INBOUND`,
      detail: `${severity} · R${event.radiusCells} · LANDFALL ${phaseLeft} · CLEARS ${clears}`,
      tone: "warning",
    };
  }
  if (event.phase === "active") {
    return {
      headline: `${name} ACTIVE`,
      detail: `${severity} · R${event.radiusCells} · ${phaseLeft} REMAINING · CLEARS ${clears}`,
      tone: "active",
    };
  }
  return { headline: `${name} DISSIPATING`, detail: `CLEARS ${clears}`, tone: "decay" };
}

function drawStormZone(
  draw: CanvasRenderingContext2D,
  event: WeatherEventView,
  projection: DatapadMapProjection,
  timeMs: number,
): void {
  const center = projection.worldToCanvas(event.centerX, event.centerY);
  const cx = center.x;
  const cz = center.y;
  const radius = event.radiusCells * projection.scale;
  const magnitude = normalizedMagnitude(event.magnitude);
  const threat = `rgba(224, 138, 66, ${0.2 + magnitude * 0.2}`;

  if (event.phase === "warning") {
    // Dashed containment ring (dark underlay + amber, grid doctrine) + the
    // sweep heading the front arrives on.
    const pulse = 0.6 + 0.4 * Math.sin(timeMs * 0.004);
    draw.setLineDash([6, 5]);
    draw.strokeStyle = "rgba(40, 24, 8, 0.75)";
    draw.lineWidth = 3.4;
    draw.beginPath();
    draw.arc(cx, cz, radius, 0, Math.PI * 2);
    draw.stroke();
    draw.strokeStyle = `rgba(232, 178, 64, ${0.6 + 0.35 * pulse})`;
    draw.lineWidth = 1.8;
    draw.beginPath();
    draw.arc(cx, cz, radius, 0, Math.PI * 2);
    draw.stroke();
    draw.setLineDash([]);
    const heading = typeof event.sweepDirRad === "number" ? event.sweepDirRad : 0;
    const headingWorld = projection.worldToCanvas(
      event.centerX + Math.cos(heading),
      event.centerY + Math.sin(heading),
    );
    const headingX = headingWorld.x - cx;
    const headingY = headingWorld.y - cz;
    const headingLength = Math.max(0.001, Math.hypot(headingX, headingY));
    const ax = headingX / headingLength;
    const az = headingY / headingLength;
    const tail = 0.34 * radius;
    draw.strokeStyle = "rgba(40, 24, 8, 0.75)";
    draw.lineWidth = 3.2;
    draw.beginPath();
    draw.moveTo(cx - ax * (radius + tail), cz - az * (radius + tail));
    draw.lineTo(cx - ax * radius, cz - az * radius);
    draw.stroke();
    draw.strokeStyle = "rgba(232, 178, 64, 0.9)";
    draw.lineWidth = 1.6;
    draw.beginPath();
    draw.moveTo(cx - ax * (radius + tail), cz - az * (radius + tail));
    draw.lineTo(cx - ax * radius, cz - az * radius);
    draw.stroke();
    arrowHead(draw, cx - ax * radius, cz - az * radius, Math.atan2(az, ax), 7, "rgba(232, 178, 64, 0.9)");
  } else if (event.phase === "active") {
    draw.fillStyle = `${threat})`;
    draw.beginPath();
    draw.arc(cx, cz, radius, 0, Math.PI * 2);
    draw.fill();
    draw.strokeStyle = `rgba(120, 52, 20, ${0.7 + 0.3 * magnitude})`;
    draw.lineWidth = 2.5;
    draw.stroke();
    // Rotating inner gyre — the system is ALIVE on the scope.
    const spin = timeMs * 0.0006;
    draw.strokeStyle = "rgba(150, 70, 30, 0.6)";
    draw.lineWidth = 1.4;
    for (let i = 0; i < 3; i += 1) {
      const a0 = spin + (i * Math.PI * 2) / 3;
      draw.beginPath();
      draw.arc(cx, cz, radius * (0.35 + i * 0.18), a0, a0 + Math.PI * 1.2);
      draw.stroke();
    }
  } else {
    draw.strokeStyle = `rgba(200, 150, 90, ${0.3 * Math.max(0.15, event.intensity)})`;
    draw.lineWidth = 1.5;
    draw.beginPath();
    draw.arc(cx, cz, radius, 0, Math.PI * 2);
    draw.stroke();
  }
}

function arrowHead(draw: CanvasRenderingContext2D, x: number, y: number, angle: number, len: number, style: string): void {
  draw.strokeStyle = style;
  draw.beginPath();
  draw.moveTo(x, y);
  draw.lineTo(x - Math.cos(angle - 0.5) * len, y - Math.sin(angle - 0.5) * len);
  draw.moveTo(x, y);
  draw.lineTo(x - Math.cos(angle + 0.5) * len, y - Math.sin(angle + 0.5) * len);
  draw.stroke();
}

function dot(draw: CanvasRenderingContext2D, x: number, y: number, r: number, style: string): void {
  draw.fillStyle = style;
  draw.beginPath();
  draw.arc(x, y, r, 0, Math.PI * 2);
  draw.fill();
}

function diamond(draw: CanvasRenderingContext2D, x: number, y: number, r: number, style: string): void {
  draw.fillStyle = style;
  draw.beginPath();
  draw.moveTo(x, y - r);
  draw.lineTo(x + r, y);
  draw.lineTo(x, y + r);
  draw.lineTo(x - r, y);
  draw.closePath();
  draw.fill();
}

function drawWaypoints(
  draw: CanvasRenderingContext2D,
  areaId: string,
  projection: DatapadMapProjection,
  size: number,
  timeMs: number,
  accent: string,
  ink: string,
  hoverCellX: number,
  hoverCellY: number,
  playerX: number,
  playerY: number,
  labels: LabelPlacer,
  selectedId: string | null,
): void {
  const hoverActive = Number.isFinite(hoverCellX) && Number.isFinite(hoverCellY);
  const markerRadius = Math.max(3.2, size * 0.0055);
  const hoverRadiusCells = Math.max(4, 9 / Math.max(0.01, projection.scale));
  for (const waypoint of waypoints()) {
    if (waypoint.areaId !== areaId) continue;
    const wx = waypoint.x + 0.5;
    const wy = waypoint.y + 0.5;
    const point = projection.worldToCanvas(wx, wy);
    const selected = waypoint.id === selectedId;
    if (selected) {
      // Steady selection ring — distinct from the active pulse: selection is
      // a pointer state, activity is a navigation state; both can coexist.
      draw.strokeStyle = withAlpha("#ffffff", 0.85);
      draw.lineWidth = 1.2;
      draw.beginPath();
      draw.arc(point.x, point.y, markerRadius * 2.4, 0, Math.PI * 2);
      draw.stroke();
    }
    if (waypoint.active) {
      const pulse = 0.5 + 0.5 * Math.sin(timeMs * 0.0032);
      draw.strokeStyle = withAlpha(accent, 0.25 + 0.35 * pulse);
      draw.lineWidth = 1;
      draw.beginPath();
      draw.arc(point.x, point.y, markerRadius * (1.8 + pulse * 0.9), 0, Math.PI * 2);
      draw.stroke();
      diamond(draw, point.x, point.y, markerRadius + pulse * 0.9, withAlpha(accent, 0.82 + 0.16 * pulse));
      label(draw, waypoint.name.toUpperCase(), point.x, point.y - markerRadius * 2.2, accent, size, labels);
      continue;
    }
    hollowDiamond(draw, point.x, point.y, markerRadius, withAlpha(accent, 0.72));
    const hover = hoverActive && Math.hypot(wx - hoverCellX, wy - hoverCellY) <= hoverRadiusCells;
    const nearby = Math.hypot(wx - playerX, wy - playerY) <= 14;
    if (selected || hover || nearby) {
      label(draw, waypoint.name.toUpperCase(), point.x, point.y - markerRadius * 2.2, ink, size, labels);
    }
  }
}

function hollowDiamond(draw: CanvasRenderingContext2D, x: number, y: number, r: number, style: string): void {
  draw.strokeStyle = style;
  draw.lineWidth = 1.2;
  draw.beginPath();
  draw.moveTo(x, y - r);
  draw.lineTo(x + r, y);
  draw.lineTo(x, y + r);
  draw.lineTo(x - r, y);
  draw.closePath();
  draw.stroke();
}

/**
 * Marker-label collision ledger (fe-polish §1.12): each painted label books
 * its rect; the next label that would overprint an earlier one steps UP a
 * row (labels float above their markers, so up never covers the glyph).
 */
interface LabelPlacer {
  reserve(x: number, y: number, width: number, rowH: number): number;
}

/** Air between stacked label rows so 8px monospace glyphs + 3px shadow halos do not touch. */
const LABEL_ROW_CLEARANCE_PX = 3;

function createLabelPlacer(): LabelPlacer {
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  return {
    reserve(x, y, width, rowH) {
      const half = width / 2 + 3;
      let top = y - rowH;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const bottom = top + rowH;
        const collides = placed.some((rect) => x + half > rect.left && x - half < rect.right && bottom > rect.top && top < rect.bottom);
        if (!collides) break;
        // Keep first-seat baseline; later seats step by full row plus explicit clearance.
        top -= rowH + LABEL_ROW_CLEARANCE_PX;
      }
      placed.push({ left: x - half, right: x + half, top, bottom: top + rowH });
      return top + rowH;
    },
  };
}

/** "Travel Terminal — Dustgate" → "Dustgate"; no qualifier → unchanged. */
function placeQualifier(label: string): string {
  const dash = label.indexOf("—");
  if (dash < 0) return label;
  const qualifier = label.slice(dash + 1).trim();
  return qualifier.length > 0 ? qualifier : label;
}

function label(
  draw: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  size: number,
  labels?: LabelPlacer,
): void {
  const fontPx = Math.max(8, Math.round(size * 0.011));
  draw.font = `${fontPx}px ui-monospace, monospace`;
  const baselineY = labels
    ? labels.reserve(x, y, draw.measureText(text).width, fontPx + 3)
    : y;
  draw.textAlign = "center";
  // Dark backing halo: labels must survive bright sand and dark loam alike.
  draw.shadowColor = "rgba(10, 8, 5, 0.9)";
  draw.shadowBlur = 3;
  draw.fillStyle = withAlpha(color, 0.95);
  draw.fillText(text, x, baselineY);
  draw.shadowBlur = 0;
  draw.shadowColor = "transparent";
  draw.textAlign = "left";
}


function formatTicks(ticks: number, tickRateHz: number): string {
  const totalSeconds = Math.max(0, Math.round(ticks / tickRateHz));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

function withAlpha(color: string, alpha: number): string {
  // Theme tokens are hex; compose via color-mix-free rgba for canvas.
  if (color.startsWith("#")) {
    const clean = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color;
    const value = Number.parseInt(clean.slice(1, 7), 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`datapad map: missing data-ref="${name}"`);
  return el;
}
