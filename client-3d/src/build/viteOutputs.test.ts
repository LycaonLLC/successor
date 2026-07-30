import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import viteConfig, { rollupInputForMode } from "../../vite.config";
import {
  assertProductionHtmlColdPath,
  BUNDLE_CHUNK_NAMES,
  client3dManualChunks,
  isDeferredFeatureAsset,
} from "./bundlePolicy";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Vite release entrypoints", () => {
  it("compiles only the public game entry in production", () => {
    expect(Object.keys(rollupInputForMode("production"))).toEqual(["main"]);
  });

  it("keeps the viewer entry available outside production", () => {
    expect(Object.keys(rollupInputForMode("development"))).toEqual(["main", "viewer"]);
  });

  it("preserves desktop/hosted production entry parity (single main graph)", () => {
    // Hosted-release and offline-full package modes both build production mode.
    // They must share the same main HTML entry so package surfaces stay one runtime.
    const prod = rollupInputForMode("production");
    expect(Object.keys(prod)).toEqual(["main"]);
    expect(String(prod.main).endsWith("index.html")).toBe(true);
  });
});

describe("Vite named chunk wiring", () => {
  it("installs the stable Three.js manualChunks function on production builds", () => {
    const config = viteConfig({ command: "build", mode: "production" });
    const output = config.build?.rollupOptions?.output;
    const record = Array.isArray(output) ? output[0] : output;
    expect(record?.manualChunks).toBeTypeOf("function");
    expect(record?.onlyExplicitManualChunks).toBe(true);
    const fn = record?.manualChunks as (id: string) => string | undefined;
    expect(fn("/repo/node_modules/three/build/three.module.js")).toBe(BUNDLE_CHUNK_NAMES.three);
    expect(fn("/repo/node_modules/three/examples/jsm/loaders/GLTFLoader.js")).toBe(BUNDLE_CHUNK_NAMES.three);
    // Policy helper and vite wiring must agree (no duplicate three runtime path).
    expect(client3dManualChunks("/repo/node_modules/three/build/three.module.js")).toBe(BUNDLE_CHUNK_NAMES.three);
  });

  it("filters deferred feature assets out of modulepreload dependencies", () => {
    const config = viteConfig({ command: "build", mode: "production" });
    const preload = config.build?.modulePreload;
    expect(preload && typeof preload === "object" && "resolveDependencies" in preload).toBe(true);
    const resolve = (preload as { resolveDependencies: (f: string, deps: string[]) => string[] }).resolveDependencies;
    const filtered = resolve("main.js", [
      "assets/three-abc.js",
      "assets/feature-craft-xyz.js",
      "assets/feature-trade-xyz.js",
      "assets/main-abc.js",
    ]);
    expect(filtered).toEqual(["assets/three-abc.js", "assets/main-abc.js"]);
    expect(isDeferredFeatureAsset("assets/feature-craft-xyz.js")).toBe(true);
    expect(isDeferredFeatureAsset("assets/three-abc.js")).toBe(false);
  });
});

describe("production HTML cold path", () => {
  it("rejects feature-* JS/CSS references and non-eager modulepreloads", () => {
    expect(() => assertProductionHtmlColdPath(`
      <script type="module" src="./assets/main-abc.js"></script>
      <link rel="modulepreload" href="./assets/three-xyz.js">
      <link rel="modulepreload" href="./assets/feature-craft-xyz.js">
    `)).toThrow(/feature-craft/);
    expect(() => assertProductionHtmlColdPath(`
      <script type="module" src="./assets/main-abc.js"></script>
      <link rel="stylesheet" href="./assets/feature-trade-xyz.css">
    `)).toThrow(/feature-trade/);
    expect(() => assertProductionHtmlColdPath(`
      <script type="module" src="./assets/main-abc.js"></script>
      <link rel="modulepreload" href="./assets/three-xyz.js">
      <link rel="modulepreload" href="./assets/random-vendor-xyz.js">
    `)).toThrow(/eager allow-list/);
  });

  it("accepts main + three-only cold HTML", () => {
    expect(() => assertProductionHtmlColdPath(`
      <script type="module" crossorigin src="./assets/main-Wxygt04k.js"></script>
      <link rel="modulepreload" crossorigin href="./assets/three-DWPTW895.js">
      <link rel="stylesheet" crossorigin href="./assets/main-BbFaHaHP.css">
    `)).not.toThrow();
  });

  it("when dist/index.html exists, enforces the cold-path contract on the built file", () => {
    const htmlPath = path.join(packageDir, "dist/index.html");
    if (!fs.existsSync(htmlPath)) return; // build not present in pure unit runs
    const html = fs.readFileSync(htmlPath, "utf8");
    expect(() => assertProductionHtmlColdPath(html)).not.toThrow();
    expect(html.includes("feature-")).toBe(false);
  });
});
