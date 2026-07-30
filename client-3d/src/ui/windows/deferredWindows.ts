import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import type { MacroRuntime } from "../macros/runtime";
import type { CraftCommandPort } from "../crafting/commands";
import type { SpliceCommandPort } from "../splice/commands";
import type { TradeCommandPort } from "../trade/commands";
import type { ContextRadial } from "./contextRadial";
import type { WindowDefinition } from "./windowManager";
import { createDeferredWindowMount, loadDeferredModuleOnce } from "./deferredMount";
import {
  BUNDLE_CHUNK_NAMES,
  type DeferredFeatureId,
  FEATURE_PRELOAD_CONCURRENCY,
  FEATURE_PRELOAD_DELAY_MS,
  preloadDeferredFeatureIds,
} from "../../build/bundlePolicy";
import { CRAFT_WINDOW_ID } from "../crafting/craftWindowIds";
import { SPLICE_WINDOW_ID } from "../splice/spliceWindowIds";
import { TRADE_WINDOW_ID } from "../trade/lifecycle";
import { MACROS_WINDOW_ID, type MacroNoticeSink } from "../macros/macrosWindowIds";
import { CONVERSE_WINDOW_ID } from "../dialogue/converseWindowIds";
import { FX_LAB_WINDOW_ID, fxLabRequested } from "./defs/fxLabWindowIds";
import { BANK_WINDOW_ID } from "./defs/bankWindowIds";
import { CLONE_TERMINAL_WINDOW_ID } from "./defs/cloneTerminalWindowIds";
import { PA_WINDOW_ID, type PaWindowDeps } from "./defs/paWindowIds";
import { LOOT_WINDOW_ID } from "./defs/lootWindowIds";
import { TARGET_EXAMINE_WINDOW_ID } from "../inventory/targetExamineWindowIds";
import { PROP_EXAMINE_WINDOW_ID } from "./defs/propExamineWindowIds";

/**
 * Deferred management / rare-feature window definitions.
 *
 * IDs and chrome metadata stay eager (dock, hotkeys, openers, slash list).
 * Heavy mount implementations load through static import factories so
 * Rollup emits the stable named chunks in bundlePolicy.
 */

export {
  CRAFT_WINDOW_ID,
  SPLICE_WINDOW_ID,
  TRADE_WINDOW_ID,
  MACROS_WINDOW_ID,
  CONVERSE_WINDOW_ID,
  FX_LAB_WINDOW_ID,
  fxLabRequested,
  BANK_WINDOW_ID,
  CLONE_TERMINAL_WINDOW_ID,
  PA_WINDOW_ID,
  LOOT_WINDOW_ID,
  TARGET_EXAMINE_WINDOW_ID,
  PROP_EXAMINE_WINDOW_ID,
};

export type { MacroNoticeSink };

// ── Static import factories (named chunks; no string-built specifiers) ─────

function loadCraftWindow() {
  return import("../crafting/craftWindow");
}

function loadSpliceWindow() {
  return import("../splice/spliceWindow");
}

function loadTradeWindow() {
  return import("../trade/tradeWindow");
}

function loadMacrosWindow() {
  return import("../macros/macrosWindow");
}

function loadSurveyToolWindow() {
  return import("./defs/surveyToolWindow");
}

function loadTravelWindow() {
  return import("./defs/travelWindow");
}

function loadBankWindow() {
  return import("./defs/bankWindow");
}

function loadCloneTerminalWindow() {
  return import("./defs/cloneTerminalWindow");
}

function loadPaWindow() {
  return import("./defs/paWindow");
}

function loadConverseWindow() {
  return import("../dialogue/converseWindow");
}

function loadFxLabWindow() {
  return import("./defs/fxLabWindow");
}

function loadDatapadWindow() {
  return import("./defs/datapadWindow");
}

function loadExamineWindow() {
  return import("../inventory/examineWindow");
}

function loadTargetExamineWindow() {
  return import("../inventory/targetExamineWindow");
}

function loadPropExamineWindow() {
  return import("./defs/propExamineWindow");
}

const FEATURE_LOADERS: Record<DeferredFeatureId, () => Promise<unknown>> = {
  craft: loadCraftWindow,
  splice: loadSpliceWindow,
  trade: loadTradeWindow,
  "macros-window": loadMacrosWindow,
  survey: loadSurveyToolWindow,
  travel: loadTravelWindow,
  bank: loadBankWindow,
  "clone-terminal": loadCloneTerminalWindow,
  pa: loadPaWindow,
  converse: loadConverseWindow,
  "fx-lab": loadFxLabWindow,
  datapad: loadDatapadWindow,
  examine: loadExamineWindow,
  "target-examine": loadTargetExamineWindow,
  "prop-examine": loadPropExamineWindow,
};

/** One-load cached fetch for a deferred feature (open path + idle preload). */
export function ensureDeferredFeatureLoaded(featureId: DeferredFeatureId): Promise<unknown> {
  return loadDeferredModuleOnce(featureId, FEATURE_LOADERS[featureId]);
}

/**
 * Bounded idle preload after world ready. Never blocks boot; failures are
 * swallowed so a missing chunk cannot stall gameplay.
 */
export function scheduleDeferredFeaturePreload(options?: {
  delayMs?: number;
  concurrency?: number;
  only?: readonly DeferredFeatureId[];
}): () => void {
  const delayMs = options?.delayMs ?? FEATURE_PRELOAD_DELAY_MS;
  const concurrency = Math.max(1, options?.concurrency ?? FEATURE_PRELOAD_CONCURRENCY);
  const ids = [...(options?.only ?? preloadDeferredFeatureIds())];
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;

  const pump = (): void => {
    if (cancelled) return;
    while (inFlight < concurrency && ids.length > 0) {
      const id = ids.shift()!;
      inFlight += 1;
      void ensureDeferredFeatureLoaded(id)
        .catch(() => {
          // Idle preload is best-effort; first open still retries.
        })
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
  };

  timer = setTimeout(() => {
    timer = null;
    if (!cancelled) pump();
  }, delayMs);

  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    ids.length = 0;
  };
}

// ── Definition factories (eager chrome, deferred mount) ────────────────────

export function createDeferredCraftWindowDefinition(deps: {
  commands: CraftCommandPort;
  sfx?: SfxPlayer;
}): WindowDefinition {
  return {
    id: CRAFT_WINDOW_ID,
    title: "CRAFT",
    icon: "craft",
    hotkey: null,
    dockVisible: false,
    minWidth: 580,
    minHeight: 440,
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = Math.max(580, Math.round(viewport.w * 0.46));
      const h = Math.max(440, Math.round(viewport.h * 0.64));
      const x = Math.max(12, Math.round((viewport.w - w) / 2) - 100);
      return { x, y: Math.min(150, Math.round(viewport.h * 0.17)), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "craft",
      load: loadCraftWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createCraftWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredSpliceWindowDefinition(deps: {
  commands: SpliceCommandPort;
  sfx?: SfxPlayer;
}): WindowDefinition {
  return {
    id: SPLICE_WINDOW_ID,
    title: "GENE BENCH",
    icon: "splice",
    hotkey: null,
    dockVisible: false,
    minWidth: 600,
    minHeight: 460,
    defaultBounds: (viewport) => {
      const w = Math.max(600, Math.round(viewport.w * 0.5));
      const h = Math.max(460, Math.round(viewport.h * 0.68));
      return { x: Math.round((viewport.w - w) / 2), y: Math.round((viewport.h - h) * 0.4), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "splice",
      load: loadSpliceWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createSpliceWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredTradeWindowDefinition(deps: {
  commands: TradeCommandPort;
  closeWindow: (id: string) => void;
  sfx?: SfxPlayer;
}): WindowDefinition {
  return {
    id: TRADE_WINDOW_ID,
    title: "TRADE",
    icon: "trade",
    hotkey: null,
    minWidth: 560,
    minHeight: 470,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.max(560, Math.round(viewport.w * 0.42));
      const h = Math.max(470, Math.round(viewport.h * 0.62));
      const x = Math.max(0, Math.min(Math.round(viewport.w * 0.07), viewport.w - w));
      const y = Math.round(Math.max(0, (viewport.h - h) / 2 - 24));
      return { x, y, w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "trade",
      load: loadTradeWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createTradeWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredMacrosWindowDefinition(deps: {
  runtime: MacroRuntime;
  notices: MacroNoticeSink;
  sfx?: SfxPlayer;
}): WindowDefinition {
  return {
    id: MACROS_WINDOW_ID,
    title: "MACROS",
    icon: "macro",
    hotkey: "KeyM",
    minWidth: 540,
    minHeight: 420,
    defaultBounds: (viewport) => {
      const w = Math.max(540, Math.round(viewport.w * 0.44));
      const h = Math.max(420, Math.round(viewport.h * 0.6));
      return { x: Math.round(viewport.w * 0.08), y: Math.round(viewport.h * 0.16), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "macros-window",
      load: loadMacrosWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createMacrosWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredSurveyToolWindowDefinition(deps: { sfx?: SfxPlayer } = {}): WindowDefinition {
  return {
    id: "surveyTool",
    title: "SURVEY",
    icon: "survey",
    hotkey: null,
    dockVisible: false,
    minWidth: 340,
    minHeight: 430,
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = Math.max(340, Math.round(viewport.w * 0.26));
      const h = Math.max(430, Math.round(viewport.h * 0.6));
      return { x: 12, y: Math.round(viewport.h * 0.16), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "survey",
      load: loadSurveyToolWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createSurveyToolWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredTravelWindowDefinition(): WindowDefinition {
  return {
    id: "travel",
    title: "TRAVEL",
    icon: "travel",
    hotkey: null,
    minWidth: 560,
    minHeight: 360,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.max(560, Math.round(viewport.w * 0.44));
      const h = Math.max(360, Math.round(viewport.h * 0.5));
      return { x: Math.round((viewport.w - w) / 2), y: Math.round((viewport.h - h) * 0.42), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "travel",
      load: loadTravelWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createTravelWindowDefinition().mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredBankWindowDefinition(deps: { sfx?: SfxPlayer } = {}): WindowDefinition {
  return {
    id: BANK_WINDOW_ID,
    title: "BANK",
    icon: "bank",
    hotkey: null,
    minWidth: 420,
    minHeight: 360,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.max(420, Math.min(560, Math.round(viewport.w * 0.34)));
      const h = Math.max(360, Math.round(viewport.h * 0.56));
      return { x: Math.round((viewport.w - w) / 2), y: Math.round((viewport.h - h) * 0.42), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "bank",
      load: loadBankWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createBankWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredCloneTerminalWindowDefinition(deps: { sfx?: SfxPlayer } = {}): WindowDefinition {
  return {
    id: CLONE_TERMINAL_WINDOW_ID,
    title: "CLONING",
    icon: "clone-facility",
    hotkey: null,
    minWidth: 400,
    minHeight: 320,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.max(400, Math.round(viewport.w * 0.3));
      const h = Math.max(320, Math.round(viewport.h * 0.44));
      return { x: Math.round((viewport.w - w) / 2), y: Math.round((viewport.h - h) * 0.42), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "clone-terminal",
      load: loadCloneTerminalWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createCloneTerminalWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredPaWindowDefinition(deps: PaWindowDeps = {}): WindowDefinition {
  return {
    id: PA_WINDOW_ID,
    title: "ASSOCIATION",
    icon: "association",
    hotkey: "KeyG",
    minWidth: 460,
    minHeight: 420,
    defaultBounds: (viewport) => {
      const w = Math.max(460, Math.round(viewport.w * 0.32));
      const h = Math.max(420, Math.round(viewport.h * 0.58));
      return { x: Math.round((viewport.w - w) / 2), y: Math.round((viewport.h - h) * 0.4), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "pa",
      load: loadPaWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createPaWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredConverseWindowDefinition(deps: {
  sfx: SfxPlayer;
  openWindow: (id: string) => void;
  closeWindow: (id: string) => void;
}): WindowDefinition {
  return {
    id: CONVERSE_WINDOW_ID,
    title: "CONVERSE",
    icon: "converse",
    hotkey: null,
    minWidth: 460,
    minHeight: 340,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.min(600, Math.max(460, Math.round(viewport.w * 0.34)));
      const h = Math.min(520, Math.max(340, Math.round(viewport.h * 0.5)));
      return { x: Math.round(viewport.w * 0.14), y: Math.round(viewport.h * 0.18), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "converse",
      load: loadConverseWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createConverseWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredFxLabWindowDefinition(): WindowDefinition {
  return {
    id: FX_LAB_WINDOW_ID,
    title: "FX LAB",
    icon: "fx",
    hotkey: null,
    dockVisible: false,
    minWidth: 300,
    minHeight: 340,
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = 340;
      const h = Math.min(640, Math.round(viewport.h * 0.78));
      return { x: Math.max(12, viewport.w - w - 200), y: 88, w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "fx-lab",
      load: loadFxLabWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createFxLabWindowDefinition().mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredDatapadWindowDefinition(deps: {
  radial: ContextRadial;
  sfx?: SfxPlayer;
}): WindowDefinition {
  return {
    id: "datapad",
    title: "DATAPAD",
    icon: "datapad",
    hotkey: "KeyP",
    minWidth: 420,
    minHeight: 400,
    boundsRevision: 3,
    defaultBounds: (viewport) => {
      const w = Math.max(420, Math.round(viewport.w * 0.4));
      const h = Math.max(400, Math.round(viewport.h * 0.62));
      return {
        x: Math.min(viewport.w - w - 12, Math.round(viewport.w * 0.54)),
        y: Math.round(viewport.h * 0.14),
        w,
        h,
      };
    },
    mount: createDeferredWindowMount({
      featureId: "datapad",
      load: loadDatapadWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createDatapadWindowDefinition(deps).mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredExamineWindowDefinition(): WindowDefinition {
  return {
    id: "examine",
    title: "EXAMINE",
    icon: "examine",
    hotkey: null,
    minWidth: 300,
    minHeight: 340,
    dockVisible: false,
    defaultBounds: (viewport) => {
      const w = 360;
      const h = 420;
      const x = Math.min(Math.max(0, viewport.w - w - 96), Math.round(viewport.w * 0.64));
      const y = Math.round(Math.max(0, (viewport.h - h) / 2 - 40));
      return { x, y, w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "examine",
      load: loadExamineWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createExamineWindowDefinition().mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredTargetExamineWindowDefinition(): WindowDefinition {
  return {
    id: TARGET_EXAMINE_WINDOW_ID,
    title: "TARGET EXAMINE",
    icon: "examine",
    hotkey: null,
    minWidth: 280,
    minHeight: 390,
    dockVisible: false,
    transient: true,
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = 318;
      const h = Math.min(520, Math.max(420, Math.round(viewport.h * 0.58)));
      const x = Math.max(12, viewport.w - w - 24);
      const y = Math.max(52, Math.round(viewport.h * 0.16));
      return { x, y, w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "target-examine",
      load: loadTargetExamineWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createTargetExamineWindowDefinition().mount(contentRoot, ctx),
    }),
  };
}

export function createDeferredPropExamineWindowDefinition(): WindowDefinition {
  return {
    id: PROP_EXAMINE_WINDOW_ID,
    title: "PROP EXAMINE",
    icon: "examine",
    hotkey: null,
    minWidth: 270,
    minHeight: 260,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = 300;
      const h = 292;
      return { x: Math.max(12, viewport.w - w - 32), y: Math.max(48, Math.round(viewport.h * 0.28)), w, h };
    },
    mount: createDeferredWindowMount({
      featureId: "prop-examine",
      load: loadPropExamineWindow,
      mountLoaded: (mod, contentRoot, ctx) =>
        mod.createPropExamineWindowDefinition().mount(contentRoot, ctx),
    }),
  };
}

/** Stable chunk name table for tests / measurement (mirrors bundlePolicy). */
export const DEFERRED_WINDOW_CHUNK_NAMES = BUNDLE_CHUNK_NAMES;
