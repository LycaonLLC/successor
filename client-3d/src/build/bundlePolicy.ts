/**
 * client-3d bundle policy — source-defined split boundaries for the Vite
 * entry graph. Critical path stays eager (boot, transport, world render,
 * combat/HUD/interaction). Management windows and rare heavy features load
 * on first open; a bounded idle preload may warm them after world ready.
 *
 * Chunk names are stable product contracts for release measurement. Keep
 * Three.js in one named vendor chunk so hosted and desktop never ship two
 * runtime copies. Do not introduce dynamic-string imports.
 */
export const MAIN_ENTRY_ID = "main" as const;

/** Stable Rollup/Vite chunk names (manualChunks + dynamic import boundaries). */
export const BUNDLE_CHUNK_NAMES = {
  three: "three",
  deferredCraft: "feature-craft",
  deferredSplice: "feature-splice",
  deferredTrade: "feature-trade",
  deferredMacrosWindow: "feature-macros-window",
  deferredSurvey: "feature-survey",
  deferredTravel: "feature-travel",
  deferredBank: "feature-bank",
  deferredCloneTerminal: "feature-clone-terminal",
  deferredPa: "feature-pa",
  deferredConverse: "feature-converse",
  deferredFxLab: "feature-fx-lab",
  deferredDatapad: "feature-datapad",
  deferredExamine: "feature-examine",
} as const;

export type BundleChunkName = (typeof BUNDLE_CHUNK_NAMES)[keyof typeof BUNDLE_CHUNK_NAMES];

/** Filename prefix for every deferred feature JS/CSS asset. */
export const DEFERRED_FEATURE_ASSET_PREFIX = "feature-" as const;

/** Vendor chunks allowed on the cold HTML modulepreload path. */
export const EAGER_MODULEPRELOAD_CHUNK_NAMES = [BUNDLE_CHUNK_NAMES.three] as const;

/** True when a built asset path/name belongs to a deferred feature chunk. */
export function isDeferredFeatureAsset(assetPath: string): boolean {
  const base = assetPath.replace(/\\/g, "/").split("/").pop() ?? assetPath;
  return base.startsWith(DEFERRED_FEATURE_ASSET_PREFIX);
}

/**
 * Built index.html cold-path contract: no feature-* JS/CSS references, and
 * modulepreload may only name allowed eager vendor chunks (plus the main entry
 * script tag which is not a modulepreload).
 */
export function assertProductionHtmlColdPath(html: string): void {
  const featureRefs = [...html.matchAll(/[\w./-]*feature-[\w.-]+\.(?:js|css)/g)].map((m) => m[0]);
  if (featureRefs.length > 0) {
    throw new Error(`production HTML must not reference deferred feature assets: ${featureRefs.join(", ")}`);
  }
  const preloads = [...html.matchAll(/rel=["']modulepreload["'][^>]*href=["']([^"']+)["']/g)]
    .map((m) => m[1] ?? "")
    .filter(Boolean);
  const allowed = new Set<string>(EAGER_MODULEPRELOAD_CHUNK_NAMES);
  for (const href of preloads) {
    const base = href.replace(/\\/g, "/").split("/").pop() ?? href;
    // Vite emits name-HASH.js; accept prefix match against allowed chunk names.
    const ok = [...allowed].some((name) => base.startsWith(`${name}-`) || base === `${name}.js`);
    if (!ok) {
      throw new Error(`production HTML modulepreload not on eager allow-list: ${href}`);
    }
  }
}


/**
 * Modules that MUST remain on the critical eager path (static imports from
 * main → boot → renderer / HUD). Source assertions lock this list.
 */
export const CRITICAL_EAGER_MODULES = [
  "src/main.ts",
  "src/boot/successor3dApp.ts",
  "src/boot/authorityRendererBoot.ts",
  "src/launchProtocol.ts",
  "src/render/SuccessorThreeRenderer.ts",
  "src/ui/hud/toolbar.ts",
  "src/ui/hud/radar.ts",
  "src/ui/hud/chatPane.ts",
  "src/ui/hud/combatQueue.ts",
  "src/ui/hud/deathOverlay.ts",
  "src/ui/hud/interactPrompt.ts",
  "src/ui/hud/targetPlate.ts",
  "src/ui/inventory/shell.ts",
  "src/ui/windows/windowManager.ts",
  "src/ui/windows/dock.ts",
  "src/combat/softLock.ts",
] as const;

/**
 * Feature modules intentionally deferred from the main entry graph. Each
 * maps to a stable named chunk via static `import()` in deferredWindows.
 */
export const DEFERRED_FEATURE_MODULES = [
  {
    id: "craft",
    chunk: BUNDLE_CHUNK_NAMES.deferredCraft,
    modulePath: "src/ui/crafting/craftWindow.ts",
    preload: true,
  },
  {
    id: "splice",
    chunk: BUNDLE_CHUNK_NAMES.deferredSplice,
    modulePath: "src/ui/splice/spliceWindow.ts",
    preload: true,
  },
  {
    id: "trade",
    chunk: BUNDLE_CHUNK_NAMES.deferredTrade,
    modulePath: "src/ui/trade/tradeWindow.ts",
    preload: true,
  },
  {
    id: "macros-window",
    chunk: BUNDLE_CHUNK_NAMES.deferredMacrosWindow,
    modulePath: "src/ui/macros/macrosWindow.ts",
    preload: true,
  },
  {
    id: "survey",
    chunk: BUNDLE_CHUNK_NAMES.deferredSurvey,
    modulePath: "src/ui/windows/defs/surveyToolWindow.ts",
    preload: true,
  },
  {
    id: "travel",
    chunk: BUNDLE_CHUNK_NAMES.deferredTravel,
    modulePath: "src/ui/windows/defs/travelWindow.ts",
    preload: true,
  },
  {
    id: "bank",
    chunk: BUNDLE_CHUNK_NAMES.deferredBank,
    modulePath: "src/ui/windows/defs/bankWindow.ts",
    preload: true,
  },
  {
    id: "clone-terminal",
    chunk: BUNDLE_CHUNK_NAMES.deferredCloneTerminal,
    modulePath: "src/ui/windows/defs/cloneTerminalWindow.ts",
    preload: false,
  },
  {
    id: "pa",
    chunk: BUNDLE_CHUNK_NAMES.deferredPa,
    modulePath: "src/ui/windows/defs/paWindow.ts",
    preload: true,
  },
  {
    id: "converse",
    chunk: BUNDLE_CHUNK_NAMES.deferredConverse,
    modulePath: "src/ui/dialogue/converseWindow.ts",
    preload: false,
  },
  {
    id: "fx-lab",
    chunk: BUNDLE_CHUNK_NAMES.deferredFxLab,
    modulePath: "src/ui/windows/defs/fxLabWindow.ts",
    preload: false,
  },
  {
    id: "datapad",
    chunk: BUNDLE_CHUNK_NAMES.deferredDatapad,
    modulePath: "src/ui/windows/defs/datapadWindow.ts",
    preload: true,
  },
  {
    id: "examine",
    chunk: BUNDLE_CHUNK_NAMES.deferredExamine,
    modulePath: "src/ui/inventory/examineWindow.ts",
    preload: false,
  },
  {
    id: "target-examine",
    chunk: BUNDLE_CHUNK_NAMES.deferredExamine,
    modulePath: "src/ui/inventory/targetExamineWindow.ts",
    preload: false,
  },
  {
    id: "prop-examine",
    chunk: BUNDLE_CHUNK_NAMES.deferredExamine,
    modulePath: "src/ui/windows/defs/propExamineWindow.ts",
    preload: false,
  },
] as const;

export type DeferredFeatureId = (typeof DEFERRED_FEATURE_MODULES)[number]["id"];

/** Max concurrent idle preloads after world ready (bounded; never blocks boot). */
export const FEATURE_PRELOAD_CONCURRENCY = 2;

/** Delay before idle preload begins — world/HUD/combat stay first-ready. */
export const FEATURE_PRELOAD_DELAY_MS = 1_200;

const THREE_PACKAGE_MARKERS = [
  "/node_modules/three/",
  "\\node_modules\\three\\",
  "node_modules/three/",
  "node_modules\\three\\",
] as const;

/**
 * Exact deferred entry module path suffixes (under src/). Matched only as
 * full entry files (`…/craftWindow.ts` or built `…/craftWindow.js`), never as
 * substring prefixes — eager `*Ids.ts` seams and tests must stay out of
 * feature chunks or the initial graph pulls the lazy module.
 */
function deferredEntrySuffixes(): ReadonlyArray<readonly [string, string]> {
  return DEFERRED_FEATURE_MODULES.map((entry) => {
    const rel = entry.modulePath.replace(/^src\//, "");
    return [rel, entry.chunk] as const;
  });
}

function isEagerOrTestSeam(normalized: string): boolean {
  const base = normalized.split("/").pop() ?? normalized;
  if (base.includes(".test.")) return true;
  if (/Ids\.(ts|js|mjs|cjs)(\?|$)/.test(base)) return true;
  if (base.startsWith("deferredMount.") || base.startsWith("deferredWindows.")) return true;
  return false;
}

function matchDeferredEntryChunk(normalized: string): string | undefined {
  if (isEagerOrTestSeam(normalized)) return undefined;
  // Strip Vite query/hash suffixes (e.g. ?v=…)
  const pathOnly = normalized.split("?")[0]?.split("#")[0] ?? normalized;
  for (const [relTs, chunk] of deferredEntrySuffixes()) {
    const relJs = relTs.replace(/\.tsx?$/, ".js");
    const relMjs = relTs.replace(/\.tsx?$/, ".mjs");
    if (
      pathOnly.endsWith("/" + relTs)
      || pathOnly.endsWith("/" + relJs)
      || pathOnly.endsWith("/" + relMjs)
      || pathOnly.endsWith(relTs)
      || pathOnly.endsWith(relJs)
    ) {
      return chunk;
    }
  }
  return undefined;
}

/**
 * Rollup manualChunks: pin Three.js to one stable vendor chunk and pin each
 * deferred feature ENTRY module to its stable feature-* name. Eager id/binding
 * seams (`*Ids.ts`), tests, and shared helpers are never forced into feature
 * chunks — that would collapse lazy import() boundaries into the main graph.
 */
export function client3dManualChunks(id: string): string | undefined {
  const normalized = id.replace(/\\/g, "/");
  if (THREE_PACKAGE_MARKERS.some((marker) => id.includes(marker) || normalized.includes(marker.replace(/\\/g, "/")))) {
    return BUNDLE_CHUNK_NAMES.three;
  }
  // three/examples/jsm rides the same named chunk (single runtime copy).
  if (normalized.includes("/three/examples/jsm/") || normalized.endsWith("/three/build/three.module.js")) {
    return BUNDLE_CHUNK_NAMES.three;
  }
  return matchDeferredEntryChunk(normalized);
}

export function deferredFeatureById(id: DeferredFeatureId) {
  return DEFERRED_FEATURE_MODULES.find((entry) => entry.id === id) ?? null;
}

export function preloadDeferredFeatureIds(): readonly DeferredFeatureId[] {
  return DEFERRED_FEATURE_MODULES.filter((entry) => entry.preload).map((entry) => entry.id);
}

export function namedBundleChunks(): readonly string[] {
  return Object.values(BUNDLE_CHUNK_NAMES);
}
