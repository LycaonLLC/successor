import {
  Box3,
  BoxGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Mesh,
  type Object3D,
  type Scene,
} from "three";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { advanceCutawayFade, createCutawayState, sampleCutaway, type CutawayState } from "../props";
import { createBuildingMatcapTexture } from "./materials";
import { createBuildingModule, DOOR_SLIDE_DISTANCE_M, moduleKind, placeBuildingModule, type ModuleParts } from "./modules";
import type {
  BuildingCollision,
  BuildingGhostState,
  BuildingPalette,
  BuildingPickResult,
  BuildingProjection,
  CatalogId,
  GameBuildComponent,
  GameInteriorRegion,
} from "./types";

interface RuntimeComponent {
  component: GameBuildComponent;
  parts: ModuleParts;
  doorT: number;
  doorTarget: number;
  cutawayParts: Mesh[];
}

interface RuntimeInterior {
  region: GameInteriorRegion;
  bounds: { xMilli: number; yMilli: number; wMilli: number; hMilli: number };
  cutaway: CutawayState;
}



function buildingComponentIdFromObject(object: Object3D): string | undefined {
  let current: Object3D | null = object;
  while (current) {
    const componentId = current.userData.buildingComponentId;
    if (typeof componentId === "string") return componentId;
    current = current.parent;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function componentFromUnknown(value: unknown): GameBuildComponent | null {
  const row = asRecord(value);
  if (!row) return null;
  const componentId = row.component_id ?? row.componentId ?? row.id;
  const areaId = row.area_id ?? row.areaId;
  const catalogId = row.catalog_id ?? row.catalogId;
  const kind = row.kind;
  if (typeof componentId !== "string" || typeof areaId !== "string" || typeof catalogId !== "string") return null;
  if (typeof kind !== "string") return null;
  return {
    component_id: componentId,
    owner_actor_id: typeof row.owner_actor_id === "string"
      ? row.owner_actor_id
      : typeof row.ownerActorId === "string" ? row.ownerActorId : undefined,
    area_id: areaId,
    parcel_id: typeof row.parcel_id === "string"
      ? row.parcel_id
      : typeof row.parcelId === "string" ? row.parcelId : undefined,
    catalog_id: catalogId as CatalogId,
    kind: kind as GameBuildComponent["kind"],
    cell_x: readNumber(row.cell_x ?? row.cellX),
    cell_y: readNumber(row.cell_y ?? row.cellY),
    rotation_quarters: readNumber(row.rotation_quarters ?? row.rotationQuarters) % 4,
    palette: asRecord(row.palette) as GameBuildComponent["palette"],
    door_open: typeof row.door_open === "boolean" ? row.door_open : typeof row.doorOpen === "boolean" ? row.doorOpen : undefined,
  };
}

function regionFromUnknown(value: unknown): GameInteriorRegion | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = row.interior_id ?? row.interiorId ?? row.id;
  const areaId = row.area_id ?? row.areaId;
  if (typeof id !== "string" || typeof areaId !== "string") return null;
  const keys = row.cell_keys ?? row.cellKeys;
  if (!Array.isArray(keys)) return null;
  const doorIds = row.door_component_ids ?? row.doorComponentIds;
  return {
    interior_id: id,
    area_id: areaId,
    parcel_id: typeof row.parcel_id === "string"
      ? row.parcel_id
      : typeof row.parcelId === "string" ? row.parcelId : undefined,
    cell_keys: keys.filter((key): key is string => typeof key === "string"),
    roofed: row.roofed === true,
    enclosed: row.enclosed === true,
    door_component_ids: Array.isArray(doorIds) ? doorIds.filter((doorId): doorId is string => typeof doorId === "string") : undefined,
  };
}

function readProjection(_slice: SliceSnapshot, state: PlayState): BuildingProjection {
  const stateRecord = asRecord(state);
  const authority = asRecord(stateRecord?.serverAuthority);
  const building = asRecord(authority?.building);
  if (building?.schema !== "successor.authority-building.v1") {
    return { components: [], interiors: [], snapshotTick: 0 };
  }
  const rawComponents = Array.isArray(building.components) ? building.components : [];
  const rawRegions = Array.isArray(building.interiors) ? building.interiors : [];
  return {
    components: rawComponents.map(componentFromUnknown).filter((entry): entry is GameBuildComponent => entry !== null),
    interiors: rawRegions.map(regionFromUnknown).filter((entry): entry is GameInteriorRegion => entry !== null),
    snapshotTick: readNumber(building.tick),
  };
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function regionBounds(region: GameInteriorRegion): { xMilli: number; yMilli: number; wMilli: number; hMilli: number } | null {
  const cells: Array<[number, number]> = [];
  for (const key of region.cell_keys) {
    const pair = key.split(",").map(Number);
    if (pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) cells.push([pair[0]!, pair[1]!]);
  }
  if (cells.length === 0) return null;
  const minX = Math.min(...cells.map((pair) => pair[0]));
  const minY = Math.min(...cells.map((pair) => pair[1]));
  const maxX = Math.max(...cells.map((pair) => pair[0]));
  const maxY = Math.max(...cells.map((pair) => pair[1]));
  return { xMilli: minX * 1000, yMilli: minY * 1000, wMilli: (maxX - minX + 1) * 1000, hMilli: (maxY - minY + 1) * 1000 };
}

function componentBounds(component: GameBuildComponent): BuildingCollision {
  const edge = component.kind === "wall" || component.kind === "window" || component.kind === "door";
  const horizontal = component.rotation_quarters % 2 === 0;
  if (!edge) return { componentId: component.component_id, areaId: component.area_id, left: component.cell_x, top: component.cell_y, right: component.cell_x + 1, bottom: component.cell_y + 1, blocks: component.kind !== "floor" && component.kind !== "roof" };
  const thickness = 0.12;
  return horizontal
    ? { componentId: component.component_id, areaId: component.area_id, left: component.cell_x, top: component.cell_y - thickness / 2, right: component.cell_x + 1, bottom: component.cell_y + thickness / 2, blocks: component.kind !== "window" && component.kind !== "door" || component.door_open !== true }
    : { componentId: component.component_id, areaId: component.area_id, left: component.cell_x - thickness / 2, top: component.cell_y, right: component.cell_x + thickness / 2, bottom: component.cell_y + 1, blocks: component.kind !== "window" && component.kind !== "door" || component.door_open !== true };
}

/** Building modules own their geometry and per-module matcap materials
 *  (the shared matcap TEXTURE is renderer-owned and outlives modules). */
function disposeModuleObjects(root: Object3D): void {
  root.traverse((object) => {
    const value = object as Mesh;
    if (!value.isMesh) return;
    value.geometry.dispose();
    for (const material of Array.isArray(value.material) ? value.material : [value.material]) material.dispose();
  });
}

export class BuildingRenderer {
  readonly group = new Group();
  private readonly ghostGroup = new Group();
  private readonly overlayGroup = new Group();
  private readonly components = new Map<string, RuntimeComponent>();
  private readonly interiors = new Map<string, RuntimeInterior>();
  private readonly collisions = new Map<string, BuildingCollision>();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly pointerGround = new Vector3();
  private readonly scene: Scene;
  private readonly camera: Camera;
  private ghostParts: ModuleParts | null = null;
  private ghostSignature = "";
  private ghostState: BuildingGhostState = { active: false, catalogId: "floor_1x1", kind: "floor", cellX: 0, cellY: 0, rotation: 0, valid: false, reason: null };
  private projection: BuildingProjection = { components: [], interiors: [], snapshotTick: 0 };
  private cutawayInteriorIds: string[] = [];
  private doorSlide = new Map<string, number>();
  /** Shared unlit matcap for every building module; null in DOM-less tests. */
  private readonly matcap = createBuildingMatcapTexture();

  constructor(scene: Scene, camera: Camera) {
    this.scene = scene;
    this.camera = camera;
    this.group.name = "authority-buildings";
    this.ghostGroup.name = "building-ghost";
    this.overlayGroup.name = "building-cell-overlay";
    scene.add(this.group, this.ghostGroup, this.overlayGroup);
  }

  update(slice: SliceSnapshot, state: PlayState, dtSeconds: number): void {
    this.projection = readProjection(slice, state);
    this.reconcileComponents(this.projection.components.filter((component) => component.area_id === state.activeAreaId));
    this.reconcileInteriors(this.projection.interiors.filter((region) => region.area_id === state.activeAreaId));
    this.updateCutaway(state, dtSeconds);
    this.advanceDoors(dtSeconds);
  }

  setGhost(state: BuildingGhostState, palette: BuildingPalette): void {
    this.ghostState = state;
    if (!state.active) {
      this.ghostGroup.visible = false;
      this.overlayGroup.visible = false;
      return;
    }
    this.ghostGroup.visible = true;
    this.overlayGroup.visible = true;
    const signature = `${state.catalogId}:${state.cellX}:${state.cellY}:${state.rotation}:${state.valid}:${palette.primary}:${palette.secondary}:${palette.accent}`;
    if (signature !== this.ghostSignature) {
      if (this.ghostParts) disposeModuleObjects(this.ghostParts.root);
      this.ghostGroup.clear();
      const component: GameBuildComponent = { component_id: "ghost", area_id: "ghost", catalog_id: state.catalogId, kind: state.kind, cell_x: state.cellX, cell_y: state.cellY, rotation_quarters: state.rotation, palette };
      this.ghostParts = createBuildingModule(component, palette, true, state.valid, this.matcap);
      placeBuildingModule(this.ghostParts, component);
      this.ghostGroup.add(this.ghostParts.root);
      this.ghostSignature = signature;
      this.rebuildOverlay(component, state.valid);
    }
  }

  updateGhostFromScreen(screenX: number, screenY: number, ground: Vector3 | null, state: BuildingGhostState, palette: BuildingPalette): BuildingGhostState {
    const point = ground ?? this.pointerGround;
    if (!ground) this.ghostState = { ...state, active: false, valid: false, reason: "Pointer is outside the world" };
    else this.ghostState = { ...state, active: true, cellX: Math.floor(point.x), cellY: Math.floor(point.z) };
    this.setGhost(this.ghostState, palette);
    return this.ghostState;
  }

  pickAtScreenPoint(screenX: number, screenY: number, width: number, height: number): BuildingPickResult | null {
    this.pointer.set((screenX / Math.max(1, width)) * 2 - 1, -(screenY / Math.max(1, height)) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const id = this.raycaster
      .intersectObjects(this.group.children, true)
      .map((entry) => buildingComponentIdFromObject(entry.object))
      .find((componentId): componentId is string => componentId !== undefined);
    if (!id) return null;
    const component = this.components.get(id)?.component;
    if (!component) return null;
    return { componentId: id, catalogId: component.catalog_id, kind: moduleKind(component), cellX: component.cell_x, cellY: component.cell_y };
  }

  collisionsNear(areaId: string, x: number, z: number, radius: number, out: BuildingCollision[] = []): number {
    out.length = 0;
    for (const collision of this.collisions.values()) {
      if (collision.areaId !== areaId || !collision.blocks) continue;
      if (x + radius < collision.left || x - radius > collision.right || z + radius < collision.top || z - radius > collision.bottom) continue;
      out.push(collision);
    }
    return out.length;
  }

  projected(): BuildingProjection { return this.projection; }
  ghost(): BuildingGhostState { return { ...this.ghostState }; }
  debug(): { componentCount: number; ghost: BuildingGhostState; collisions: number; cutawayInteriorIds: string[]; doorSlide: Record<string, number> } {
    return { componentCount: this.components.size, ghost: this.ghost(), collisions: this.collisions.size, cutawayInteriorIds: [...this.cutawayInteriorIds], doorSlide: Object.fromEntries(this.doorSlide) };
  }

  dispose(): void {
    for (const runtime of this.components.values()) disposeModuleObjects(runtime.parts.root);
    if (this.ghostParts) disposeModuleObjects(this.ghostParts.root);
    this.ghostParts = null;
    this.group.clear();
    this.ghostGroup.clear();
    this.overlayGroup.clear();
    this.components.clear();
    this.interiors.clear();
    this.collisions.clear();
    this.matcap?.dispose();
  }

  private reconcileComponents(next: readonly GameBuildComponent[]): void {
    const seen = new Set<string>();
    for (const component of next) {
      seen.add(component.component_id);
      const existing = this.components.get(component.component_id);
      if (!existing || existing.component.catalog_id !== component.catalog_id || existing.component.rotation_quarters !== component.rotation_quarters) {
        if (existing) {
          this.group.remove(existing.parts.root);
          disposeModuleObjects(existing.parts.root);
        }
        const parts = createBuildingModule(component, component.palette, false, true, this.matcap);
        placeBuildingModule(parts, component);
        this.group.add(parts.root);
        this.components.set(component.component_id, { component, parts, doorT: component.door_open ? 1 : 0, doorTarget: component.door_open ? 1 : 0, cutawayParts: parts.fadeMeshes });
      } else {
        existing.component = component;
        placeBuildingModule(existing.parts, component);
        existing.doorTarget = component.door_open === true ? 1 : 0;
      }
      this.collisions.set(component.component_id, componentBounds(component));
    }
    for (const [id, runtime] of this.components) {
      if (seen.has(id)) continue;
      this.group.remove(runtime.parts.root);
      disposeModuleObjects(runtime.parts.root);
      this.components.delete(id);
      this.collisions.delete(id);
      this.doorSlide.delete(id);
    }
  }

  private reconcileInteriors(next: readonly GameInteriorRegion[]): void {
    const seen = new Set<string>();
    for (const region of next) {
      const bounds = regionBounds(region);
      if (!bounds) continue;
      seen.add(region.interior_id);
      const existing = this.interiors.get(region.interior_id);
      if (existing) existing.region = region;
      else this.interiors.set(region.interior_id, { region, bounds, cutaway: createCutawayState() });
    }
    for (const id of this.interiors.keys()) if (!seen.has(id)) this.interiors.delete(id);
  }

  private updateCutaway(state: PlayState, dtSeconds: number): void {
    const player = state.serverAuthority.authoritativePlayer;
    const xMilli = readNumber(player?.x, state.player.x) * 1000;
    const zMilli = readNumber(player?.y, state.player.y) * 1000;
    this.cutawayInteriorIds = [];
    for (const interior of this.interiors.values()) {
      if (!interior.region.enclosed || !interior.region.roofed) continue;
      sampleCutaway(interior.cutaway, this.projection.snapshotTick, [interior.bounds], xMilli, zMilli);
      const hidden = advanceCutawayFade(interior.cutaway, dtSeconds, 0.25, false);
      if (interior.cutaway.inside) this.cutawayInteriorIds.push(interior.region.interior_id);
      const cells = new Set(interior.region.cell_keys);
      for (const runtime of this.components.values()) {
        const component = runtime.component;
        const belongs = cells.has(cellKey(component.cell_x, component.cell_y));
        const hide = belongs && hidden > 0 && (component.kind === "roof" || ((component.kind === "wall" || component.kind === "window") && [1, 2].includes(((component.rotation_quarters % 4) + 4) % 4)));
        for (const mesh of runtime.cutawayParts) {
          if (hide) {
            mesh.visible = hidden < 1;
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              material.transparent = true;
              material.opacity = 1 - hidden;
              material.depthWrite = false;
            }
          } else {
            mesh.visible = true;
          }
        }
      }
    }
  }

  private advanceDoors(dtSeconds: number): void {
    const step = Math.max(0, Math.min(0.1, dtSeconds)) / 0.8;
    for (const [id, runtime] of this.components) {
      if (runtime.component.kind !== "door" || !runtime.parts.doorNode) continue;
      runtime.doorT = runtime.doorT < runtime.doorTarget ? Math.min(runtime.doorTarget, runtime.doorT + step) : Math.max(runtime.doorTarget, runtime.doorT - step);
      runtime.parts.doorNode.position.x = runtime.doorT * DOOR_SLIDE_DISTANCE_M;
      this.doorSlide.set(id, runtime.doorT);
    }
  }

  private rebuildOverlay(component: GameBuildComponent, valid: boolean): void {
    this.overlayGroup.clear();
    const color = new Color(valid ? "#4ddc85" : "#df5360");
    const material = new LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false });
    const edge = component.kind === "wall" || component.kind === "window" || component.kind === "door";
    const geometry = edge ? new BoxGeometry(1.04, 0.02, 0.16) : new BoxGeometry(1.04, 0.02, 1.04);
    const line = new LineSegments(geometry, material);
    line.position.set(component.cell_x + 0.5, 0.025, component.cell_y + 0.5);
    line.rotation.y = -(component.rotation_quarters % 4) * Math.PI / 2;
    this.overlayGroup.add(line);
  }
}
