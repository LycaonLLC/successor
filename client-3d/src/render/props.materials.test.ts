// @vitest-environment happy-dom
import { MeshBasicMaterial, MeshMatcapMaterial, MeshStandardMaterial, Scene } from "three";
import { describe, expect, it } from "vitest";
import { WorldPropsRenderer } from "./props";

/**
 * Solid-material transparency propagation (commerce audit 2026-07-18):
 * authored glazing like CM_TealGlass exports as a maps-free BLEND material
 * (opacity 0.22). The matcap conversion path used to drop transparency and
 * rendered glass as an opaque slab, blocking the bank teller counter view.
 */
type ConvertSeam = { convertMaterial(source: MeshStandardMaterial): MeshMatcapMaterial | MeshBasicMaterial };

function convertSeam(): ConvertSeam {
  const renderer = new WorldPropsRenderer(new Scene());
  // Test seam: convertMaterial is private; the cast exposes only the method under test.
  const seam = renderer as unknown as ConvertSeam;
  return seam;
}

describe("WorldPropsRenderer material conversion — solid (maps-free) path", () => {
  it("propagates authored blend transparency into the matcap material", () => {
    const glass = convertSeam().convertMaterial(new MeshStandardMaterial({ color: "#175055", transparent: true, opacity: 0.22 }));
    expect(glass).toBeInstanceOf(MeshMatcapMaterial);
    expect(glass.transparent).toBe(true);
    expect(glass.opacity).toBeCloseTo(0.22, 5);
    // Transparent glazing must not occlude depth-sorted content behind it.
    expect(glass.depthWrite).toBe(false);
  });

  it("keeps opaque solids opaque with depth writes on", () => {
    const basalt = convertSeam().convertMaterial(new MeshStandardMaterial({ color: "#3e4147" }));
    expect(basalt.transparent).toBe(false);
    expect(basalt.opacity).toBe(1);
    expect(basalt.depthWrite).toBe(true);
  });

  it("caches transparent and opaque variants of the same color separately", () => {
    const seam = convertSeam();
    const glass = seam.convertMaterial(new MeshStandardMaterial({ color: "#175055", transparent: true, opacity: 0.22 }));
    const solid = seam.convertMaterial(new MeshStandardMaterial({ color: "#175055" }));
    expect(glass).not.toBe(solid);
    expect(solid.transparent).toBe(false);
  });
});
