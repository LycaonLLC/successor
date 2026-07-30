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
  it("cuts and binds a painted overlay from the shipped pawn head geometry", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("atlas fetch intentionally isolated"))));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const glbPath = resolve(process.cwd(), "public/assets/pawn-pack/pawn_male.glb");
    const gltf = await new GLTFLoader().parseAsync(exactArrayBuffer(glbPath), "");
    let body: SkinnedMesh | null = null;
    gltf.scene.traverse((object) => {
      if (!body && object instanceof SkinnedMesh) body = object;
    });
    expect(body).not.toBeNull();

    const attachments: Array<SkinnedMesh> = [];
    attachPawnFaceDecal(gltf.scene, face, attachments);

    expect(attachments).toHaveLength(1);
    const overlay = attachments[0]!;
    expect(overlay.name).toBe("appearance:face");
    expect(overlay.userData.successorFaceSignature).toBe(faceSignature(face));
    expect(overlay.skeleton).toBe(body!.skeleton);
    expect(overlay.geometry.index?.count ?? 0).toBeGreaterThan(0);
    expect(overlay.geometry.attributes.uv?.count ?? 0).toBeGreaterThan(0);
    expect(overlay.parent).not.toBeNull();
  });
});
