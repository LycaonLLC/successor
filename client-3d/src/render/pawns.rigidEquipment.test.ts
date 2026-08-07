// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  Bone,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  SRGBColorSpace,
  Texture,
  Vector3,
  type Object3D,
} from "three";
import {
  applyPawnBodyZoneMask,
  buildPawnEquipmentLookup,
  collectPawnBodyZoneMeshes,
  resolvePawnBodyZoneMask,
  type PawnEquipmentItem,
  type PawnPack,
} from "../assets/pawnPack";
import { attachPawnEquipmentSet, type PawnEquipmentMaterialResolver } from "./pawns";

/**
 * Rigid server-owned accessory attachment (7203 Field Cap): the manifest's
 * `rigidAnchorBone` routes the ORIGIN-authored multi-mesh GLB onto the live
 * head bone via the AssetViewer SNAP convention — identity local transform,
 * inherited body scale cancelled, native textures converted to unlit
 * map+color. The classic SkinnedMesh rebind route must stay byte-identical.
 */

const PACK_BODY_SCALE = 0.5;

const CAP_ITEM: PawnEquipmentItem = {
  id: "hat_field_cap",
  name: "Field Cap",
  layer: "Under",
  group: "Headwear — baseline",
  slot: "cranium",
  glb: "../../items/custom/accessories/field_cap.glb",
  requires: [],
  authorityItemId: 7203,
  rigidAnchorBone: "head",
};

const TANK_ITEM: PawnEquipmentItem = {
  id: "under_tank",
  name: "Tank",
  layer: "Under",
  group: "Torso",
  slot: "under_torso",
  glb: "Under/Tank.glb",
  requires: [],
};

interface BodyFixture {
  bodyRoot: Group;
  pelvis: Bone;
  head: Bone | null;
}

/** Mimics a clonePawnBody result: uniform pack scale at the instance root,
 * an animated bone chain (head carries a live pose) underneath. */
function makeBody(withHead = true): BodyFixture {
  const bodyRoot = new Group();
  bodyRoot.scale.setScalar(PACK_BODY_SCALE);
  const pelvis = new Bone();
  pelvis.name = "pelvis";
  pelvis.position.set(0, 1, 0);
  bodyRoot.add(pelvis);
  let head: Bone | null = null;
  if (withHead) {
    head = new Bone();
    head.name = "head";
    head.position.set(0, 0.6, 0.05);
    head.rotation.set(0.2, 0.4, 0.1); // live animated pose — snap must ignore it locally
    pelvis.add(head);
  }
  bodyRoot.updateMatrixWorld(true);
  return { bodyRoot, pelvis, head };
}

interface CapFixture {
  scene: Group;
  atlasTexture: Texture;
  atlasMaterial: MeshStandardMaterial;
}

/** Mirrors the real field_cap.glb shape: Scene → field_cap_root → many rigid
 * meshes sharing one textured PBR atlas material, authored around the origin. */
function makeCapScene(): CapFixture {
  const atlasTexture = new Texture();
  const atlasMaterial = new MeshStandardMaterial({ map: atlasTexture, color: new Color("#b0a080") });
  atlasMaterial.name = "accessory_atlas";
  const scene = new Group();
  scene.name = "Scene";
  const root = new Group();
  root.name = "field_cap_root";
  scene.add(root);
  const crown = new Mesh(new BoxGeometry(0.2, 0.1, 0.2), atlasMaterial);
  crown.name = "field_cap_crown";
  const bill = new Mesh(new BoxGeometry(0.2, 0.02, 0.1), atlasMaterial);
  bill.name = "field_cap_bill";
  bill.userData.bake = "pf2-run01"; // authored node metadata must survive the clone
  const eyelet = new Mesh(new BoxGeometry(0.01, 0.01, 0.01), [atlasMaterial, atlasMaterial.clone()]);
  eyelet.name = "field_cap_eyelet_0";
  eyelet.position.set(0.065, 0.18, -0.055); // authored offset must survive the clone
  root.add(crown, bill, eyelet);
  return { scene, atlasTexture, atlasMaterial };
}

function makeSkinnedTankScene(name = "tank"): Group {
  const sourceBone = new Bone();
  sourceBone.name = "pelvis";
  const mesh = new SkinnedMesh(new BoxGeometry(0.3, 0.4, 0.2), new MeshStandardMaterial());
  mesh.name = name;
  mesh.bind(new Skeleton([sourceBone]));
  const scene = new Group();
  scene.add(mesh);
  return scene;
}

function makePack(
  scenes: ReadonlyMap<string, Group>,
  femaleScenes?: ReadonlyMap<string, Group>,
): PawnPack {
  // attachPawnEquipmentSet only consumes pack.equipment; building a full
  // cooked PawnPack (clips, masks, attach specs) is impossible in a unit test.
  const pack = {
    equipment: {
      basePath: "/assets/pawn-pack/equipment",
      items: [CAP_ITEM, TANK_ITEM],
      scenes,
      ...(femaleScenes ? { femaleScenes } : {}),
    },
  } as unknown as PawnPack;
  return pack;
}

function capPack(cap: CapFixture = makeCapScene()): PawnPack {
  return makePack(new Map([["hat_field_cap", cap.scene]]));
}

function findAttachedCap(bodyRoot: Group): Object3D | null {
  return bodyRoot.getObjectByName("equipment:hat_field_cap") ?? null;
}

describe("rigid authority accessory attachment (7203 field cap)", () => {
  it("snaps the cloned root onto the live head bone at identity local transform", () => {
    const { bodyRoot, head } = makeBody();
    const attached: Object3D[] = [];
    attachPawnEquipmentSet(capPack(), bodyRoot, ["hat_field_cap"], () => new MeshBasicMaterial(), attached);

    const root = findAttachedCap(bodyRoot);
    expect(root).not.toBeNull();
    expect(root!.parent).toBe(head);
    expect(root!.position.toArray()).toEqual([0, 0, 0]);
    expect(root!.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("cancels the inherited body scale so the cap keeps its authored metric size", () => {
    const { bodyRoot } = makeBody();
    attachPawnEquipmentSet(capPack(), bodyRoot, ["hat_field_cap"], () => new MeshBasicMaterial());

    const root = findAttachedCap(bodyRoot)!;
    expect(root.scale.x).toBeCloseTo(1 / PACK_BODY_SCALE, 6);
    bodyRoot.updateMatrixWorld(true);
    const worldScale = root.getWorldScale(new Vector3());
    expect(worldScale.x).toBeCloseTo(1, 6);
    expect(worldScale.y).toBeCloseTo(1, 6);
    expect(worldScale.z).toBeCloseTo(1, 6);
  });

  it("clones the full multi-mesh hierarchy with node metadata and authored offsets intact", () => {
    const cap = makeCapScene();
    const { bodyRoot } = makeBody();
    attachPawnEquipmentSet(capPack(cap), bodyRoot, ["hat_field_cap"], () => new MeshBasicMaterial());

    const root = findAttachedCap(bodyRoot)!;
    for (const name of ["field_cap_root", "field_cap_crown", "field_cap_bill", "field_cap_eyelet_0"]) {
      expect(root.getObjectByName(name), name).toBeDefined();
    }
    expect(root.getObjectByName("field_cap_bill")!.userData.bake).toBe("pf2-run01");
    const eyelet = root.getObjectByName("field_cap_eyelet_0")!;
    expect(eyelet.position.x).toBeCloseTo(0.065, 6);
    expect(eyelet.position.y).toBeCloseTo(0.18, 6);
    // The SOURCE scene is untouched — clones only.
    expect(cap.scene.getObjectByName("field_cap_crown")!.parent!.name).toBe("field_cap_root");
    expect(cap.scene.parent).toBeNull();
  });

  it("converts native textured materials to unlit map+color and never asks the slot resolver", () => {
    const cap = makeCapScene();
    const { bodyRoot } = makeBody();
    const resolver = vi.fn(() => new MeshBasicMaterial());
    attachPawnEquipmentSet(capPack(cap), bodyRoot, ["hat_field_cap"], resolver);

    expect(resolver).not.toHaveBeenCalled();
    const root = findAttachedCap(bodyRoot)!;
    const crownRaw: unknown = root.getObjectByName("field_cap_crown") instanceof Mesh
      ? (root.getObjectByName("field_cap_crown") as Mesh).material
      : null;
    expect(crownRaw).toBeInstanceOf(MeshBasicMaterial);
    const crownMaterial = crownRaw as MeshBasicMaterial;
    expect(crownMaterial.map).toBe(cap.atlasTexture);
    expect(cap.atlasTexture.colorSpace).toBe(SRGBColorSpace);
    expect(crownMaterial.color.getHexString()).toBe(cap.atlasMaterial.color.getHexString());
    // Array-material meshes convert element-wise.
    const eyelet = root.getObjectByName("field_cap_eyelet_0") as Mesh;
    expect(Array.isArray(eyelet.material)).toBe(true);
    for (const material of eyelet.material as MeshBasicMaterial[]) {
      expect(material).toBeInstanceOf(MeshBasicMaterial);
    }
  });

  it("shares one unlit conversion per source material across bodies (no per-attach churn)", () => {
    const cap = makeCapScene();
    const pack = capPack(cap);
    const first = makeBody();
    const second = makeBody();
    attachPawnEquipmentSet(pack, first.bodyRoot, ["hat_field_cap"], () => new MeshBasicMaterial());
    attachPawnEquipmentSet(pack, second.bodyRoot, ["hat_field_cap"], () => new MeshBasicMaterial());

    const firstCrown = findAttachedCap(first.bodyRoot)!.getObjectByName("field_cap_crown") as Mesh;
    const secondCrown = findAttachedCap(second.bodyRoot)!.getObjectByName("field_cap_crown") as Mesh;
    expect(firstCrown.material).toBe(secondCrown.material);
  });

  it("marks and returns the owned attachment root; removal detaches everything", () => {
    const { bodyRoot, head } = makeBody();
    const attached: Object3D[] = [];
    const attachedItemIds = attachPawnEquipmentSet(capPack(), bodyRoot, ["hat_field_cap"], () => new MeshBasicMaterial(), attached);

    expect(attached).toHaveLength(1);
    expect(attachedItemIds).toEqual(["hat_field_cap"]);
    const root = attached[0]!;
    expect(root.userData.successorEquipmentItemId).toBe("hat_field_cap");
    expect(root.userData.successorEquipmentLayer).toBe("Under");
    expect(root.userData.successorOwnedEquipmentAttachment).toBe(true);
    // The renderer's cleanup loop (attachDefaultEquipment) removes via parent.
    root.parent?.remove(root);
    expect(findAttachedCap(bodyRoot)).toBeNull();
    expect(head!.children).toHaveLength(0);
  });

  it("fails closed when the anchor bone is missing from the live skeleton", () => {
    const { bodyRoot } = makeBody(false);
    const attached: Object3D[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attachedItemIds: readonly string[] = [];
    try {
      attachedItemIds = attachPawnEquipmentSet(capPack(), bodyRoot, ["hat_field_cap"], () => new MeshBasicMaterial(), attached);
    } finally {
      warn.mockRestore();
    }
    expect(attached).toHaveLength(0);
    expect(attachedItemIds).toEqual([]);
    expect(findAttachedCap(bodyRoot)).toBeNull();
  });

  it("leaves the classic SkinnedMesh rebind route unchanged beside a rigid item", () => {
    const scenes = new Map([
      ["hat_field_cap", makeCapScene().scene],
      ["under_tank", makeSkinnedTankScene()],
    ]);
    const pack = makePack(scenes);
    const { bodyRoot, pelvis } = makeBody();
    const tankMaterial = new MeshBasicMaterial();
    const resolver = vi.fn<PawnEquipmentMaterialResolver>(() => tankMaterial);
    const attached: Object3D[] = [];
    attachPawnEquipmentSet(pack, bodyRoot, ["under_tank", "hat_field_cap"], resolver, attached);

    // Resolver serviced ONLY the skinned item.
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![0]).toBe(TANK_ITEM);
    const tank = bodyRoot.children.find((child): child is SkinnedMesh => child instanceof SkinnedMesh);
    expect(tank).toBeDefined();
    expect(tank!.name).toBe("equipment:under_tank:tank");
    expect(tank!.material).toBe(tankMaterial);
    expect(tank!.skeleton.bones[0]).toBe(pelvis); // rebound to the LIVE skeleton
    expect(tank!.userData.successorEquipmentItemId).toBe("under_tank");
    // Both attachments reported for cleanup; the rigid one rides the bone.
    expect(attached).toHaveLength(2);
    expect(findAttachedCap(bodyRoot)).not.toBeNull();
  });

  it("selects an authored female garment for a female body clone", () => {
    const pack = makePack(
      new Map([["under_tank", makeSkinnedTankScene("male_tank")]]),
      new Map([["under_tank", makeSkinnedTankScene("female_tank")]]),
    );
    const { bodyRoot } = makeBody();
    bodyRoot.userData.successorPawnBody = "female";
    attachPawnEquipmentSet(pack, bodyRoot, ["under_tank"], () => new MeshBasicMaterial());

    const tank = bodyRoot.children.find((child): child is SkinnedMesh => child instanceof SkinnedMesh);
    expect(tank?.name).toBe("equipment:under_tank:female_tank");
  });
});

describe("segmented body coverage", () => {
  it("hides only the union of exact body-zone primitives and restores removed coverage", () => {
    const bodyRoot = new Group();
    const torsoMaterial = new MeshStandardMaterial();
    torsoMaterial.name = "BodyZone_torso";
    const pelvisMaterial = new MeshStandardMaterial();
    pelvisMaterial.name = "BodyZone_pelvis";
    const faceMaterial = new MeshStandardMaterial();
    faceMaterial.name = "RB_Face";
    const unknownMaterial = new MeshStandardMaterial();
    unknownMaterial.name = "BodyZone_unknown";
    const torso = new SkinnedMesh(new BoxGeometry(), torsoMaterial);
    const pelvis = new SkinnedMesh(new BoxGeometry(), pelvisMaterial);
    const face = new SkinnedMesh(new BoxGeometry(), faceMaterial);
    const unknown = new SkinnedMesh(new BoxGeometry(), unknownMaterial);
    bodyRoot.add(torso, pelvis, face, unknown);
    const bodyZoneMeshes = collectPawnBodyZoneMeshes(bodyRoot);
    const apparel = new SkinnedMesh(new BoxGeometry(), torsoMaterial);
    bodyRoot.add(apparel);

    const equipment = {
      basePath: "/assets/pawn-pack/equipment",
      items: [
        { ...TANK_ITEM, id: "cover_torso", hideBodyZones: ["torso"] as const },
        { ...TANK_ITEM, id: "cover_pelvis", hideBodyZones: ["pelvis"] as const },
      ],
      scenes: new Map<string, Group>(),
    };
    const lookup = buildPawnEquipmentLookup(equipment);

    applyPawnBodyZoneMask(
      bodyZoneMeshes,
      resolvePawnBodyZoneMask(equipment, ["cover_torso", "cover_pelvis"], lookup),
    );
    expect(torso.visible).toBe(false);
    expect(pelvis.visible).toBe(false);
    expect(face.visible).toBe(true);
    expect(unknown.visible).toBe(true);
    expect(apparel.visible).toBe(true);

    applyPawnBodyZoneMask(
      bodyZoneMeshes,
      resolvePawnBodyZoneMask(equipment, ["cover_torso"], lookup),
    );
    expect(torso.visible).toBe(false);
    expect(pelvis.visible).toBe(true);

    applyPawnBodyZoneMask(bodyZoneMeshes, resolvePawnBodyZoneMask(equipment, [], lookup));
    expect(torso.visible).toBe(true);
    expect(pelvis.visible).toBe(true);
  });
});
