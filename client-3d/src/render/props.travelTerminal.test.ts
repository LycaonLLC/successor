// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Box3, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import propsMapping from "./props-mapping.json";
import { animatedScreenFrame, applyPropAssetSpaceRotation } from "./props";

interface GlbJson {
  nodes?: Array<{ name?: string }>;
  images?: Array<{ name?: string }>;
  materials?: Array<{ name?: string }>;
}

interface SliceFixture {
  props: Array<{ id: string; kind: string; assetKey?: string; rotation?: number }>;
}

function readGlbJson(path: string): GlbJson {
  const bytes = readFileSync(path);
  expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").replace(/\0+$/u, "")) as GlbJson;
}

function exactArrayBuffer(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("Grok wedge travel terminal", () => {
  const publicRoot = resolve(process.cwd(), "public");
  const glbPath = resolve(publicRoot, "assets/world-items/travel_terminal_grok_wedge.glb");
  const stripPath = resolve(publicRoot, "assets/world-items/travel_terminal_grok_wedge_screen.png");
  const slicePath = resolve(process.cwd(), "../client/public/successor-slice/open-desert-slice.json");

  it("replaces the procedural terminal with the authored GLB and live screen contract", () => {
    expect(propsMapping.entries.travel_terminal).toEqual({
      glb: "travel_terminal_grok_wedge.glb",
      interactable: true,
      assetRotationDegrees: [-90, 0, 0],
      nodeTransforms: [
        { node: "Module_screen", translate: [0, -0.16, 0] },
      ],
      animatedScreen: {
        node: "Module_screen",
        texture: "travel_terminal_grok_wedge_screen.png",
        speed: 0.16,
        pulseHz: 0.62,
        repeatY: 0.28,
      },
    });
  });

  it("corrects the authored Z-up terminal before footprint fitting", async () => {
    const gltf = await new GLTFLoader().parseAsync(exactArrayBuffer(glbPath), "");
    const screen = gltf.scene.getObjectByName("Module_screen");
    expect(screen).toBeDefined();
    const screenTransform = propsMapping.entries.travel_terminal.nodeTransforms[0];
    expect(screenTransform?.node).toBe("Module_screen");
    screen!.position.add(new Vector3(...screenTransform!.translate));
    applyPropAssetSpaceRotation(
      gltf.scene,
      propsMapping.entries.travel_terminal.assetRotationDegrees,
    );
    gltf.scene.updateMatrixWorld(true);

    const size = new Box3().setFromObject(gltf.scene).getSize(new Vector3());
    expect(size.x).toBeGreaterThan(0.7);
    expect(size.x).toBeLessThan(0.9);
    expect(size.y).toBeGreaterThan(1.5);
    expect(size.y).toBeLessThan(1.7);
    expect(size.z).toBeGreaterThan(0.5);
    expect(size.z).toBeLessThan(0.7);
    expect(size.y).toBeGreaterThan(Math.max(size.x, size.z) * 1.8);

    const screenCenter = screen!.getWorldPosition(new Vector3());
    expect(screenCenter.y).toBeCloseTo(1.22, 2);
    expect(screenCenter.z).toBeCloseTo(0.382, 2);
    expect(screenCenter.z).toBeGreaterThan(0.365); // proud of the weather hood
  });

  it("faces every wedge-terminal reuse toward the locked north-up camera", () => {
    const slice = JSON.parse(readFileSync(slicePath, "utf8")) as SliceFixture;
    expect(slice.props
      .filter((prop) => prop.assetKey === "travel_terminal")
      .map(({ id, kind, rotation }) => ({ id, kind, rotation })))
      .toEqual([
        { id: "travel-terminal-dustgate", kind: "travel_terminal", rotation: 0 },
        { id: "travel-terminal-lowbough", kind: "travel_terminal", rotation: 0 },
      ]);
  });

  it("ships the modular screen/use sockets and embedded PBR texture set", () => {
    const glb = readGlbJson(glbPath);
    const nodeNames = (glb.nodes ?? []).map((node) => node.name);
    const names = new Set(nodeNames);
    for (const expectedName of [
      "Module_base",
      "Module_column",
      "Module_conduit",
      "Module_controls",
      "Module_head",
      "Module_screen",
      "Socket_screen_center",
      "Socket_use",
    ]) expect(names.has(expectedName), expectedName).toBe(true);
    expect(nodeNames.filter((name) => name === "Module_screen")).toHaveLength(1);
    expect((glb.materials ?? []).map((material) => material.name)).toEqual(["Terminal_PBR"]);
    expect((glb.images ?? []).map((image) => image.name).sort()).toEqual([
      "terminal_basecolor",
      "terminal_emissive",
      "terminal_normal",
      "terminal_orm",
    ]);
    expect(readFileSync(stripPath).subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("scrolls and pulses deterministically instead of presenting a frozen screen", () => {
    const start = animatedScreenFrame(0, 0.16, 0.62);
    const later = animatedScreenFrame(2.5, 0.16, 0.62);
    expect(start.offsetY).toBe(0);
    expect(later.offsetY).toBeCloseTo(0.4);
    expect(later.brightness).not.toBeCloseTo(start.brightness);
    expect(later.brightness).toBeGreaterThanOrEqual(0.68);
    expect(later.brightness).toBeLessThanOrEqual(1.08);
  });
});
