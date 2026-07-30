import type { Vector3 } from "three";
import type { BuildingRenderer } from "./renderer";
import type {
  BuildingControllerCallbacks,
  BuildingControllerSnapshot,
  BuildingGhostState,
  BuildingPickResult,
  BuildingPalette,
  BuildingSnapshotListener,
  BuildingTool,
  CatalogId,
  RotationQuarter,
} from "./types";
import { DEFAULT_BUILDING_PALETTE } from "./materials";

const KIND_BY_CATALOG: Record<string, BuildingGhostState["kind"]> = {
  floor_1x1: "floor",
  wall_1m: "wall",
  door_slide_1m: "door",
  window_1m: "window",
  roof_1x1: "roof",
};

function normalizeRotation(value: number): RotationQuarter {
  return (((value % 4) + 4) % 4) as RotationQuarter;
}

export class BuildingController {
  private activeState = false;
  private toolState: BuildingTool = "place";
  private catalogState: CatalogId = "floor_1x1";
  private rotationState: RotationQuarter = 0;
  private paletteState: BuildingPalette = { ...DEFAULT_BUILDING_PALETTE };
  private ghostState: BuildingGhostState = { active: false, catalogId: this.catalogState, kind: "floor", cellX: 0, cellY: 0, rotation: 0, valid: false, reason: null };
  private selectedComponent: string | null = null;
  private hoverResult: BuildingPickResult | null = null;
  private readonly listeners = new Set<BuildingSnapshotListener>();

  constructor(private readonly renderer: BuildingRenderer, private readonly callbacks: BuildingControllerCallbacks = {}) {}

  activate(): void {
    this.activeState = true;
    this.ghostState = { ...this.ghostState, active: true, catalogId: this.catalogState, kind: KIND_BY_CATALOG[this.catalogState] ?? "wall", rotation: this.rotationState };
    this.publish();
  }
  isActive(): boolean {
    return this.activeState;
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.activeState) return false;
    if (event.code === "Escape") {
      this.deactivate();
      return true;
    }
    if (event.code === "KeyR") {
      if (!event.repeat) this.rotate();
      return true;
    }
    if (event.code === "Delete" || event.code === "Backspace") {
      this.setTool("remove");
      return true;
    }
    return false;
  }

  deactivate(): void {
    this.activeState = false;
    this.ghostState = { ...this.ghostState, active: false };
    this.renderer.setGhost(this.ghostState, this.paletteState);
    this.hoverResult = null;
    this.selectedComponent = null;
    this.publish();
  }

  selectCatalog(catalogId: CatalogId): void {
    this.catalogState = catalogId;
    this.ghostState = { ...this.ghostState, catalogId, kind: KIND_BY_CATALOG[catalogId] ?? "wall", rotation: this.rotationState };
    this.refreshValidity();
    this.publish();
  }

  rotate(rotation?: RotationQuarter): void {
    this.rotationState = rotation === undefined ? normalizeRotation(this.rotationState + 1) : normalizeRotation(rotation);
    this.ghostState = { ...this.ghostState, rotation: this.rotationState };
    this.refreshValidity();
    this.publish();
  }

  setTool(tool: BuildingTool): void {
    this.toolState = tool;
    this.publish();
  }

  setPalette(palette: BuildingPalette): void {
    this.paletteState = { ...this.paletteState, ...palette };
    this.renderer.setGhost(this.ghostState, this.paletteState);
    this.publish();
  }

  updatePointer(screenX: number, screenY: number, ground: Vector3 | null): void {
    if (!this.activeState) return;
    this.ghostState = this.renderer.updateGhostFromScreen(screenX, screenY, ground, this.ghostState, this.paletteState);
    this.refreshValidity();
    this.publish();
  }

  pointerDown(screenX: number, screenY: number, button: number, width: number, height: number): boolean {
    if (!this.activeState) return false;
    if (button === 0 && this.toolState === "place") {
      if (!this.ghostState.valid) return true;
      this.callbacks.onPlace?.({ catalog_id: this.catalogState, cell_x: this.ghostState.cellX, cell_y: this.ghostState.cellY, rotation_quarters: this.rotationState, palette: { ...this.paletteState } });
      return true;
    }
    const hit = this.renderer.pickAtScreenPoint(screenX, screenY, width, height);
    if (button === 0 && this.toolState === "remove") {
      this.selectedComponent = hit?.componentId ?? null;
      if (hit) this.callbacks.onRemove?.(hit.componentId);
      this.publish();
      return true;
    }
    if (button === 2 && hit?.kind === "door") {
      this.callbacks.onToggleDoor?.(hit.componentId);
      return true;
    }
    return true;
  }

  hover(screenX: number, screenY: number, width: number, height: number): BuildingPickResult | null {
    if (!this.activeState) return null;
    this.hoverResult = this.renderer.pickAtScreenPoint(screenX, screenY, width, height);
    this.publish();
    return this.hoverResult;
  }

  snapshot(): BuildingControllerSnapshot {
    return {
      active: this.activeState,
      tool: this.toolState,
      catalogId: this.catalogState,
      rotation: this.rotationState,
      palette: { ...this.paletteState },
      ghost: { ...this.ghostState },
      selectedComponentId: this.selectedComponent,
      hover: this.hoverResult,
    };
  }

  subscribe(listener: BuildingSnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private refreshValidity(): void {
    if (!this.activeState) return;
    const command = { catalog_id: this.catalogState, cell_x: this.ghostState.cellX, cell_y: this.ghostState.cellY, rotation_quarters: this.rotationState, palette: { ...this.paletteState } };
    const result = this.callbacks.canPlace?.(command);
    this.ghostState = { ...this.ghostState, valid: result?.valid ?? true, reason: result?.valid === false ? result.reason ?? "Placement is not valid" : null };
    this.renderer.setGhost(this.ghostState, this.paletteState);
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
