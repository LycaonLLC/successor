import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_CHUNK_NAMES,
  client3dManualChunks,
  CRITICAL_EAGER_MODULES,
  DEFERRED_FEATURE_MODULES,
  FEATURE_PRELOAD_CONCURRENCY,
  FEATURE_PRELOAD_DELAY_MS,
  namedBundleChunks,
  preloadDeferredFeatureIds,
} from "./bundlePolicy";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const srcDir = path.join(packageDir, "src");

describe("client-3d bundle policy", () => {
  it("pins Three.js paths to one stable named vendor chunk", () => {
    expect(client3dManualChunks("/repo/node_modules/three/build/three.module.js")).toBe(BUNDLE_CHUNK_NAMES.three);
    expect(client3dManualChunks("/repo/node_modules/three/examples/jsm/loaders/GLTFLoader.js")).toBe(
      BUNDLE_CHUNK_NAMES.three,
    );
    expect(client3dManualChunks("/repo/client-3d/src/render/pawns.ts")).toBeUndefined();
  });
  it("pins deferred feature entry modules to stable feature-* chunk names", () => {
    expect(client3dManualChunks("/repo/client-3d/src/ui/crafting/craftWindow.ts")).toBe(BUNDLE_CHUNK_NAMES.deferredCraft);
    expect(client3dManualChunks("/repo/client-3d/src/ui/windows/defs/datapadWindow.ts")).toBe(BUNDLE_CHUNK_NAMES.deferredDatapad);
    expect(client3dManualChunks("/repo/client-3d/src/ui/inventory/examineWindow.ts")).toBe(BUNDLE_CHUNK_NAMES.deferredExamine);
  });


  it("keeps critical eager modules present on disk", () => {
    for (const rel of CRITICAL_EAGER_MODULES) {
      const abs = path.join(packageDir, rel);
      expect(fs.existsSync(abs), rel).toBe(true);
    }
  });

  it("lists deferred feature modules with stable chunk names and real paths", () => {
    const chunkNames = new Set(namedBundleChunks());
    expect(DEFERRED_FEATURE_MODULES.length).toBeGreaterThan(8);
    for (const entry of DEFERRED_FEATURE_MODULES) {
      expect(chunkNames.has(entry.chunk), entry.id).toBe(true);
      expect(entry.chunk.startsWith("feature-")).toBe(true);
      expect(fs.existsSync(path.join(packageDir, entry.modulePath)), entry.modulePath).toBe(true);
    }
  });

  it("bounds idle preload after world ready", () => {
    expect(FEATURE_PRELOAD_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(FEATURE_PRELOAD_CONCURRENCY).toBeLessThanOrEqual(3);
    expect(FEATURE_PRELOAD_DELAY_MS).toBeGreaterThanOrEqual(500);
    expect(preloadDeferredFeatureIds().length).toBeGreaterThan(0);
    expect(preloadDeferredFeatureIds().every((id) => DEFERRED_FEATURE_MODULES.some((e) => e.id === id))).toBe(true);
  });

  it("keeps combat/HUD/interaction on the eager path in the composition root", () => {
    const boot = fs.readFileSync(path.join(srcDir, "boot/successor3dApp.ts"), "utf8");
    for (const needle of [
      'from "../ui/hud/toolbar"',
      'from "../ui/hud/radar"',
      'from "../ui/hud/chatPane"',
      'from "../ui/hud/combatQueue"',
      'from "../ui/hud/deathOverlay"',
      'from "../ui/hud/interactPrompt"',
      'from "../combat/softLock"',
      'from "../render/SuccessorThreeRenderer"',
      'from "./authorityRendererBoot"',
    ]) {
      expect(boot.includes(needle), needle).toBe(true);
    }
  });

  it("defers management windows through deferredWindows static import boundaries", () => {
    const boot = fs.readFileSync(path.join(srcDir, "boot/successor3dApp.ts"), "utf8");
    expect(boot.includes('from "../ui/windows/deferredWindows"')).toBe(true);
    expect(boot.includes("createDeferredCraftWindowDefinition")).toBe(true);
    expect(boot.includes("createDeferredTradeWindowDefinition")).toBe(true);
    expect(boot.includes("createDeferredDatapadWindowDefinition")).toBe(true);
    expect(boot.includes("scheduleDeferredFeaturePreload")).toBe(true);
    // No static pull of heavy feature mount modules into boot.
    expect(boot.includes('from "../ui/crafting/craftWindow"')).toBe(false);
    expect(boot.includes('from "../ui/trade/tradeWindow"')).toBe(false);
    expect(boot.includes('from "../ui/macros/macrosWindow"')).toBe(false);
    expect(boot.includes('from "../ui/windows/defs/datapadWindow"')).toBe(false);
  });

  it("uses only static import() factories in deferredWindows (no dynamic string imports)", () => {
    const deferred = fs.readFileSync(path.join(srcDir, "ui/windows/deferredWindows.ts"), "utf8");
    // Strip comments so prose cannot trip the non-literal import() scan.
    const code = deferred
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[\s;])\/\/.*$/gm, "$1");
    const importCalls = [...code.matchAll(/\bimport\s*\(([^)]*)\)/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
    expect(importCalls.length).toBeGreaterThan(0);
    for (const arg of importCalls) {
      // Literal module specifier only - no variables, templates, or concatenation.
      expect(arg).toMatch(/^["'][^"']+["']$/);
      expect(arg.includes("${")).toBe(false);
      expect(arg.includes("+")).toBe(false);
    }
  });

  it("never assigns eager *Ids seams or tests to deferred feature chunks", () => {
    const eagerIds = [
      "/repo/client-3d/src/ui/crafting/craftWindowIds.ts",
      "/repo/client-3d/src/ui/splice/spliceWindowIds.ts",
      "/repo/client-3d/src/ui/macros/macrosWindowIds.ts",
      "/repo/client-3d/src/ui/dialogue/converseWindowIds.ts",
      "/repo/client-3d/src/ui/windows/defs/fxLabWindowIds.ts",
      "/repo/client-3d/src/ui/windows/defs/bankWindowIds.ts",
      "/repo/client-3d/src/ui/windows/defs/cloneTerminalWindowIds.ts",
      "/repo/client-3d/src/ui/windows/defs/paWindowIds.ts",
      "/repo/client-3d/src/ui/windows/defs/lootWindowIds.ts",
      "/repo/client-3d/src/ui/inventory/examineWindowIds.ts",
      "/repo/client-3d/src/ui/inventory/targetExamineWindowIds.ts",
      "/repo/client-3d/src/ui/windows/defs/propExamineWindowIds.ts",
    ];
    for (const id of eagerIds) {
      expect(client3dManualChunks(id), id).toBeUndefined();
    }
    expect(client3dManualChunks("/repo/client-3d/src/ui/crafting/craftWindow.test.ts")).toBeUndefined();
    expect(client3dManualChunks("/repo/client-3d/src/ui/windows/deferredWindows.ts")).toBeUndefined();
    expect(client3dManualChunks("/repo/client-3d/src/ui/windows/deferredMount.ts")).toBeUndefined();
  });

  it("matches only exact deferred entry suffixes including built .js forms", () => {
    expect(client3dManualChunks("/repo/client-3d/src/ui/crafting/craftWindow.ts")).toBe(BUNDLE_CHUNK_NAMES.deferredCraft);
    expect(client3dManualChunks("/repo/client-3d/src/ui/crafting/craftWindow.js")).toBe(BUNDLE_CHUNK_NAMES.deferredCraft);
    expect(client3dManualChunks("/repo/client-3d/src/ui/crafting/craftWindow.ts?v=1")).toBe(BUNDLE_CHUNK_NAMES.deferredCraft);
    // Prefix-only / sibling path must not match.
    expect(client3dManualChunks("/repo/client-3d/src/ui/crafting/craftWindowExtra.ts")).toBeUndefined();
    expect(client3dManualChunks("/repo/client-3d/src/ui/crafting/craftWindow/store.ts")).toBeUndefined();
  });

  it("proves deferred feature entries stay outside the eager boot import graph", () => {
    const boot = fs.readFileSync(path.join(srcDir, "boot/successor3dApp.ts"), "utf8");
    const deferredWindows = fs.readFileSync(path.join(srcDir, "ui/windows/deferredWindows.ts"), "utf8");
    for (const entry of DEFERRED_FEATURE_MODULES) {
      const bare = entry.modulePath.replace(/^src\//, "").replace(/\.ts$/, "");
      // Boot may import *Ids seams, never the heavy entry module path.
      expect(boot.includes(`from "../${bare}"`) || boot.includes(`from '../${bare}'`), bare).toBe(false);
      // deferredWindows must static-import the exact entry.
      expect(deferredWindows.includes(`import("./`) || deferredWindows.includes(`import("../`)).toBe(true);
      const leaf = bare.split("/").pop()!;
      expect(deferredWindows.includes(leaf), leaf).toBe(true);
    }
  });

});
