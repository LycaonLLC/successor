import { describe, expect, it } from "vitest";
import viteConfig, {
  emptyProductionAssetIdentity,
  productionDefineEnv,
  readProductionAssetIdentity,
  validateClientReleaseId,
  validateStorefrontOrigin,
} from "../vite.config";

describe("production client release identity", () => {
  it("accepts the approved safe base@hash form for hosted releases", () => {
    expect(validateClientReleaseId("successor-alpha@a2d02071e180f9df", "hosted-release")).toBe(
      "successor-alpha@a2d02071e180f9df",
    );
  });

  it("requires a client release id in hosted-release mode", () => {
    expect(() => validateClientReleaseId(undefined, "hosted-release")).toThrow("SUCCESSOR_CLIENT_RELEASE_ID");
    expect(() => validateClientReleaseId("fixture-identity", "hosted-release")).toThrow("SUCCESSOR_CLIENT_RELEASE_ID");
    expect(() => validateClientReleaseId("successor alpha@a2d02071e180f9df", "hosted-release")).toThrow(
      "SUCCESSOR_CLIENT_RELEASE_ID",
    );
  });

  it("keeps the dev/offline fallback empty without weakening hosted validation", () => {
    expect(validateClientReleaseId(undefined, "offline-full")).toBe("");
    expect(validateStorefrontOrigin(undefined, "offline-full")).toBe("");
  });

  it("defines asset and protocol identities independently from an explicit fixture", () => {
    const assetIdentity = {
      releaseId: "fixture-asset-release@0123456789abcdef",
      contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    const define = productionDefineEnv({
      assetIdentity,
      packageMode: "hosted-release",
      clientReleaseId: "successor-alpha@a2d02071e180f9df",
      storefrontOrigin: "https://storefront.example.test",
      gameOrigin: "wss://world.example.test",
      chatOrigin: "wss://world.example.test",
      serverReleaseId: "server-fixture",
    });
    expect(define["import.meta.env.SUCCESSOR_ASSET_RELEASE_ID"]).toBe(JSON.stringify(assetIdentity.releaseId));
    expect(define["import.meta.env.SUCCESSOR_ASSET_CONTENT_HASH"]).toBe(JSON.stringify(assetIdentity.contentHash));
    expect(define["import.meta.env.SUCCESSOR_CLIENT_RELEASE_ID"]).toBe(
      JSON.stringify("successor-alpha@a2d02071e180f9df"),
    );
    expect(define["import.meta.env.SUCCESSOR_STOREFRONT_ORIGIN"]).toBe(
      JSON.stringify("https://storefront.example.test"),
    );
    // Asset fixture is independent of protocol/client release ids.
    expect(define["import.meta.env.SUCCESSOR_ASSET_RELEASE_ID"]).not.toBe(
      define["import.meta.env.SUCCESSOR_CLIENT_RELEASE_ID"],
    );
  });

  it("reads production asset identity at call time, not module import time", () => {
    expect(emptyProductionAssetIdentity()).toEqual({ releaseId: "", contentHash: "" });
    expect(readProductionAssetIdentity("/no/such/manifest.json")).toEqual({ releaseId: "", contentHash: "" });

    const previous = {
      packageMode: process.env.SUCCESSOR_PACKAGE_MODE,
      clientReleaseId: process.env.SUCCESSOR_CLIENT_RELEASE_ID,
      storefrontOrigin: process.env.SUCCESSOR_STOREFRONT_ORIGIN,
      gameOrigin: process.env.SUCCESSOR_GAME_ORIGIN,
      chatOrigin: process.env.SUCCESSOR_CHAT_ORIGIN,
    };
    process.env.SUCCESSOR_PACKAGE_MODE = "hosted-release";
    process.env.SUCCESSOR_CLIENT_RELEASE_ID = "successor-alpha@a2d02071e180f9df";
    process.env.SUCCESSOR_STOREFRONT_ORIGIN = "https://storefront.example.test";
    process.env.SUCCESSOR_GAME_ORIGIN = "wss://world.example.test";
    process.env.SUCCESSOR_CHAT_ORIGIN = "wss://world.example.test";
    try {
      const config = viteConfig({ command: "build", mode: "production" });
      const define = config.define as Record<string, string>;
      // Config invocation re-reads the manifest path; identity may be empty when
      // generate-production-assets has not run, but the define keys always exist
      // and client/protocol ids still come from env independently.
      expect(define["import.meta.env.SUCCESSOR_CLIENT_RELEASE_ID"]).toBe(
        JSON.stringify("successor-alpha@a2d02071e180f9df"),
      );
      expect(typeof define["import.meta.env.SUCCESSOR_ASSET_RELEASE_ID"]).toBe("string");
      expect(typeof define["import.meta.env.SUCCESSOR_ASSET_CONTENT_HASH"]).toBe("string");
    } finally {
      if (previous.packageMode === undefined) delete process.env.SUCCESSOR_PACKAGE_MODE;
      else process.env.SUCCESSOR_PACKAGE_MODE = previous.packageMode;
      if (previous.clientReleaseId === undefined) delete process.env.SUCCESSOR_CLIENT_RELEASE_ID;
      else process.env.SUCCESSOR_CLIENT_RELEASE_ID = previous.clientReleaseId;
      if (previous.storefrontOrigin === undefined) delete process.env.SUCCESSOR_STOREFRONT_ORIGIN;
      else process.env.SUCCESSOR_STOREFRONT_ORIGIN = previous.storefrontOrigin;
      if (previous.gameOrigin === undefined) delete process.env.SUCCESSOR_GAME_ORIGIN;
      else process.env.SUCCESSOR_GAME_ORIGIN = previous.gameOrigin;
      if (previous.chatOrigin === undefined) delete process.env.SUCCESSOR_CHAT_ORIGIN;
      else process.env.SUCCESSOR_CHAT_ORIGIN = previous.chatOrigin;
    }
  });
});

describe("production chunk graph stays single-runtime", () => {
  it("does not introduce a second rollup input or drop manualChunks / onlyExplicitManualChunks", () => {
    const previous = {
      packageMode: process.env.SUCCESSOR_PACKAGE_MODE,
      clientReleaseId: process.env.SUCCESSOR_CLIENT_RELEASE_ID,
      storefrontOrigin: process.env.SUCCESSOR_STOREFRONT_ORIGIN,
      gameOrigin: process.env.SUCCESSOR_GAME_ORIGIN,
      chatOrigin: process.env.SUCCESSOR_CHAT_ORIGIN,
    };
    process.env.SUCCESSOR_PACKAGE_MODE = "hosted-release";
    process.env.SUCCESSOR_CLIENT_RELEASE_ID = "successor-alpha@a2d02071e180f9df";
    process.env.SUCCESSOR_STOREFRONT_ORIGIN = "https://storefront.example.test";
    process.env.SUCCESSOR_GAME_ORIGIN = "wss://world.example.test";
    process.env.SUCCESSOR_CHAT_ORIGIN = "wss://world.example.test";
    try {
      const config = viteConfig({ command: "build", mode: "production" });
      const input = config.build?.rollupOptions?.input;
      expect(input && typeof input === "object" ? Object.keys(input as object) : input).toEqual(["main"]);
      const output = config.build?.rollupOptions?.output;
      const record = Array.isArray(output) ? output[0] : output;
      expect(typeof record?.manualChunks).toBe("function");
      expect(record?.onlyExplicitManualChunks).toBe(true);
      const preload = config.build?.modulePreload;
      expect(preload && typeof preload === "object").toBe(true);
    } finally {
      if (previous.packageMode === undefined) delete process.env.SUCCESSOR_PACKAGE_MODE;
      else process.env.SUCCESSOR_PACKAGE_MODE = previous.packageMode;
      if (previous.clientReleaseId === undefined) delete process.env.SUCCESSOR_CLIENT_RELEASE_ID;
      else process.env.SUCCESSOR_CLIENT_RELEASE_ID = previous.clientReleaseId;
      if (previous.storefrontOrigin === undefined) delete process.env.SUCCESSOR_STOREFRONT_ORIGIN;
      else process.env.SUCCESSOR_STOREFRONT_ORIGIN = previous.storefrontOrigin;
      if (previous.gameOrigin === undefined) delete process.env.SUCCESSOR_GAME_ORIGIN;
      else process.env.SUCCESSOR_GAME_ORIGIN = previous.gameOrigin;
      if (previous.chatOrigin === undefined) delete process.env.SUCCESSOR_CHAT_ORIGIN;
      else process.env.SUCCESSOR_CHAT_ORIGIN = previous.chatOrigin;
    }
  });
});
