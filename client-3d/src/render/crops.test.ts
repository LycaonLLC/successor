import { describe, expect, it } from "vitest";
import { BufferGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Scene, type Object3D } from "three";
import type { PlayState, ServerAuthorityFarmCropState, ServerAuthorityFarmTileState } from "@successor/client/src/slice-core/gameState";
import {
  CROP_WORLD_LOOKS,
  CROP_WORLD_SPECIES,
  FarmCropsRenderer,
  cropHealthPct,
  cropTileKey,
  cropWorldGlbPath,
  cropYawFor,
  isCropWorldSpecies,
  resolveCropLook,
  resolveCropRender,
} from "./crops";

// ── Pure mapping ───────────────────────────────────────────────────────────

function look(stage: number, stageCount: number, mature = false, health = 100) {
  return resolveCropLook({ stage, stageCount, mature, health });
}

describe("resolveCropLook — stage mapping", () => {
  it("maps a 5-stage arc onto planted/establishing/laden with the contract floor", () => {
    // floor(stage/4 * 2): 0,1 → planted; 2,3 → establishing; 4 → laden
    expect(look(0, 5).look).toBe("planted");
    expect(look(1, 5).look).toBe("planted");
    expect(look(2, 5).look).toBe("establishing");
    expect(look(3, 5).look).toBe("establishing");
    expect(look(4, 5).look).toBe("laden");
  });

  it("clamps the degenerate stageCount=1 denominator instead of dividing by zero", () => {
    expect(look(0, 1).look).toBe("planted");
    // stage 1 of a 1-stage crop: floor(1/1*2)=2 → laden, still finite/clamped
    expect(look(1, 1).look).toBe("laden");
  });

  it("clamps out-of-range stages to the 0..2 look band", () => {
    expect(look(99, 5).look).toBe("laden");
    expect(look(-3, 5).look).toBe("planted");
  });

  it("mature forces laden regardless of stage", () => {
    expect(look(0, 5, true).look).toBe("laden");
  });
});

describe("resolveCropLook — health thresholds", () => {
  it("flags distressed strictly below 35 and never at 35", () => {
    expect(look(2, 5, false, 34.9).distressed).toBe(true);
    expect(look(2, 5, false, 35).distressed).toBe(false);
    expect(look(2, 5, false, 100).distressed).toBe(false);
  });

  it("health ≤ 0 is husk — dead beats mature, and a husk is not distressed", () => {
    expect(look(4, 5, true, 0)).toEqual({ look: "husk", distressed: false });
    expect(look(2, 5, false, -5).look).toBe("husk");
  });

  it("a distressed crop keeps its growth look (presentation, not stage change)", () => {
    expect(look(2, 5, false, 10).look).toBe("establishing");
    expect(look(0, 5, true, 10)).toEqual({ look: "laden", distressed: true });
  });
});

describe("cropHealthPct — wire adapter", () => {
  it("normalizes the streamed W3 health strings", () => {
    expect(cropHealthPct("vigorous")).toBe(100);
    expect(cropHealthPct("wilting")).toBeLessThan(35); // wilting IS distress
    expect(cropHealthPct("wilting")).toBeGreaterThan(0); // but never husk
    expect(cropHealthPct("dormant")).toBeLessThan(35);
    expect(cropHealthPct("dormant")).toBeGreaterThan(0);
    expect(cropHealthPct("dead")).toBe(0);
  });

  it("passes a future numeric channel through and defaults unknowns to healthy", () => {
    expect(cropHealthPct(72)).toBe(72);
    expect(cropHealthPct(0)).toBe(0);
    expect(cropHealthPct("something-new")).toBe(100);
    expect(cropHealthPct(undefined)).toBe(100);
    expect(cropHealthPct(Number.NaN)).toBe(100);
  });
});

// ── Species / path registry ────────────────────────────────────────────────

describe("species/path registry", () => {
  it("covers exactly the nine catalog species", () => {
    expect([...CROP_WORLD_SPECIES]).toEqual([
      "ashgrain", "sunmelon", "cavemoss", "emberbean", "riftroot",
      "brineleaf", "glasspepper", "coilreed", "nightplum",
    ]);
    for (const species of CROP_WORLD_SPECIES) expect(isCropWorldSpecies(species)).toBe(true);
    expect(isCropWorldSpecies("kelp")).toBe(false);
  });

  it("resolves every species×look to the exact catalog path template", () => {
    for (const species of CROP_WORLD_SPECIES) {
      for (const lookName of CROP_WORLD_LOOKS) {
        expect(cropWorldGlbPath(species, lookName)).toBe(`/assets/items/custom/crops/world/${species}/${lookName}.glb`);
      }
    }
  });

  it("resolveCropRender maps a streamed row to its path and refuses unknown species", () => {
    expect(resolveCropRender(cropRow({ species: "ashgrain", stage: 4, stageCount: 5 })))
      .toEqual({ path: "/assets/items/custom/crops/world/ashgrain/laden.glb", look: "laden", distressed: false });
    expect(resolveCropRender(cropRow({ species: "notacrop" }))).toBeNull();
  });
});

// ── Deterministic transforms ───────────────────────────────────────────────

describe("deterministic transforms", () => {
  it("yaw is a pure function of the stable tile key", () => {
    const key = cropTileKey("parcel-1", 12, 34);
    expect(cropYawFor(key)).toBe(cropYawFor("parcel-1:12:34"));
    expect(cropYawFor(key)).not.toBe(cropYawFor(cropTileKey("parcel-1", 12, 35)));
    expect(cropYawFor(key)).toBeGreaterThanOrEqual(0);
    expect(cropYawFor(key)).toBeLessThan(Math.PI * 2);
  });
});

// ── Renderer: caching, cloning, reconcile ──────────────────────────────────

function cropRow(overrides: Partial<ServerAuthorityFarmCropState> = {}): ServerAuthorityFarmCropState {
  return {
    seedItemId: 6001,
    seedVariantId: 0,
    species: "ashgrain",
    stage: 0,
    stageCount: 5,
    health: "vigorous",
    blight: "none",
    timeToMatureGameDays: 3,
    qualitySoFarMilli: 500,
    footprintW: 1,
    footprintH: 1,
    mature: false,
    ...overrides,
  };
}

function tile(cellX: number, cellY: number, crop: ServerAuthorityFarmCropState | null): ServerAuthorityFarmTileState {
  return { cellX, cellY, tilled: true, moisturePct: 60, fertilizer: "none", crop, legalVerbs: [] };
}

function farmState(tiles: ServerAuthorityFarmTileState[], areaId = "area-1"): PlayState {
  return {
    activeAreaId: "area-1",
    serverAuthority: { farmPlots: [{ parcelId: "parcel-1", areaId, tiles }] },
  } as unknown as PlayState;
}

/** Multi-mesh template GLB stand-in: named root, two named child meshes. */
function stubGltfScene(): Object3D {
  const root = new Group();
  root.name = "crop_root";
  root.userData = { lane: "crop-asset-family" };
  const stalk = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ name: "raw_organic" }));
  stalk.name = "stalk";
  const fruit = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ name: "bio_glass" }));
  fruit.name = "fruit";
  fruit.userData = { accent: true };
  root.add(stalk, fruit);
  return root;
}

function makeRenderer() {
  const loads: string[] = [];
  const scene = new Scene();
  const renderer = new FarmCropsRenderer(scene, (url) => {
    loads.push(url);
    return Promise.resolve({ scene: stubGltfScene() });
  });
  return { renderer, scene, loads };
}

async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) out.push(object);
  });
  return out;
}

describe("FarmCropsRenderer", () => {
  it("caches one template per GLB path — no per-tile loader duplication", async () => {
    const { renderer, loads } = makeRenderer();
    const state = farmState([
      tile(0, 0, cropRow()),
      tile(1, 0, cropRow()),
      tile(2, 0, cropRow({ stage: 4, mature: true })),
    ]);
    renderer.update(state); // requests
    renderer.update(state); // must not re-request while pending
    await settled();
    renderer.update(state); // spawns from cache
    expect(loads).toEqual([
      "/assets/items/custom/crops/world/ashgrain/planted.glb",
      "/assets/items/custom/crops/world/ashgrain/laden.glb",
    ]);
    expect(renderer.debugInstanceCounts()).toEqual({
      "/assets/items/custom/crops/world/ashgrain/planted.glb": 2,
      "/assets/items/custom/crops/world/ashgrain/laden.glb": 1,
    });
    renderer.dispose();
  });

  it("clones the full multi-mesh hierarchy, preserving names/userData and sharing template geometry+materials", async () => {
    const { renderer, scene } = makeRenderer();
    const state = farmState([tile(3, 7, cropRow())]);
    renderer.update(state);
    await settled();
    renderer.update(state);

    const group = scene.children.find((child) => child.name === "farm-crops")!;
    expect(group.children).toHaveLength(1);
    const instance = group.children[0]!;
    expect(instance.name).toBe("crop_root");
    expect(instance.userData).toEqual({ lane: "crop-asset-family" });
    const meshes = meshesOf(instance);
    expect(meshes.map((mesh) => mesh.name).sort()).toEqual(["fruit", "stalk"]);
    expect(meshes.find((mesh) => mesh.name === "fruit")!.userData).toEqual({ accent: true });
    // Native materials survive as the shared unlit conversion (name kept).
    for (const mesh of meshes) {
      expect((mesh.material as MeshBasicMaterial).name).toMatch(/^(raw_organic|bio_glass):successor-basic$/);
    }

    // Second tile of the same look shares geometry AND materials with the first.
    const two = farmState([tile(3, 7, cropRow()), tile(4, 7, cropRow())]);
    renderer.update(two);
    const [a, b] = group.children;
    const meshesA = meshesOf(a!);
    const meshesB = meshesOf(b!);
    expect(meshesA[0]!.geometry).toBe(meshesB[0]!.geometry);
    expect(meshesA[0]!.material).toBe(meshesB[0]!.material);
    renderer.dispose();
  });

  it("places instances deterministically: cell+0.5 position, key-hashed yaw, unit scale", async () => {
    const { renderer, scene } = makeRenderer();
    const state = farmState([tile(3, 7, cropRow())]);
    renderer.update(state);
    await settled();
    renderer.update(state);
    const group = scene.children.find((child) => child.name === "farm-crops")!;
    const instance = group.children[0]!;
    expect(instance.position.x).toBe(3.5);
    expect(instance.position.y).toBe(0);
    expect(instance.position.z).toBe(7.5);
    expect(instance.rotation.y).toBe(cropYawFor("parcel-1:3:7"));
    expect(instance.scale.y).toBe(1);
    // Reconcile keeps the SAME clone across frames — no respawn churn.
    renderer.update(state);
    expect(group.children[0]).toBe(instance);
    renderer.dispose();
  });

  it("distressed instances own cloned desaturated materials and dispose only those", async () => {
    const { renderer, scene } = makeRenderer();
    const healthy = farmState([tile(0, 0, cropRow()), tile(1, 0, cropRow({ health: "wilting" }))]);
    renderer.update(healthy);
    await settled();
    renderer.update(healthy);
    const group = scene.children.find((child) => child.name === "farm-crops")!;
    const [healthyRoot, wiltRoot] = group.children;
    const healthyMaterial = meshesOf(healthyRoot!)[0]!.material as MeshBasicMaterial;
    const wiltMaterials = meshesOf(wiltRoot!).map((mesh) => mesh.material as MeshBasicMaterial);
    for (const material of wiltMaterials) expect(material).not.toBe(healthyMaterial);
    // Droop presentation is restrained and deterministic.
    expect(wiltRoot!.rotation.z).toBeCloseTo(0.1);
    expect(wiltRoot!.scale.y).toBeCloseTo(0.92);
    expect(healthyRoot!.rotation.z).toBeCloseTo(0);

    // Harvesting the wilted tile despawns it and disposes ONLY its owned clones.
    const disposed = new Set<MeshBasicMaterial>();
    for (const material of [healthyMaterial, ...wiltMaterials]) {
      material.addEventListener("dispose", () => { disposed.add(material); });
    }
    const afterHarvest = farmState([tile(0, 0, cropRow())]);
    renderer.update(afterHarvest);
    expect(group.children).toHaveLength(1);
    for (const material of wiltMaterials) expect(disposed.has(material)).toBe(true);
    expect(disposed.has(healthyMaterial)).toBe(false);
    renderer.dispose();
  });

  it("swaps the mesh when the streamed row changes look — server state only", async () => {
    const { renderer, scene } = makeRenderer();
    const young = farmState([tile(0, 0, cropRow({ stage: 0 }))]);
    renderer.update(young);
    await settled();
    renderer.update(young);
    const mature = farmState([tile(0, 0, cropRow({ stage: 4, mature: true }))]);
    renderer.update(mature);
    await settled();
    renderer.update(mature);
    expect(renderer.debugInstanceCounts()).toEqual({
      "/assets/items/custom/crops/world/ashgrain/laden.glb": 1,
    });
    // Dead crop → husk mesh.
    const dead = farmState([tile(0, 0, cropRow({ stage: 4, mature: true, health: "dead" }))]);
    renderer.update(dead);
    await settled();
    renderer.update(dead);
    expect(renderer.debugInstanceCounts()).toEqual({
      "/assets/items/custom/crops/world/ashgrain/husk.glb": 1,
    });
    renderer.dispose();
  });

  it("ignores other-area plots, empty tiles, and unknown species — never fabricates", async () => {
    const { renderer, loads } = makeRenderer();
    const state = farmState([
      tile(0, 0, null),
      tile(1, 0, cropRow({ species: "kelp" })),
    ]);
    const otherArea = farmState([tile(0, 0, cropRow())], "area-2");
    renderer.update(state);
    renderer.update(otherArea);
    await settled();
    renderer.update(state);
    renderer.update(otherArea);
    expect(loads).toEqual([]);
    expect(renderer.debugInstanceCounts()).toEqual({});
    renderer.dispose();
  });
});
