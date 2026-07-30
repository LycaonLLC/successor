// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnimationMixer, Bone } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";

// `pawns.ts` normally warms the browser equipment-material cache at import
// time. This asset-contract test does not use that subsystem; isolate it so a
// localhost fetch failure cannot bury a real rig/animation regression.
vi.mock("../assets/equipmentMaterials", () => ({
  ensureEquipmentUv: vi.fn(),
  equipmentSourceMaterialFromUserData: vi.fn(() => null),
  getEquipmentMaterialSets: vi.fn(() => Promise.resolve({})),
  resolveEquipmentSlotMaterial: vi.fn(() => null),
  stashEquipmentSourceMaterialIdentity: vi.fn(),
  worldMaterialFor: vi.fn(() => null),
}));

import { SPECIAL_HUMANOID_BODY_BY_SPRITE } from "./pawns";

interface GlbJson {
  nodes?: Array<{ name?: string }>;
  skins?: Array<{ joints?: number[] }>;
  materials?: Array<{ name?: string }>;
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
}

function readGlbJson(path: string): GlbJson {
  const bytes = readFileSync(path);
  expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").replace(/\0+$/u, "")) as GlbJson;
}

function jointNames(glb: GlbJson): string[] {
  return [...new Set((glb.skins ?? []).flatMap((skin) => skin.joints ?? [])
    .map((index) => glb.nodes?.[index]?.name)
    .filter((name): name is string => Boolean(name)))].sort();
}

function exactArrayBuffer(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("GR0K special humanoid contract", () => {
  const publicRoot = resolve(process.cwd(), "public");
  const droidPath = resolve(publicRoot, "assets/pawn-pack/special/droid_grok_humanoid.glb");
  const playerPath = resolve(publicRoot, "assets/pawn-pack/pawn_male.glb");
  const slicePath = resolve(process.cwd(), "../client/public/successor-slice/open-desert-slice.json");

  it("routes only the exact GR0K sprite to the authored droid body", () => {
    expect(SPECIAL_HUMANOID_BODY_BY_SPRITE).toEqual({
      "droid-grok-humanoid": "droid_grok_humanoid",
    });
  });

  it("ships a rig that exactly matches the live 50-bone pawn skeleton", () => {
    const droid = readGlbJson(droidPath);
    const player = readGlbJson(playerPath);
    expect(jointNames(droid)).toEqual(jointNames(player));
    expect(jointNames(droid)).toHaveLength(50);
  });

  it("binds and advances the live idle clip on GR0K's actual skeleton", async () => {
    const loader = new GLTFLoader();
    const [droid, player] = await Promise.all([
      loader.parseAsync(exactArrayBuffer(droidPath), ""),
      loader.parseAsync(exactArrayBuffer(playerPath), ""),
    ]);
    const idle = player.animations.find((clip) => clip.name === "idle");
    expect(idle).toBeDefined();
    const bones: Bone[] = [];
    droid.scene.traverse((object) => {
      if (object instanceof Bone) bones.push(object);
    });
    expect(bones).toHaveLength(50);
    const before = bones.map((bone) => [...bone.position.toArray(), ...bone.quaternion.toArray()]);

    const mixer = new AnimationMixer(droid.scene);
    mixer.clipAction(idle!).play();
    mixer.update(0.37);

    const changedBones = bones.filter((bone, index) => {
      const after = [...bone.position.toArray(), ...bone.quaternion.toArray()];
      return after.some((value, component) => Math.abs(value - before[index]![component]!) > 1e-6);
    });
    expect(changedBones.length).toBeGreaterThan(8);
    mixer.stopAllAction();
    mixer.uncacheRoot(droid.scene);
  });

  it("retains the six authored material zones and UV/skinning attributes", () => {
    const droid = readGlbJson(droidPath);
    expect((droid.materials ?? []).map((material) => material.name)).toEqual([
      "DroidShell",
      "DroidDark",
      "DroidJoint",
      "DroidPiston",
      "DroidCore",
      "DroidOptic",
    ]);
    for (const mesh of droid.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        expect(primitive.attributes).toMatchObject({
          POSITION: expect.any(Number),
          NORMAL: expect.any(Number),
          TEXCOORD_0: expect.any(Number),
          JOINTS_0: expect.any(Number),
          WEIGHTS_0: expect.any(Number),
        });
      }
    }
  });

  it("places GR0K in the generated start zone as a neutral social actor", () => {
    const slice = JSON.parse(readFileSync(slicePath, "utf8")) as {
      actors: Array<Record<string, unknown>>;
    };
    expect(slice.actors.find((actor) => actor.id === "grok")).toMatchObject({
      label: "GR0K",
      role: "scripted_player",
      sprite: "droid-grok-humanoid",
      factionId: "desert_wardens",
      pvpStatus: "none",
      professionIds: [],
      skillBoxIds: [],
      route: [],
    });
  });
});
