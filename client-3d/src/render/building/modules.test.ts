import { Box3, Mesh, MeshMatcapMaterial, Vector3, type Material } from "three";
import { describe, expect, it } from "vitest";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { createBuildingMaterials } from "./materials";
import {
  createBuildingModule,
  DOOR_OPENING_HEIGHT_M,
  DOOR_OPENING_WIDTH_M,
  DOOR_SLIDE_DISTANCE_M,
  FLOOR_THICKNESS_M,
  ROOF_THICKNESS_M,
  WALL_HEIGHT_M,
  WALL_THICKNESS_M,
  WINDOW_HEAD_M,
  WINDOW_SILL_M,
} from "./modules";
import type { BuildingKind, GameBuildComponent } from "./types";

/**
 * Regression contract for the 2026-07-19 builder visual repair:
 * 1. The scene is UNLIT (environment/sunShadow.ts) — any lit-only material
 *    (MeshStandard/Lambert/Phong/Physical) renders as a black void. Building
 *    modules must stay on the matcap path like pawns and props.
 * 2. Module meters must match the accepted homebuilder BATCH_CONTRACT:
 *    wall 2.5, thickness 0.16, floor 0.12, roof 0.14, cell 1m — walls were
 *    previously 0.82m, shorter than the 1.7m pawn.
 * 3. Doors/windows must be real framed openings, not rectangles painted
 *    over a solid full-thickness wall.
 * All assertions are observable mesh/material/bounds facts, not source text.
 */

function component(kind: BuildingKind): GameBuildComponent {
  return { component_id: "c1", area_id: "a1", catalog_id: `${kind}_test`, kind, cell_x: 0, cell_y: 0, rotation_quarters: 0 };
}

function meshesOf(kind: BuildingKind): Mesh[] {
  const { root } = createBuildingModule(component(kind));
  root.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if ((object as Mesh).isMesh) meshes.push(object as Mesh);
  });
  return meshes;
}

function materialsOf(meshes: readonly Mesh[]): Material[] {
  return meshes.flatMap((mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
}

function luminanceOf(material: Material): number {
  const color = (material as MeshMatcapMaterial).color;
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

const scratchBox = new Box3();

const ALL_KINDS: readonly BuildingKind[] = ["floor", "wall", "door", "window", "roof"];

describe("building module materials (unlit scene contract)", () => {
  it("uses only unlit-compatible matcap materials — lit-only materials render black voids", () => {
    for (const kind of ALL_KINDS) {
      for (const material of materialsOf(meshesOf(kind))) {
        expect(material, `${kind} material`).toBeInstanceOf(MeshMatcapMaterial);
        expect(["MeshStandardMaterial", "MeshLambertMaterial", "MeshPhongMaterial", "MeshPhysicalMaterial"], `${kind} lit material`).not.toContain(material.type);
        expect((material as MeshMatcapMaterial).fog, `${kind} fog`).toBe(true);
      }
    }
  });

  it("keeps solid palette zones readable and distinct — never near-black", () => {
    for (const kind of ALL_KINDS) {
      const materials = materialsOf(meshesOf(kind));
      const hexes = new Set(materials.map((material) => (material as MeshMatcapMaterial).color.getHexString()));
      for (const material of materials) {
        expect(luminanceOf(material), `${kind} luminance`).toBeGreaterThan(0.1);
        expect((material as MeshMatcapMaterial).opacity, `${kind} opacity`).toBe(1);
        expect(material.transparent, `${kind} transparent`).toBe(false);
      }
      // Every module keeps at least two palette zones (primary + accent trim).
      expect(hexes.size, `${kind} palette zones`).toBeGreaterThanOrEqual(2);
    }
  });

  it("lifts an authored near-black palette instead of rendering a void surface", () => {
    const materials = createBuildingMaterials({ primary: "#050505", secondary: "#000000", accent: "#0a0a0a" });
    expect(luminanceOf(materials.primary)).toBeGreaterThan(0.1);
    expect(luminanceOf(materials.secondary)).toBeGreaterThan(0.1);
    expect(luminanceOf(materials.accent)).toBeGreaterThan(0.1);
  });

  it("keeps the ghost transparent and tinted by validity", () => {
    const valid = createBuildingMaterials(null, true, true);
    const invalid = createBuildingMaterials(null, true, false);
    for (const material of [valid.primary, valid.secondary, valid.accent, invalid.primary, invalid.secondary, invalid.accent]) {
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBeLessThan(1);
      expect(material.depthWrite).toBe(false);
    }
    expect(valid.primary.color.g).toBeGreaterThan(valid.primary.color.r); // green = valid
    expect(invalid.primary.color.r).toBeGreaterThan(invalid.primary.color.g); // red = invalid
  });
});

describe("building module meter contract (BATCH_CONTRACT.json)", () => {
  it("matches the accepted dimensions exactly", () => {
    expect(WALL_HEIGHT_M).toBe(2.5);
    expect(WALL_THICKNESS_M).toBe(0.16);
    expect(FLOOR_THICKNESS_M).toBe(0.12);
    expect(ROOF_THICKNESS_M).toBe(0.14);
  });

  it("builds a 2.5m wall panel 0.16m thick spanning the 1m cell", () => {
    const meshes = meshesOf("wall");
    const wall = meshes.find((mesh) => mesh.userData.buildingPart === "wall");
    expect(wall).toBeDefined();
    const size = scratchBox.setFromObject(wall as Mesh).getSize(new Vector3());
    expect(size.x).toBeCloseTo(1, 5);
    expect(size.y).toBeCloseTo(WALL_HEIGHT_M, 5);
    expect(size.z).toBeCloseTo(WALL_THICKNESS_M, 5);
    // Whole module (panel + trim) tops out exactly at wall height.
    const box = new Box3();
    for (const mesh of meshes) box.expandByObject(mesh);
    expect(box.max.y).toBeCloseTo(WALL_HEIGHT_M, 5);
    expect(box.min.y).toBeCloseTo(0, 5);
  });

  it("caps floor and roof world bounds at the contract slabs", () => {
    const floorBox = new Box3();
    for (const mesh of meshesOf("floor")) floorBox.expandByObject(mesh);
    expect(floorBox.max.y).toBeCloseTo(FLOOR_THICKNESS_M, 5);

    const roofBox = new Box3();
    for (const mesh of meshesOf("roof")) roofBox.expandByObject(mesh);
    expect(roofBox.min.y).toBeCloseTo(WALL_HEIGHT_M, 5);
    expect(roofBox.max.y).toBeCloseTo(WALL_HEIGHT_M + ROOF_THICKNESS_M, 5);
  });

  it("keeps one 1m cell physically honest for the 1.7m pawn", () => {
    expect(SUCCESSOR_3D_CONFIG.pawn.height).toBeCloseTo(1.7, 5);
    // Pawn standing on the floor slab clears the roof underside…
    expect(FLOOR_THICKNESS_M + SUCCESSOR_3D_CONFIG.pawn.height).toBeLessThan(WALL_HEIGHT_M);
    // …and walks through the door opening upright.
    expect(DOOR_OPENING_HEIGHT_M).toBeGreaterThan(SUCCESSOR_3D_CONFIG.pawn.height);
  });
});

describe("door and window read as framed openings", () => {
  it("door: nothing solid crosses the wall midplane inside the opening", () => {
    const meshes = meshesOf("door");
    // Wall midplane point inside the clear opening. The OLD design (solid
    // 1×0.82 panel with a dark rectangle painted on top) contained it.
    const probe = new Vector3(0, 0.4, -0.5);
    for (const mesh of meshes) {
      expect(scratchBox.setFromObject(mesh).containsPoint(probe), `${mesh.userData.buildingPart} blocks door opening`).toBe(false);
    }
    // Frame still exists: jambs and header are full wall thickness.
    const frame = meshes.filter((mesh) => mesh.userData.buildingPart === "wall");
    expect(frame.length).toBeGreaterThanOrEqual(3);
    for (const mesh of frame) {
      expect(scratchBox.setFromObject(mesh).getSize(new Vector3()).z).toBeCloseTo(WALL_THICKNESS_M, 5);
    }
  });

  it("door: the sliding leaf rides the interior face and clears the opening when open", () => {
    const parts = createBuildingModule(component("door"));
    parts.root.updateMatrixWorld(true);
    expect(parts.doorNode).not.toBeNull();
    const leaf = parts.doorNode as Mesh;
    // Leaf is offset off the wall midplane (a leaf, not paint on the wall)…
    expect(scratchBox.setFromObject(leaf).min.z).toBeGreaterThan(-0.5 + WALL_THICKNESS_M / 2 - 1e-6);
    // …and the renderer slide distance clears the full opening width.
    leaf.position.x = DOOR_SLIDE_DISTANCE_M;
    parts.root.updateMatrixWorld(true);
    expect(scratchBox.setFromObject(leaf).min.x).toBeGreaterThanOrEqual(DOOR_OPENING_WIDTH_M / 2);
  });

  it("window: only a thin glazing pane crosses the opening; sill wall stays solid", () => {
    const meshes = meshesOf("window");
    const openingProbe = new Vector3(0, (WINDOW_SILL_M + WINDOW_HEAD_M) / 2, -0.5);
    for (const mesh of meshes) {
      if (!scratchBox.setFromObject(mesh).containsPoint(openingProbe)) continue;
      // Anything crossing the opening must be a pane, not wall thickness.
      expect(scratchBox.getSize(new Vector3()).z, `${mesh.userData.buildingPart} pane thickness`).toBeLessThanOrEqual(0.05);
      expect(mesh.userData.buildingPart).toBe("window");
    }
    // Below the sill the wall is genuinely solid at full thickness.
    const sillProbe = new Vector3(0, 0.4, -0.5);
    const solid = meshes.some((mesh) => scratchBox.setFromObject(mesh).containsPoint(sillProbe) && scratchBox.getSize(new Vector3()).z >= WALL_THICKNESS_M - 1e-6);
    expect(solid).toBe(true);
  });
});
