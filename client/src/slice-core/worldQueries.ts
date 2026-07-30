import { appendCampMovementBlockers } from "./campSystem";
import { cellKey } from "./geometry";
import type { ServerAuthorityPlacedCampState } from "./gameState";
import type { AreaSnapshot, AreaTransitionSnapshot, BlockedCellSnapshot, PropSnapshot } from "./worldTypes";
import type { MovementBlocker } from "./movementSystem";

export interface WorldSliceLike {
  zone: {
    name: string;
    width: number;
    height: number;
    level: number;
  };
  areas: AreaSnapshot[];
  props: PropSnapshot[];
  transitions: AreaTransitionSnapshot[];
  blockedCells: BlockedCellSnapshot[];
}

export function currentArea(slice: Pick<WorldSliceLike, "areas" | "zone">, state: { activeAreaId: string }): AreaSnapshot {
  const area = slice.areas.find((candidate) => candidate.id === state.activeAreaId);
  if (area) return area;
  const firstArea = slice.areas[0];
  if (firstArea) return firstArea;
  const zone = slice.zone;
  return {
    id: "default",
    name: zone.name,
    kind: "overworld",
    width: zone.width,
    height: zone.height,
    level: zone.level,
  };
}

export function propsForArea(slice: Pick<WorldSliceLike, "props">, areaId: string): PropSnapshot[] {
  return slice.props.filter((prop) => prop.areaId === areaId);
}

export function transitionsForArea(slice: Pick<WorldSliceLike, "transitions">, areaId: string): AreaTransitionSnapshot[] {
  return slice.transitions.filter((transition) => transition.fromAreaId === areaId);
}

export function buildBlockedCells(slice: Pick<WorldSliceLike, "blockedCells" | "props">, areaId: string): Set<string> {
  const cells = new Set<string>();
  for (const cell of slice.blockedCells) {
    if (cell.areaId === areaId) cells.add(cellKey(cell));
  }
  for (const prop of propsForArea(slice, areaId)) {
    if (prop.kind === "sign" || prop.solid === false) continue;
    for (let y = prop.cell.y; y < prop.cell.y + prop.size.h; y += 1) {
      for (let x = prop.cell.x; x < prop.cell.x + prop.size.w; x += 1) {
        cells.add(`${x},${y}`);
      }
    }
  }
  return cells;
}

export function buildMovementBlockers(
  slice: Pick<WorldSliceLike, "areas" | "props">,
  areaId: string,
  propStates: Record<string, { doorOpen?: boolean }> = {},
  placedCamps: readonly ServerAuthorityPlacedCampState[] = [],
): MovementBlocker[] {
  const area = slice.areas.find((candidate) => candidate.id === areaId);
  if (!area) return [];
  const blockers: MovementBlocker[] = [];
  for (const prop of propsForArea(slice, areaId)) {
    const propWidth = Math.max(1, Math.min(prop.size.w, area.width));
    const propHeight = Math.max(1, Math.min(prop.size.h, area.height));
    if (Array.isArray(prop.collisionBounds)) {
      for (const bounds of prop.collisionBounds) {
        addMovementBlocker(blockers, prop, area, propWidth, propHeight, bounds);
      }
    }
    if (prop.door && propStates[prop.id]?.doorOpen !== true) {
      addMovementBlocker(blockers, prop, area, propWidth, propHeight, prop.door.blocker);
    }
  }
  appendCampMovementBlockers(blockers, placedCamps, areaId);
  return blockers;
}

function addMovementBlocker(
  blockers: MovementBlocker[],
  prop: PropSnapshot,
  area: AreaSnapshot,
  propWidth: number,
  propHeight: number,
  bounds: { xMilli: number; yMilli: number; wMilli: number; hMilli: number },
): void {
  const localLeft = clampNumber(bounds.xMilli / 1000, 0, propWidth);
  const localTop = clampNumber(bounds.yMilli / 1000, 0, propHeight);
  const localRight = clampNumber(localLeft + Math.max(0, bounds.wMilli) / 1000, 0, propWidth);
  const localBottom = clampNumber(localTop + Math.max(0, bounds.hMilli) / 1000, 0, propHeight);
  const left = clampNumber(prop.cell.x + localLeft, 0, area.width);
  const top = clampNumber(prop.cell.y + localTop, 0, area.height);
  const right = clampNumber(prop.cell.x + localRight, 0, area.width);
  const bottom = clampNumber(prop.cell.y + localBottom, 0, area.height);
  if (right <= left || bottom <= top) return;
  blockers.push({ left, top, right, bottom });
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
