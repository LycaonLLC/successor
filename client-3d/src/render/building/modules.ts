import { BoxGeometry, Group, Mesh, type Material, type Object3D, type Texture } from "three";
import { createBuildingMaterials } from "./materials";
import type { BuildingKind, BuildingPalette, GameBuildComponent } from "./types";

export interface ModuleParts {
  root: Group;
  fadeMeshes: Mesh[];
  doorNode: Object3D | null;
  edgeOrientation: number | null;
}

/**
 * Accepted meter contract (homebuilder-wave-20260719 BATCH_CONTRACT.json):
 * 1m structural cell, 2.5m walls, 0.16m wall thickness, 0.12m floor slab,
 * 0.14m roof slab. A 1.7m pawn (config.pawn.height) standing on the floor
 * slab tops out at 1.82m — well under the 2.5m roof underside. The grid
 * stays 1m; only the vertical dimensions grew to the contract.
 */
export const BUILDING_CELL_M = 1;
export const WALL_HEIGHT_M = 2.5;
export const WALL_THICKNESS_M = 0.16;
export const FLOOR_THICKNESS_M = 0.12;
export const ROOF_THICKNESS_M = 0.14;
/** Door reads as a framed opening: 0.9m clear width, 2.1m clear height. */
export const DOOR_OPENING_WIDTH_M = 0.9;
export const DOOR_OPENING_HEIGHT_M = 2.1;
/** Slide distance for the door leaf — clears the full opening (leaf runs
 *  along the interior wall face like a pocket door). renderer.advanceDoors
 *  multiplies doorT (0..1) by this. */
export const DOOR_SLIDE_DISTANCE_M = 0.92;
/** Window opening: 0.95m sill, 1.95m head, 0.72m clear width. */
export const WINDOW_SILL_M = 0.95;
export const WINDOW_HEAD_M = 1.95;
export const WINDOW_OPENING_WIDTH_M = 0.72;

/** Wall meshes sit on the -Z cell edge; root rotation orients them. */
const WALL_EDGE_Z = -0.5;

function mesh(geometry: BoxGeometry, material: Material | Material[], part: "floor" | "wall" | "door" | "window" | "roof" | "trim"): Mesh {
  const value = new Mesh(geometry, material);
  value.userData.buildingPart = part;
  return value;
}

function effectiveKind(component: GameBuildComponent): BuildingKind {
  if (component.kind) return component.kind;
  if (component.catalog_id.startsWith("floor")) return "floor";
  if (component.catalog_id.startsWith("roof")) return "roof";
  if (component.catalog_id.startsWith("door")) return "door";
  if (component.catalog_id.startsWith("window")) return "window";
  return "wall";
}

export function createBuildingModule(
  component: GameBuildComponent,
  palette?: BuildingPalette | null,
  ghost = false,
  valid = true,
  matcap: Texture | null = null,
): ModuleParts {
  const materials = createBuildingMaterials(palette, ghost, valid, matcap);
  const root = new Group();
  const kind = effectiveKind(component);
  const rotation = ((component.rotation_quarters % 4) + 4) % 4;
  root.rotation.y = -rotation * Math.PI / 2;
  root.userData.buildingComponentId = component.component_id;
  root.userData.buildingKind = kind;
  const fadeMeshes: Mesh[] = [];
  let doorNode: Object3D | null = null;
  let edgeOrientation: number | null = null;

  if (kind === "floor") {
    const slab = mesh(new BoxGeometry(0.98, FLOOR_THICKNESS_M, 0.98), materials.primary, "floor");
    slab.position.y = FLOOR_THICKNESS_M / 2;
    root.add(slab);
    // Secondary seam skirt under the inset slab — adjacent floor cells read
    // as tiles (grout line) instead of one fused plane at iso distance.
    const seam = mesh(new BoxGeometry(1, 0.02, 1), materials.secondary, "trim");
    seam.position.y = 0.01;
    root.add(seam);
  } else if (kind === "roof") {
    const slab = mesh(new BoxGeometry(1.02, ROOF_THICKNESS_M, 1.02), materials.primary, "roof");
    slab.position.y = WALL_HEIGHT_M + ROOF_THICKNESS_M / 2;
    root.add(slab);
    fadeMeshes.push(slab);
    // Fascia band around the slab top edge — accent zone, tops out exactly
    // at WALL_HEIGHT_M + ROOF_THICKNESS_M so roof world bounds stay honest.
    const fascia = mesh(new BoxGeometry(1.06, 0.06, 1.06), materials.accent, "trim");
    fascia.position.y = WALL_HEIGHT_M + ROOF_THICKNESS_M - 0.03;
    root.add(fascia);
    fadeMeshes.push(fascia);
  } else {
    edgeOrientation = rotation;
    const addEdge = (m: Mesh, x: number, y: number, z = WALL_EDGE_Z): Mesh => {
      m.position.set(x, y, z);
      root.add(m);
      fadeMeshes.push(m);
      return m;
    };
    // Accent cap rail along the wall top (top flush at WALL_HEIGHT_M).
    addEdge(mesh(new BoxGeometry(1, 0.07, WALL_THICKNESS_M + 0.02), materials.accent, "trim"), 0, WALL_HEIGHT_M - 0.035);

    if (kind === "wall") {
      addEdge(mesh(new BoxGeometry(1, WALL_HEIGHT_M, WALL_THICKNESS_M), materials.primary, "wall"), 0, WALL_HEIGHT_M / 2);
      // Worn base plinth — secondary zone, grounds the wall at iso distance.
      addEdge(mesh(new BoxGeometry(1, 0.18, WALL_THICKNESS_M + 0.02), materials.secondary, "trim"), 0, 0.09);
    } else if (kind === "window") {
      // Real opening: wall below the sill, wall above the head, jambs at the
      // sides, and a thin glazing pane recessed in the frame — never a solid
      // full-thickness panel across the opening.
      const jambWidth = (1 - WINDOW_OPENING_WIDTH_M) / 2;
      const openingHeight = WINDOW_HEAD_M - WINDOW_SILL_M;
      const openingCenterY = (WINDOW_SILL_M + WINDOW_HEAD_M) / 2;
      addEdge(mesh(new BoxGeometry(1, WINDOW_SILL_M, WALL_THICKNESS_M), materials.primary, "wall"), 0, WINDOW_SILL_M / 2);
      addEdge(mesh(new BoxGeometry(1, WALL_HEIGHT_M - WINDOW_HEAD_M, WALL_THICKNESS_M), materials.primary, "wall"), 0, (WINDOW_HEAD_M + WALL_HEIGHT_M) / 2);
      addEdge(mesh(new BoxGeometry(jambWidth, openingHeight, WALL_THICKNESS_M), materials.primary, "wall"), -(0.5 - jambWidth / 2), openingCenterY);
      addEdge(mesh(new BoxGeometry(jambWidth, openingHeight, WALL_THICKNESS_M), materials.primary, "wall"), 0.5 - jambWidth / 2, openingCenterY);
      // Protruding accent sill ledge just below the opening.
      addEdge(mesh(new BoxGeometry(WINDOW_OPENING_WIDTH_M + 0.08, 0.05, WALL_THICKNESS_M + 0.06), materials.accent, "trim"), 0, WINDOW_SILL_M - 0.025);
      addEdge(mesh(new BoxGeometry(WINDOW_OPENING_WIDTH_M, openingHeight, 0.04), materials.secondary, "window"), 0, openingCenterY);
    } else {
      // Door: framed opening (jambs + header) with a sliding leaf riding the
      // interior wall face. The leaf is doorNode — renderer.advanceDoors
      // slides it +X by doorT * DOOR_SLIDE_DISTANCE_M.
      const jambWidth = (1 - DOOR_OPENING_WIDTH_M) / 2;
      addEdge(mesh(new BoxGeometry(jambWidth, DOOR_OPENING_HEIGHT_M, WALL_THICKNESS_M), materials.primary, "wall"), -(0.5 - jambWidth / 2), DOOR_OPENING_HEIGHT_M / 2);
      addEdge(mesh(new BoxGeometry(jambWidth, DOOR_OPENING_HEIGHT_M, WALL_THICKNESS_M), materials.primary, "wall"), 0.5 - jambWidth / 2, DOOR_OPENING_HEIGHT_M / 2);
      addEdge(mesh(new BoxGeometry(1, WALL_HEIGHT_M - DOOR_OPENING_HEIGHT_M, WALL_THICKNESS_M), materials.primary, "wall"), 0, (DOOR_OPENING_HEIGHT_M + WALL_HEIGHT_M) / 2);
      const leaf = mesh(new BoxGeometry(DOOR_OPENING_WIDTH_M - 0.02, DOOR_OPENING_HEIGHT_M - 0.08, 0.06), materials.secondary, "door");
      // Interior face: wall spans z −0.58..−0.42; the leaf hugs −0.42..−0.36
      // so it clears the jambs when sliding open.
      leaf.position.set(0, (DOOR_OPENING_HEIGHT_M - 0.08) / 2 + 0.02, WALL_EDGE_Z + WALL_THICKNESS_M / 2 + 0.03);
      const handle = mesh(new BoxGeometry(0.04, 0.5, 0.03), materials.accent, "trim");
      handle.position.set(-(DOOR_OPENING_WIDTH_M / 2 - 0.09), 0, 0.045);
      leaf.add(handle);
      root.add(leaf);
      doorNode = leaf;
    }
  }
  return { root, fadeMeshes, doorNode, edgeOrientation };
}

export function placeBuildingModule(parts: ModuleParts, component: GameBuildComponent): void {
  parts.root.position.set(component.cell_x + 0.5, 0, component.cell_y + 0.5);
  parts.root.userData.buildingComponentId = component.component_id;
  parts.root.userData.buildingKind = effectiveKind(component);
}

export function moduleKind(component: GameBuildComponent): BuildingKind {
  return effectiveKind(component);
}
