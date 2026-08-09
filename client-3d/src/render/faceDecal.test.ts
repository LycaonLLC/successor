// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SkinnedMesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPawnFaceDecal, faceSignature, type PawnFaceConfig } from "./faceDecal";

function exactArrayBuffer(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const face: PawnFaceConfig = {
  eyes: "veteran",
  brows: "sharp",
  nose: "rogue",
  mouth: "feral",
  eye_color: "#78955e",
  brow_color: "#35241e",
  lip_color: "#6c3438",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("world face decal", () => {
  it("replaces the static authored panel with a transparent live overlay", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("atlas fetch intentionally isolated"))));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const glbPath = resolve(process.cwd(), "public/assets/pawn-pack/pawn_male.glb");
    const gltf = await new GLTFLoader().parseAsync(exactArrayBuffer(glbPath), "");
    let authoredPanel: SkinnedMesh | null = null;
    gltf.scene.traverse((object) => {
      if (!(object instanceof SkinnedMesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.every((material) =>
        material.name === "RB_Face" || material.name.startsWith("RB_Face:"))) {
        authoredPanel = object;
      }
    });
    expect(authoredPanel).not.toBeNull();

    const attachments: Array<SkinnedMesh> = [];
    attachPawnFaceDecal(gltf.scene, face, attachments);

    expect(attachments).toHaveLength(1);
    const overlay = attachments[0]!;
    expect(authoredPanel!.visible).toBe(false);
    expect(overlay.name).toBe("appearance:face");
    expect(overlay.userData.successorFaceSignature).toBe(faceSignature(face));
    expect(overlay.skeleton).toBe(authoredPanel!.skeleton);
    expect(overlay.geometry.index?.count ?? 0).toBeGreaterThan(0);
    const uv = overlay.geometry.attributes.uv;
    expect(uv?.count ?? 0).toBeGreaterThan(0);
    for (let vertex = 0; vertex < (uv?.count ?? 0); vertex += 1) {
      expect(uv!.getX(vertex)).toBeGreaterThanOrEqual(0);
      expect(uv!.getX(vertex)).toBeLessThanOrEqual(1);
      expect(uv!.getY(vertex)).toBeGreaterThanOrEqual(0);
      expect(uv!.getY(vertex)).toBeLessThanOrEqual(1);
    }
    expect(overlay.parent).not.toBeNull();

    attachPawnFaceDecal(gltf.scene, null);
    expect(authoredPanel!.visible).toBe(true);
  });
});
