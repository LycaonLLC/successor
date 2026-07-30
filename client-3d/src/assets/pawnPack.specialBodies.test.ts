import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Group } from "three";

const loaderState = vi.hoisted(() => ({
  rejectSpecial: true,
  rejectCoreSuffix: null as string | null,
}));

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", async () => {
  const { Group: ActualGroup } = await vi.importActual<typeof import("three")>("three");
  return {
    GLTFLoader: class {
      loadAsync(url: string): Promise<{ scene: Group; animations: [] }> {
        if (loaderState.rejectSpecial && url.includes("/special/")) {
          return Promise.reject(new Error(`optional model unavailable: ${url}`));
        }
        if (loaderState.rejectCoreSuffix && url.endsWith(loaderState.rejectCoreSuffix)) {
          return Promise.reject(new Error(`core model unavailable: ${url}`));
        }
        return Promise.resolve({ scene: new ActualGroup(), animations: [] });
      }
    },
  };
});

vi.mock("../ui/inventory/data", () => ({
  registerLocalGearCatalog: vi.fn(),
}));

vi.mock("../ui/inventory/equippedGearStore", () => ({
  get: vi.fn(() => []),
  registerKnownGearIds: vi.fn(),
}));

import { clonePawnBody, cloneSpecialPawnBody, loadPawnPack } from "./pawnPack";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchPawnPackFile(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.endsWith("/game_pack.json")) {
    return Promise.resolve(jsonResponse({ schema: "test", pawns: { male: { file: "pawn_male.glb", height_m: 1.7525 } }, clips: [] }));
  }
  if (url.endsWith("/manifest_anim.json")) {
    return Promise.resolve(jsonResponse({ masks: {}, procedural: { torso_yaw: {} }, clips: {} }));
  }
  if (url.endsWith("/slugthrower_attach.json")) {
    return Promise.resolve(jsonResponse({
      sockets: { grip: [0, 0, 0], foregrip: [0, 0, 0], muzzle: [0, 0, 0], stock: [0, 0, 0] },
      nodes: { frame: "frame" },
      mount_hand_r_local: { pos: [0, 0, 0], quat: [0, 0, 0, 1] },
    }));
  }
  if (url.endsWith("/vibrosword_attach.json")) {
    return Promise.resolve(jsonResponse({
      sockets: { guard_plane: [0, 0, 0], wrap_top: [0, 0, 0], wrap_mid: [0, 0, 0], wrap_bottom: [0, 0, 0], pommel: [0, 0, 0] },
      nodes: { frame: "frame" },
      mount_hand_r_local: { pos: [0, 0, 0], quat: [0, 0, 0, 1] },
    }));
  }
  if (url.endsWith("/equipment/manifest.json") || url.endsWith("/weapons/weapons_manifest.json")) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  return Promise.reject(new Error(`unexpected pawn-pack fetch: ${url}`));
}

beforeEach(() => {
  loaderState.rejectSpecial = true;
  loaderState.rejectCoreSuffix = null;
  vi.stubGlobal("fetch", vi.fn(fetchPawnPackFile));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loadPawnPack optional special bodies", () => {
  it("keeps boot and the standard-body fallback alive when GR0K's GLB rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const firstPromise = loadPawnPack();
    await expect(firstPromise).resolves.toBeDefined();
    const first = await firstPromise;
    const second = await loadPawnPack();

    expect(first.specialBodies.has("droid_grok_humanoid")).toBe(false);
    expect(second.specialBodies.has("droid_grok_humanoid")).toBe(false);
    const fallback = cloneSpecialPawnBody(first, "droid_grok_humanoid") ?? clonePawnBody(first, "male");
    expect(fallback).toBeInstanceOf(Group);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("using standard pawn fallback");
  });

  it("still rejects boot when a core player body fails", async () => {
    loaderState.rejectSpecial = false;
    loaderState.rejectCoreSuffix = "/pawn_male.glb";

    await expect(loadPawnPack()).rejects.toThrow("core model unavailable");
  });
});
