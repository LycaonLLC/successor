import type { Cell, CellSize } from "./geometry";
import type { CoverProfile } from "./coverSystem";

export interface AreaSnapshot {
  id: string;
  name: string;
  kind: "overworld" | "public_interior" | string;
  width: number;
  height: number;
  level: number;
  biome?: "desert" | "forest" | string;
}

export interface AreaTransitionSnapshot {
  id: string;
  label: string;
  style: string;
  fromAreaId: string;
  fromCell: Cell;
  triggerSize: CellSize;
  toAreaId: string;
  toCell: Cell;
  toFacing: string;
}

export interface CloneFacilitySnapshot {
  id: string;
  label: string;
  areaId: string;
  respawnCell: Cell;
  respawnFacing: string;
  sicknessDurationMs: number;
}


export interface ForegroundLinePoint {
  x: number;
  y: number;
}

export interface ForegroundLine {
  points: ForegroundLinePoint[];
}

export interface CollisionBounds {
  xMilli: number;
  yMilli: number;
  wMilli: number;
  hMilli: number;
}

export interface PropDoorMetadata {
  blocker: CollisionBounds;
  interactRadiusCells?: number;
}

export interface EnterableInteriorBounds extends CollisionBounds {
  /** Optional authored region label (diagnostics only). */
  id?: string;
}

export interface EnterablePropMetadata {
  /** Authored top surface in runtime world units. */
  floorHeightM: number;
  /**
   * Explicit interior regions in POST-ROTATION prop-local milli-cells:
   * local = (world - prop.cell) * 1000, with no additional yaw applied.
   * Optional; legacy enterables without bounds fall back to the footprint.
   */
  interiorBounds?: EnterableInteriorBounds[];
}

export interface PropSnapshot {
  id: string;
  entity: string;
  areaId: string;
  label: string;
  kind: string;
  assetKey?: string;
  cell: Cell;
  size: CellSize;
  preserveSize?: boolean;
  interactive: boolean;
  solid?: boolean;
  visible?: boolean;
  shelter?: boolean;
  enterable?: EnterablePropMetadata;
  rotation?: 0 | 90 | 180 | 270;
  fillAssetKeys?: string[];
  fillSeed?: number;
  fillTexture?: string;
  foregroundCells?: Cell[];
  collisionBounds?: CollisionBounds[];
  door?: PropDoorMetadata;
  foregroundLine?: ForegroundLine;
  foregroundLines?: ForegroundLine[];
  cover?: CoverProfile;
  /** Authored loot container identity; absent on legacy props. */
  container?: string;
  /** Loot is take-only; deposit is never offered by this client. */
  takeOnly?: boolean;
}

export interface BlockedCellSnapshot extends Cell {
  areaId: string;
}
