import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import itemModels from "../ui/inventory/itemModels.json";
import { weaponModelAssetKey } from "./weaponModelRegistry";

type WeaponManifest = {
  items: Array<{ id: string; glb: string; attach: string; class: string; scale: number }>;
};

type GlbJson = {
  asset: { generator?: string; version: string };
  nodes: Array<{ mesh?: number; name?: string }>;
  accessors: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    count: number;
    min?: number[];
    max?: number[];
    type?: string;
  }>;
  meshes: Array<{
    primitives: Array<{
      attributes: Record<string, number>;
      indices: number;
      material?: number;
    }>;
  }>;
  materials: Array<{
    name?: string;
    doubleSided?: boolean;
    normalTexture?: { index: number; scale?: number };
    pbrMetallicRoughness?: {
      baseColorTexture?: { index: number };
      metallicRoughnessTexture?: { index: number };
    };
  }>;
  images: Array<{ bufferView: number; mimeType: string; name: string }>;
  bufferViews: Array<{ byteLength: number; byteOffset?: number; byteStride?: number }>;
  animations?: unknown[];
};

type GlbDocument = {
  buffer: Buffer;
  json: GlbJson;
  binStart: number;
};

const publicRoot = resolve(process.cwd(), "public");
const weaponsRoot = resolve(publicRoot, "assets/pawn-pack/weapons");
const manifest = JSON.parse(readFileSync(resolve(weaponsRoot, "weapons_manifest.json"), "utf8")) as WeaponManifest;

function readGlb(path: string): GlbDocument {
  const buffer = readFileSync(path);
  expect(buffer.readUInt32LE(0)).toBe(0x46546c67);
  expect(buffer.readUInt32LE(16)).toBe(0x4e4f534a);
  const jsonLength = buffer.readUInt32LE(12);
  const binHeader = 20 + jsonLength;
  expect(buffer.readUInt32LE(binHeader + 4)).toBe(0x004e4942);
  return {
    buffer,
    json: JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8")) as GlbJson,
    binStart: binHeader + 8,
  };
}

function embeddedImage(document: GlbDocument, name: string): Buffer {
  const image = document.json.images.find((candidate) => candidate.name === name);
  expect(image, name).toBeDefined();
  const view = document.json.bufferViews[image!.bufferView];
  expect(view, name).toBeDefined();
  const start = document.binStart + (view!.byteOffset ?? 0);
  return document.buffer.subarray(start, start + view!.byteLength);
}

function pngDimensions(buffer: Buffer): [number, number] {
  expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

function readVec2Accessor(document: GlbDocument, index: number): Array<[number, number]> {
  const accessor = document.json.accessors[index];
  expect(accessor).toMatchObject({ componentType: 5126, type: "VEC2" });
  const view = document.json.bufferViews[accessor!.bufferView!];
  expect(view).toBeDefined();
  const start = document.binStart + (view!.byteOffset ?? 0) + (accessor!.byteOffset ?? 0);
  const stride = view!.byteStride ?? 8;
  return Array.from({ length: accessor!.count }, (_, vertex) => [
    document.buffer.readFloatLE(start + vertex * stride),
    document.buffer.readFloatLE(start + vertex * stride + 4),
  ]);
}

describe("Scrapline Machete runtime promotion", () => {
  it("routes authority item 3105 through the accepted custom weapon packet", () => {
    expect(itemModels["3105"]).toBe("/assets/pawn-pack/weapons/custom/scrapline_machete.glb");
    expect(weaponModelAssetKey(3105, "scrapline-machete")).toBe("scrapline_machete");
    expect(manifest.items.find((item) => item.id === "scrapline_machete")).toEqual({
      id: "scrapline_machete",
      glb: "custom/scrapline_machete.glb",
      attach: "custom/scrapline_machete_attach.json",
      class: "melee",
      track: "brawler",
      label: "Scrapline Machete",
      tier_hint: "starter",
      scale: 1,
    });
  });

  it("keeps the runtime GLB byte-identical to the accepted July 12 export", () => {
    const path = resolve(weaponsRoot, "custom/scrapline_machete.glb");
    expect(existsSync(path)).toBe(true);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex"))
      .toBe("129ca1b4d07dfa3df23639110bf61fecefc56ff93146551f1ae90c69fc693b10");
    const { json } = readGlb(path);
    expect(json.asset).toEqual({
      generator: "Khronos glTF Blender I/O v5.1.20",
      version: "2.0",
    });
    expect(json.nodes).toEqual([{ mesh: 0, name: "scrapline_machete" }]);
    expect(json.accessors[0]).toMatchObject({
      count: 1199,
      min: [-0.02865000069141388, -0.07649999856948853, -0.02669999934732914],
      max: [0.027499999850988388, 0.5435000061988831, 0.02669999934732914],
    });
    expect(json.meshes[0]!.primitives[0]).toMatchObject({
      attributes: {
        POSITION: 0,
        NORMAL: 1,
        TEXCOORD_0: 2,
        TANGENT: 3,
      },
      material: 0,
    });
    expect(json.accessors[json.meshes[0]!.primitives[0]!.indices]!.count / 3).toBe(1020);
  });

  it("retains the authored UV channel and three embedded 2048 PBR maps", () => {
    const document = readGlb(resolve(weaponsRoot, "custom/scrapline_machete.glb"));
    expect(document.json.materials).toMatchObject([{
      name: "scrapline_machete_mat",
      doubleSided: true,
      normalTexture: { index: 0 },
      pbrMetallicRoughness: {
        baseColorTexture: { index: 1 },
        metallicRoughnessTexture: { index: 2 },
      },
    }]);
    expect(document.json.images.map((image) => [image.name, image.mimeType])).toEqual([
      ["scrapline_machete_normal", "image/png"],
      ["scrapline_machete_basecolor", "image/png"],
      ["scrapline_machete_orm", "image/png"],
    ]);
    const expectedHashes: Record<string, string> = {
      scrapline_machete_basecolor: "0b857984a659fc27f352fe1751ef190dd6c9e2275bcd153ed3f86965693d9710",
      scrapline_machete_normal: "456835961cc87b829d37178a4ff394107da342241d3a19acc8ec79722f3a4b2b",
      scrapline_machete_orm: "5997b1a5822837e7c273bda7680cde88768c0dd15d82f56dcb31ccd0e968bf42",
    };
    for (const [name, hash] of Object.entries(expectedHashes)) {
      const image = embeddedImage(document, name);
      expect(createHash("sha256").update(image).digest("hex"), name).toBe(hash);
      expect(pngDimensions(image), name).toEqual([2048, 2048]);
    }
    const uvAccessor = document.json.meshes[0]!.primitives[0]!.attributes.TEXCOORD_0!;
    const uvs = readVec2Accessor(document, uvAccessor);
    expect(uvs).toHaveLength(1199);
    expect(uvs.every(([u, v]) => Number.isFinite(u) && Number.isFinite(v))).toBe(true);
    expect(uvs.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1)).toBe(true);
    expect(Math.min(...uvs.map(([u]) => u))).toBeCloseTo(0.00390625, 8);
    expect(Math.max(...uvs.map(([u]) => u))).toBeCloseTo(0.99609375, 8);
    expect(Math.min(...uvs.map(([, v]) => v))).toBeCloseTo(0.00390625, 8);
    expect(Math.max(...uvs.map(([, v]) => v))).toBeCloseTo(0.9862499833106995, 8);
    expect(document.json.animations ?? []).toEqual([]);
  });

  it("ships a one-hand grip-midpoint attach contract with source provenance", () => {
    const path = resolve(weaponsRoot, "custom/scrapline_machete_attach.json");
    expect(existsSync(path)).toBe(true);
    const attach = JSON.parse(readFileSync(path, "utf8")) as {
      mount_hand_r_local: { quat: number[] };
      sockets: { grip: number[]; muzzle: number[]; stock: number[] };
      measured_runtime: { overall_length_m: number };
    } & Record<string, unknown>;
    expect(attach).toMatchObject({
      schema: "successor-weapon-attach/1",
      weapon: "scrapline_machete",
      item_id: 3105,
      source_sha256: "129ca1b4d07dfa3df23639110bf61fecefc56ff93146551f1ae90c69fc693b10",
      source_blend_scope: expect.stringContaining("not Scrapline"),
      scale_to_pawn: 1,
      nodes: { frame: "scrapline_machete" },
      sockets: {
        grip: [0, 0, 0],
        muzzle: [0, 0.5435, 0],
        stock: [0, -0.0765, 0],
      },
      orientation: { forward: [0, 1, 0], up: [0, 0, 1] },
      measured_runtime: { triangles: 1020, overall_length_m: 0.62 },
    });
    expect(Math.hypot(...attach.mount_hand_r_local.quat)).toBeCloseTo(1, 5);
    expect(attach.sockets.muzzle[1]! - attach.sockets.stock[1]!)
      .toBeCloseTo(attach.measured_runtime.overall_length_m, 8);
  });

  it("records the honest source packet and approved Successor camera proof", () => {
    const path = resolve(weaponsRoot, "custom/scrapline_machete.provenance.json");
    expect(existsSync(path)).toBe(true);
    const provenance = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(provenance).toMatchObject({
      schema: "successor-asset-provenance/1",
      asset_id: "scrapline_machete",
      asset_hash: "sha256:129ca1b4d07dfa3df23639110bf61fecefc56ff93146551f1ae90c69fc693b10",
      source: {
        glb: {
          sha256: "129ca1b4d07dfa3df23639110bf61fecefc56ff93146551f1ae90c69fc693b10",
        },
        builder: {
          sha256: "fa6d78d5490ec60b03c92f9a9038659e1931582d7b3535d59a6ca48bbb7fd99d",
        },
        family_blend_snapshot: {
          contains_promoted_asset: false,
        },
      },
      rights: {
        source_license: "Successor proprietary project asset; all rights reserved",
        redistribution_status: "authorized for Successor runtime distribution only; no standalone reuse grant",
      },
      validation: {
        runtime_hash_matches_source: true,
        family_gate_report_pass: true,
        successor_in_camera_review: expect.stringContaining(
          "client3d-gate-20260714204314-6f9b6f2d/client3d-gate-report.json",
        ),
      },
    });
  });
  it("promotes the Field Saber and Quarry Chopper as distinct primitive starter blades", () => {
    const expected = [
      {
        id: "field_saber",
        itemId: 3106,
        hash: "fbbb2d51e0fe55de028951ebd4ea3593f088922fae840eff28529f85a6c7e95f",
        triangles: 2416,
      },
      {
        id: "quarry_chopper",
        itemId: 3107,
        hash: "a00ac2049ed552151f31ce775c865299c5bd3291405ad518700d7d57c55f32e3",
        triangles: 2308,
      },
    ] as const;
    for (const blade of expected) {
      const manifestEntry = manifest.items.find((item) => item.id === blade.id);
      expect(manifestEntry).toMatchObject({
        id: blade.id,
        glb: `custom/${blade.id}.glb`,
        attach: `custom/${blade.id}_attach.json`,
        class: "melee",
        track: "brawler",
        tier_hint: "starter",
      });
      expect(itemModels[String(blade.itemId) as keyof typeof itemModels])
        .toBe(`/assets/pawn-pack/weapons/custom/${blade.id}.glb`);
      expect(weaponModelAssetKey(blade.itemId, blade.id.replaceAll("_", "-"))).toBe(blade.id);
      const glbPath = resolve(weaponsRoot, `custom/${blade.id}.glb`);
      expect(createHash("sha256").update(readFileSync(glbPath)).digest("hex")).toBe(blade.hash);
      const document = readGlb(glbPath);
      const triangleCount = document.json.meshes.reduce(
        (sum, mesh) => sum + mesh.primitives.reduce(
          (meshSum, primitive) => meshSum + document.json.accessors[primitive.indices]!.count / 3,
          0,
        ),
        0,
      );
      expect(triangleCount).toBe(blade.triangles);
    }
  });

  it("promotes the final powered Vibrosword after deterministic and visual gates", () => {
    const glbPath = resolve(publicRoot, "assets/pawn-pack/vibrosword.glb");
    const glb = readFileSync(glbPath);
    expect(createHash("sha256").update(glb).digest("hex"))
      .toBe("f81f42214828e71baafac2f0905f3b3b3c1558da329876976f67639721027121");
    expect(itemModels["3103"]).toBe("/assets/pawn-pack/vibrosword.glb");

    const document = readGlb(glbPath);
    expect(document.json.nodes.filter((node) => node.mesh !== undefined).map((node) => node.name))
      .toEqual(["Gear_vibrosword_powered"]);
    expect(document.json.materials.map((material) => material.name)).toEqual([
      "VibroSteel",
      "VibroHousing",
      "VibroGrip",
      "VibroCell",
      "VibroTrim",
    ]);
    expect(document.json.images).toHaveLength(4);
    const triangleCount = document.json.meshes.reduce(
      (sum, mesh) => sum + mesh.primitives.reduce(
        (meshSum, primitive) => meshSum + document.json.accessors[primitive.indices]!.count / 3,
        0,
      ),
      0,
    );
    expect(triangleCount).toBe(2472);

    const attach = JSON.parse(
      readFileSync(resolve(publicRoot, "assets/pawn-pack/vibrosword_attach.json"), "utf8"),
    ) as {
      attach: string;
      scale_to_pawn: number;
      nodes: { frame: string };
      sockets: { grip: number[] };
      mount_hand_r_local: { pos: number[]; quat: number[] };
    };
    expect(attach).toMatchObject({
      attach: "one_hand",
      scale_to_pawn: 1,
      nodes: { frame: "Gear_vibrosword_powered" },
      sockets: { grip: [0, 0, -0.1525] },
      mount_hand_r_local: {
        pos: [0.05121, 0.124, 0.14622],
        quat: [0.1213, -0.24455, -0.23404, -0.93312],
      },
    });
    const provenance = JSON.parse(
      readFileSync(resolve(publicRoot, "assets/pawn-pack/vibrosword.provenance.json"), "utf8"),
    ) as {
      validation: {
        gltf_errors: number;
        triangle_budget_pass: boolean;
        deterministic_rebuild: boolean;
        mount_resolved_for_grip_midpoint: boolean;
        headed_runtime_pass: boolean;
        headed_run_id: string;
      };
      review: { status: string };
    };
    expect(provenance.validation).toMatchObject({
      gltf_errors: 0,
      triangle_budget_pass: true,
      deterministic_rebuild: true,
      mount_resolved_for_grip_midpoint: true,
      headed_runtime_pass: true,
      headed_run_id: "weapon-melee-powered-final-20260715",
    });
    expect(provenance.review.status).toBe("source-and-headed-runtime-pass");
  });

});
