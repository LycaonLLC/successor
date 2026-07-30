// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BoxGeometry, Color, CylinderGeometry, Group, Line, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, ShapeGeometry, SkinnedMesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { INVENTORY_ITEM_DEFINITION_IDS } from "@successor/client/src/slice-core/inventoryDisplaySystem";
import { containerSpecFor, isStandardizedContainerItemId } from "./containers";
import { WARDROBE_PIECES } from "../../assets/wardrobe.gen";
import {
  glyphInkColorForPlate,
  SLOT_ROOT_TILT_X,
  SLOT_TURN_RADIANS_PER_SECOND,
  SlotVisualKit,
  slotVisualRotation,
  normalizeModelScene,
  type SlotRotationEuler,
} from "./slotVisuals";
import itemModelsJson from "./itemModels.json";
import { ITEM_DESCRIPTION_BY_ID } from "./itemCopy";

// Vitest runs with cwd = client-3d (happy-dom rewrites import.meta.url, so cwd is the stable anchor).
const repoRoot = resolve(process.cwd(), "..");
const fieldToolManifest = JSON.parse(readFileSync(
  `${repoRoot}/client-3d/public/assets/items/custom/field-tools/manifest.json`,
  "utf8",
)) as { assets: Record<string, { itemIds?: number[] }> };


describe("itemModels.json", () => {
  const entries = Object.entries(itemModelsJson).filter(([key]) => key !== "_comment") as [string, string][];

  it("maps every key to a real GLB with no null or sprite fallback", () => {
    for (const [itemId, modelPath] of entries) {
      expect(Number.isInteger(Number(itemId)), itemId).toBe(true);
      expect(modelPath, itemId).toMatch(/^\/assets\/.+\.glb$/u);
      expect(existsSync(`${repoRoot}/client-3d/public${modelPath}`), `${itemId} -> ${modelPath}`).toBe(true);
    }
  });
  it("covers every canonical static inventory item id with a GLB or standardized container", () => {
    const mappedItemIds = new Set(entries.map(([itemId]) => Number(itemId)));
    for (const itemId of INVENTORY_ITEM_DEFINITION_IDS) {
      if (isStandardizedContainerItemId(itemId)) {
        const category = itemId >= 1101 && itemId <= 1103 ? "ammo" : "resource";
        expect(containerSpecFor({ itemId, category }), `container ${itemId}`).not.toBeNull();
      } else {
        expect(mappedItemIds.has(itemId), `GLB item ${itemId}`).toBe(true);
      }
    }
  });

  it("routes all 33 authority-backed replacement items to distinct custom-authored GLBs", () => {
    const replacementItemIds = [
      1003, 1004, 1204,
      3001, 3004, 3007, 3008, 3009, 3010, 3011, 3201,
      5001, 5002, 5003,
      6001, 6002, 6003, 6101, 6102, 6103,
      6201, 6202, 6203, 6204, 6205, 6206, 6207, 6208,
      6301, 6310, 6311, 6312,
      9002,
    ];
    const modelByItemId = Object.fromEntries(entries);
    const customPaths = replacementItemIds.map((itemId) => modelByItemId[String(itemId)]);
    expect(customPaths).toHaveLength(33);
    expect(new Set(customPaths).size).toBe(33);
    for (const [index, modelPath] of customPaths.entries()) {
      expect(modelPath, String(replacementItemIds[index])).toMatch(/^\/assets\/items\/custom\/.+\.glb$/u);
      expect(modelPath).not.toContain("synty");
    }
  });

  it("keeps the unwired Clod Contract GLB on disk without advertising item 4001", () => {
    expect(itemModelsJson).not.toHaveProperty("4001");
    expect(existsSync(`${repoRoot}/client-3d/public/assets/items/custom/chits-currency/item_4001_clod_contract.glb`)).toBe(true);
  });

  it("keeps retired tool GLBs as source art without runtime item mappings", () => {
    const preservedAssets = [
      [3002, "operation_tool.glb"],
      [3003, "system_tool.glb"],
      [3005, "retired_analog_scanner.glb"],
    ] as const;
    const advertisedIds = new Set(
      Object.values(fieldToolManifest.assets).flatMap((asset) => asset.itemIds ?? []),
    );
    for (const [itemId, fileName] of preservedAssets) {
      expect(itemModelsJson).not.toHaveProperty(String(itemId));
      expect(advertisedIds.has(itemId), String(itemId)).toBe(false);
      expect(existsSync(`${repoRoot}/client-3d/public/assets/items/custom/field-tools/${fileName}`), fileName).toBe(true);
    }
  });

  it("keeps every creator-clothing turntable GLB on disk", () => {
    for (const piece of WARDROBE_PIECES) {
      const modelPath = `/assets/pawn-pack/equipment/Under/${piece.id}.glb`;
      expect(existsSync(`${repoRoot}/client-3d/public${modelPath}`), modelPath).toBe(true);
    }
  });


  it("retains the real weapon/equipment GLB thumbnails", () => {
    const modelByItemId = Object.fromEntries(entries);
    expect(modelByItemId["3101"]).toBe("/assets/pawn-pack/weapons/custom/wpn_smg_sten_mk2.glb");
    expect(modelByItemId["3103"]).toBe("/assets/pawn-pack/vibrosword.glb");
    expect(modelByItemId["3104"]).toBe("/assets/pawn-pack/plasma_hilt.glb");
    expect(modelByItemId["7103"]).toBe("/assets/pawn-pack/equipment/Armor/Helmet_S2.glb");
  });

  it("keeps canonical Field Bandage 1002 on its authored GLB, on disk, on the shared turntable", () => {
    const modelByItemId = Object.fromEntries(entries);
    const glbPath = modelByItemId["1002"];
    expect(glbPath).toBe("/assets/items/field_bandage.glb");
    expect(existsSync(`${repoRoot}/client-3d/public${glbPath}`)).toBe(true);
    // Shared modeled-item turntable: the bandage model asset key auto-turns
    // exactly like every other GLB thumbnail (no bandage-specific path).
    const scratch: SlotRotationEuler = { x: 9, y: 9, z: 9 };
    const assetKey = `model:${glbPath}:-`;
    const early = { ...slotVisualRotation(assetKey, 0.5, 0, undefined, scratch) };
    const late = { ...slotVisualRotation(assetKey, 0.5, 60_000, undefined, scratch) };
    expect(early.x).toBe(SLOT_ROOT_TILT_X);
    expect(late.y - early.y).toBeCloseTo(60 * SLOT_TURN_RADIANS_PER_SECOND, 10);
  });
});

describe("food/crop catalog wave (2026-07-12 rebase)", () => {
  const waveIdsByPathPrefix: Record<string, number[]> = {
    "/assets/items/custom/crops/seeds/": [6001, 6002, 6003, 6004, 6005, 6006, 6007, 6008, 6009],
    "/assets/items/custom/crops/produce/": [6101, 6102, 6103, 6104, 6105, 6106, 6107, 6108, 6109],
    "/assets/items/custom/bio-additives/": [6313, 6314, 6315, 6316, 6317, 6318, 6319, 6320, 6321, 6322, 6323, 6324],
    "/assets/items/custom/food/ingredients/": [6401, 6402, 6403, 6404, 6405, 6406, 6407, 6408, 6409, 6410, 6411, 6412, 6413, 6414, 6415],
    "/assets/items/custom/food/dishes/": [6501, 6502, 6503, 6504, 6505, 6506, 6507, 6508, 6509, 6510, 6511, 6512, 6513, 6514, 6515, 6516, 6517, 6518, 6519, 6520],
  };
  const waveIds = Object.values(waveIdsByPathPrefix).flat();
  const modelByItemId = Object.fromEntries(
    Object.entries(itemModelsJson).filter(([key]) => key !== "_comment"),
  ) as Record<string, string>;

  it("maps all 65 wave items to distinct custom GLBs under their family paths", () => {
    expect(waveIds).toHaveLength(65);
    const paths: string[] = [];
    for (const [prefix, itemIds] of Object.entries(waveIdsByPathPrefix)) {
      for (const itemId of itemIds) {
        const modelPath = modelByItemId[String(itemId)];
        expect(modelPath, `item ${itemId}`).toMatch(/^\/assets\/items\/custom\/.+\.glb$/u);
        expect(modelPath!.startsWith(prefix), `item ${itemId} -> ${modelPath}`).toBe(true);
        paths.push(modelPath!);
      }
    }
    expect(new Set(paths).size).toBe(65);
  });

  it("gives every wave item its own 3D copy line", () => {
    for (const itemId of waveIds) {
      const copy = ITEM_DESCRIPTION_BY_ID[itemId];
      expect(copy, `item ${itemId}`).toBeTruthy();
      expect(copy!.length, `item ${itemId}`).toBeLessThanOrEqual(60);
    }
  });

  it("maps accessory 7203 to the custom field cap", () => {
    expect(modelByItemId["7203"]).toBe("/assets/items/custom/accessories/field_cap.glb");
  });

  it("keeps the whole model registry free of Synty/POLYGON paths", () => {
    const registryText = JSON.stringify(itemModelsJson).toLowerCase();
    expect(registryText).not.toContain("/synty/");
    expect(registryText).not.toContain("synty_");
    expect(registryText).not.toContain("/polygon/");
    expect(registryText).not.toContain("trial-props");
  });
});

describe("authored prop materials", () => {
  it("keeps non-wearable PBR materials out of the pawn matcap harness", () => {
    const kit = new SlotVisualKit();
    const source = new Group();
    const nativeMaterial = new MeshStandardMaterial({
      color: "#7d5a31",
      roughness: 0.37,
      metalness: 0.72,
    });
    const prop = new Mesh(new BoxGeometry(0.2, 0.1, 0.3), nativeMaterial);
    prop.name = "authored-prop";
    source.add(prop);

    const root = kit.createModelRoot(source, null, () => true);
    const clonedProp = root.getObjectByName("authored-prop");
    expect(clonedProp).toBeInstanceOf(Mesh);
    expect((clonedProp as Mesh).material).toBe(nativeMaterial);
    expect((clonedProp as Mesh).material).toBeInstanceOf(MeshStandardMaterial);
    expect(((clonedProp as Mesh).material as MeshStandardMaterial).roughness).toBe(0.37);
    expect(((clonedProp as Mesh).material as MeshStandardMaterial).metalness).toBe(0.72);
    kit.dispose();
  });
});

describe("procedural standardized container visuals", () => {
  const SHAPE_SAMPLES: readonly { itemId: number; category: "resource" | "ammo"; shape: string }[] = [
    { itemId: 2001, category: "resource", shape: "hex-crate" },
    { itemId: 2005, category: "resource", shape: "gable-canister" },
    { itemId: 2102, category: "resource", shape: "bio-pod" },
    { itemId: 2006, category: "resource", shape: "grain-sack" },
    { itemId: 1101, category: "ammo", shape: "ammobox" },
  ];

  it("builds every contract shape as a rotatable polygonal root with one plate and one filled glyph", () => {
    const kit = new SlotVisualKit();
    for (const sample of SHAPE_SAMPLES) {
      const spec = containerSpecFor(sample);
      expect(spec?.shape, `${sample.itemId}`).toBe(sample.shape);
      const root = kit.createContainerRoot(spec!);
      let lineCount = 0;
      let meshCount = 0;
      let plateCount = 0;
      let glyphCount = 0;
      root.traverse((object) => {
        if (object instanceof Line) lineCount += 1;
        if (!(object instanceof Mesh)) return;
        meshCount += 1;
        // Contract: no cylinder container bodies — only polygonal prisms and boxes.
        expect(object.geometry instanceof CylinderGeometry, `${sample.shape} uses a cylinder`).toBe(false);
        if (object.geometry instanceof ShapeGeometry) glyphCount += 1;
        if (
          object.geometry instanceof PlaneGeometry &&
          object.material instanceof MeshBasicMaterial &&
          object.material.color.getHexString() === new Color(spec!.plateColor).getHexString()
        ) {
          plateCount += 1;
        }
      });
      // Filled silhouettes replaced the stroked Line glyph: subpath connector
      // artifacts are impossible because nothing is stroked anymore.
      expect(lineCount, sample.shape).toBe(0);
      expect(meshCount, sample.shape).toBeGreaterThanOrEqual(4);
      expect(plateCount, sample.shape).toBe(1);
      expect(glyphCount, sample.shape).toBe(1);
    }
    kit.dispose();
  });

  it("uses contrasting light ink for Hide and dark ink for Bone", () => {
    expect(glyphInkColorForPlate("#8a6a42")).toBe("#ffffff");
    expect(glyphInkColorForPlate("#cfc5a5")).toBe("#15191c");

    const kit = new SlotVisualKit();
    for (const itemId of [2101, 2103]) {
      const spec = containerSpecFor({ itemId, category: "resource" })!;
      const root = kit.createContainerRoot(spec);
      let glyphColor: string | null = null;
      root.traverse((object) => {
        if (
          object instanceof Mesh
          && object.geometry instanceof ShapeGeometry
          && object.material instanceof MeshBasicMaterial
        ) {
          glyphColor = object.material.color.getHexString();
        }
      });
      expect(glyphColor, String(itemId)).toBe(new Color(glyphInkColorForPlate(spec.plateColor)).getHexString());
    }
    kit.dispose();
  });

  it("triangulates every generated silhouette, ammo included, into non-empty filled glyph geometry", () => {
    const kit = new SlotVisualKit();
    const containerItemIds: readonly { itemId: number; category: "resource" | "ammo" }[] = [
      ...[2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2101, 2102, 2103, 2104]
        .map((itemId) => ({ itemId, category: "resource" as const })),
      { itemId: 1101, category: "ammo" as const },
    ];
    const seenGlyphs = new Set<string>();
    for (const sample of containerItemIds) {
      const spec = containerSpecFor(sample)!;
      seenGlyphs.add(spec.lineGlyph);
      const root = kit.createContainerRoot(spec);
      let glyphTriangles = 0;
      root.traverse((object) => {
        if (object instanceof Mesh && object.geometry instanceof ShapeGeometry) {
          const index = object.geometry.getIndex();
          glyphTriangles = (index ? index.count : object.geometry.getAttribute("position").count) / 3;
        }
      });
      expect(glyphTriangles, `${sample.itemId} (${spec.lineGlyph})`).toBeGreaterThan(0);
    }
    expect(seenGlyphs.size).toBe(15);
    kit.dispose();
  });
});

describe("normalizeModelScene wearable framing", () => {
  it("frames one representative glove instead of the two-metre socket span", async () => {
    const glovePath = `${repoRoot}/client-3d/public/assets/pawn-pack/equipment/Under/gloves_knuckled_half.glb`;
    const bytes = readFileSync(glovePath);
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    const gltf = await new GLTFLoader().parseAsync(arrayBuffer, "");
    const normalized = normalizeModelScene(
      gltf.scene,
      "/assets/pawn-pack/equipment/Under/gloves_knuckled_half.glb",
    );
    let visibleGloveMeshes = 0;
    normalized.root.traverse((object) => {
      if (object instanceof SkinnedMesh) visibleGloveMeshes += 1;
    });

    expect(visibleGloveMeshes).toBe(1);
    expect(normalized.sourceMaxDimension).toBeLessThan(0.3);
    expect(normalized.normalizedScale).toBeGreaterThan(4);
  });

  it("keeps separated meshes for non-glove models", () => {
    const source = new Group();
    const material = new MeshBasicMaterial();
    const left = new Mesh(new BoxGeometry(0.2, 0.1, 0.1), material);
    const right = new Mesh(new BoxGeometry(0.2, 0.1, 0.1), material);
    left.position.x = -1;
    right.position.x = 1;
    source.add(left, right);

    const normalized = normalizeModelScene(
      source,
      "/assets/pawn-pack/equipment/Under/boots_test.glb",
    );
    let visibleMeshes = 0;
    normalized.root.traverse((object) => {
      if (object instanceof Mesh) visibleMeshes += 1;
    });

    expect(visibleMeshes).toBe(2);
    expect(normalized.sourceMaxDimension).toBeCloseTo(2.2, 5);
  });
});


describe("slotVisualRotation", () => {
  const scratch: SlotRotationEuler = { x: 9, y: 9, z: 9 };


  it("auto-turns every GLB visual over time with the shared tilt", () => {
    for (const assetKey of [
      "model:/assets/pawn-pack/slugthrower.glb:-",
      "model:/assets/items/field_bandage.glb:-",
      "model:/assets/pawn-pack/equipment/Armor/Helmet_S2.glb:helmet_s2",
    ]) {
      const early = { ...slotVisualRotation(assetKey, 0.5, 0, undefined, scratch) };
      const late = { ...slotVisualRotation(assetKey, 0.5, 60_000, undefined, scratch) };
      expect(early.x, assetKey).toBe(SLOT_ROOT_TILT_X);
      expect(late.x, assetKey).toBe(SLOT_ROOT_TILT_X);
      expect(early.y, assetKey).toBe(0.5);
      expect(late.y - early.y, assetKey).toBeCloseTo(60 * SLOT_TURN_RADIANS_PER_SECOND, 10);
      expect(early.z, assetKey).toBe(0);
    }
  });

  it("freezes a dragged 3D visual's yaw at the hand", () => {
    const rotation = slotVisualRotation("model:/assets/pawn-pack/vibrosword.glb:-", 0.5, 120_000, 4.2, scratch);
    expect(rotation.y).toBe(4.2);
    expect(rotation.x).toBe(SLOT_ROOT_TILT_X);
  });
});
