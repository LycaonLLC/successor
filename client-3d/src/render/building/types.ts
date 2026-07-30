import type { Object3D, Scene, Vector3 } from "three";

export type BuildingKind = "floor" | "wall" | "door" | "window" | "roof";
export type CatalogId = "floor_1x1" | "wall_1m" | "door_slide_1m" | "window_1m" | "roof_1x1" | (string & {});
export type RotationQuarter = 0 | 1 | 2 | 3;

export interface BuildingPalette {
  primary?: string;
  secondary?: string;
  accent?: string;
}

export interface GameBuildComponent {
  component_id: string;
  owner_actor_id?: string;
  area_id: string;
  parcel_id?: string;
  catalog_id: CatalogId;
  kind: BuildingKind;
  cell_x: number;
  cell_y: number;
  rotation_quarters: number;
  palette?: BuildingPalette | null;
  door_open?: boolean;
}

export interface GameInteriorRegion {
  interior_id: string;
  area_id: string;
  parcel_id?: string;
  cell_keys: string[];
  roofed: boolean;
  enclosed: boolean;
  door_component_ids?: string[];
}

export interface BuildingProjection {
  components: readonly GameBuildComponent[];
  interiors: readonly GameInteriorRegion[];
  snapshotTick: number;
}

export interface BuildingCollision {
  componentId: string;
  areaId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  blocks: boolean;
}

export interface BuildingPickResult {
  componentId: string;
  catalogId: CatalogId;
  kind: BuildingKind;
  cellX: number;
  cellY: number;
}

export interface BuildingGhostState {
  active: boolean;
  catalogId: CatalogId;
  kind: BuildingKind;
  cellX: number;
  cellY: number;
  rotation: RotationQuarter;
  valid: boolean;
  reason: string | null;
}

export type BuildingTool = "place" | "remove";

export interface BuildingControllerSnapshot {
  active: boolean;
  tool: BuildingTool;
  catalogId: CatalogId;
  rotation: RotationQuarter;
  palette: BuildingPalette;
  ghost: BuildingGhostState;
  selectedComponentId: string | null;
  hover: BuildingPickResult | null;
}

export interface BuildingControllerCallbacks {
  onPlace?: (command: { catalog_id: CatalogId; cell_x: number; cell_y: number; rotation_quarters: RotationQuarter; palette: BuildingPalette }) => void;
  onRemove?: (componentId: string) => void;
  onToggleDoor?: (componentId: string) => void;
  canPlace?: (command: { catalog_id: CatalogId; cell_x: number; cell_y: number; rotation_quarters: RotationQuarter; palette: BuildingPalette }) => { valid: boolean; reason?: string };
}

export interface BuildingRendererHost {
  scene: Scene;
  screenToGround: (screenX: number, screenY: number, target?: Vector3) => Vector3 | null;
  width: () => number;
  height: () => number;
}

export type BuildingSnapshotListener = (snapshot: BuildingControllerSnapshot) => void;

export interface BuildingRendererDebug {
  componentCount: number;
  ghost: BuildingGhostState;
  collisions: number;
  cutawayInteriorIds: string[];
  doorSlide: Record<string, number>;
}

export interface BuildingRenderable extends Object3D {
  userData: { buildingComponentId?: string; buildingKind?: BuildingKind; buildingPart?: "floor" | "wall" | "door" | "window" | "roof" | "trim" };
}
