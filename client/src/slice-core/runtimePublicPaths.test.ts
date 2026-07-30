import { describe, expect, it, vi } from "vitest";

import {
  requireRuntimePublicPath,
  resolveRuntimePublicPath,
  runtimePublicAssetPath,
} from "./runtimePublicPaths";

describe("runtimePublicPaths", () => {
  it("accepts only current slice-root overrides", () => {
    expect(runtimePublicAssetPath("slicePath", "/default.json", "?slicePath=/successor-slice/test.json"))
      .toBe("/successor-slice/test.json");
  });

  it("maps root public paths below an immutable document directory", () => {
    expect(resolveRuntimePublicPath("/assets/pawn-pack/pawn_male.glb", "https://cdn.test/releases/fakehash/index.html"))
      .toBe("/releases/fakehash/assets/pawn-pack/pawn_male.glb");
    expect(resolveRuntimePublicPath("/releases/fakehash/assets/pawn_male.glb", "https://cdn.test/releases/fakehash/index.html"))
      .toBe("/releases/fakehash/assets/pawn_male.glb");
    expect(resolveRuntimePublicPath("/releases/fakehash/assets/pawn-pack/equipment/../../items/custom/accessories/field_cap.glb", "https://cdn.test/releases/fakehash/index.html"))
      .toBe("/releases/fakehash/assets/items/custom/accessories/field_cap.glb");
  });

  it("rebases dynamic placed-entity assets into immutable browser releases", () => {
    const releaseDocument = "https://cdn.test/releases/fakehash/index.html";

    expect(requireRuntimePublicPath("/assets/world-items/extractor_mineral.glb", releaseDocument))
      .toBe("/releases/fakehash/assets/world-items/extractor_mineral.glb");
    expect(requireRuntimePublicPath("/assets/world-items/podtent_scout.glb", releaseDocument))
      .toBe("/releases/fakehash/assets/world-items/podtent_scout.glb");
    expect(requireRuntimePublicPath("/assets/world-items/campfire_scout.glb", releaseDocument))
      .toBe("/releases/fakehash/assets/world-items/campfire_scout.glb");
    expect(requireRuntimePublicPath("/assets/items/custom/crops/world/ashgrain/laden.glb", releaseDocument))
      .toBe("/releases/fakehash/assets/items/custom/crops/world/ashgrain/laden.glb");
  });

  it("preserves root paths for headless hosts and refuses traversal", () => {
    expect(resolveRuntimePublicPath("/successor-slice/test.json", undefined)).toBe("/successor-slice/test.json");
    expect(resolveRuntimePublicPath("/successor-slice/../secret", undefined)).toBeNull();
  });

  it("rejects traversal outside a release and external URL overrides", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(runtimePublicAssetPath("slicePath", "/default.json", "?slicePath=/successor-slice/../secret"))
      .toBe("/default.json");
    expect(runtimePublicAssetPath("slicePath", "/default.json", "?slicePath=https://example.com/slice.json"))
      .toBe("/default.json");
    expect(resolveRuntimePublicPath("//evil.example/asset")).toBeNull();
    expect(resolveRuntimePublicPath("/assets/%2e%2e/secret", "https://cdn.test/releases/fakehash/index.html")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });
});
