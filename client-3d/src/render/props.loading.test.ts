// @vitest-environment happy-dom
import { Scene } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  WORLD_PROP_ASSET_LOAD_TIMEOUT_MS,
  resolvePropFitFootprint,
  WorldPropsRenderer,
  withWorldPropAssetLoadTimeout,
} from "./props";

interface RendererLoaderSeam {
  loadAsync(path: string): Promise<never>;
}

interface RendererSeam {
  loader: RendererLoaderSeam;
}


afterEach(() => {
  vi.useRealTimers();
});
describe("world-prop authored footprint", () => {
  it("keeps decorative overhangs from shrinking gameplay scale", () => {
    expect(resolvePropFitFootprint(8.056, 7.454, [7.6, 5.7])).toEqual([7.6, 5.7]);
    expect(resolvePropFitFootprint(8.056, 7.454)).toEqual([8.056, 7.454]);
  });
});


describe("world-prop asset load boundary", () => {
  it("rejects a never-settling load with the exact asset path", async () => {
    vi.useFakeTimers();
    const assetPath = "/assets/world-items/clone_terminal.glb";
    const load = withWorldPropAssetLoadTimeout(new Promise<never>(() => {}), assetPath);
    const rejected = expect(load).rejects.toThrow(`world props: timed out loading ${assetPath}`);

    await vi.advanceTimersByTimeAsync(WORLD_PROP_ASSET_LOAD_TIMEOUT_MS);
    await rejected;
  });

  it("clears its timer when loading succeeds, with no late timeout", async () => {
    vi.useFakeTimers();
    const load = withWorldPropAssetLoadTimeout(Promise.resolve("loaded"), "/assets/world-items/bank_terminal_civic.glb");

    await expect(load).resolves.toBe("loaded");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WORLD_PROP_ASSET_LOAD_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the existing placeholder catch handle a timed-out prop", async () => {
    vi.useFakeTimers();
    const renderer = new WorldPropsRenderer(new Scene());
    const seam = renderer as unknown as RendererSeam;
    const loader = seam.loader;
    loader.loadAsync = () => new Promise<never>(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const slice = {
      props: [{
        id: "bank-terminal-timeout",
        entity: "bank-terminal-timeout",
        areaId: "area",
        label: "Bank terminal",
        kind: "bank_terminal_civic",
        assetKey: "bank_terminal_civic",
        cell: { x: 2, y: 3 },
        size: { w: 1, h: 1 },
        interactive: true,
      }],
    } as unknown as SliceSnapshot;

    const load = renderer.load(slice, "area");
    await vi.advanceTimersByTimeAsync(WORLD_PROP_ASSET_LOAD_TIMEOUT_MS);
    await load;

    expect(renderer.getStats()).toMatchObject({ glbPropCount: 0, placeholderPropCount: 1 });
    expect(consoleError).toHaveBeenCalledWith(
      "world props: failed to load bank_terminal_civic.glb; using placeholder",
      expect.objectContaining({ message: "world props: timed out loading /assets/world-items/bank_terminal_civic.glb" }),
    );
    consoleError.mockRestore();
    renderer.dispose();
  });
});
