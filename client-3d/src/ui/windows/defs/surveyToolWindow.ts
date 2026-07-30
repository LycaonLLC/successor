import {
  authorityIssuedAtServerTick,
  enqueueAuthoritySampleResourceCommand,
  enqueueAuthoritySurveyResourceCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import {
  angleForDirection,
  northUpScreenVectorFromWorld,
  worldVectorFromNorthUpScreen,
} from "@successor/client/src/slice-core/geometry";
import {
  collectInventoryItems,
  createCollectedItemsScratch,
  isLocalInventoryContainer,
} from "../../inventory/data";
import {
  activeSurveyCategory,
  canonicalSurveyFamily,
  lastSurveyResultFor,
  resolveSurveyFamily,
  setSelectedSurveyFamily,
  surveyConcentrationAt,
  surveyDiscsFor,
  surveyFamilyOptionsFor,
  surveyRichestKnown,
  surveyStoreVersion,
  type SurveyFamilyOption,
} from "../../survey/store";
import {
  RESOURCE_CATEGORIES,
  resourceCategoryForFamily,
  resourceCategorySpec,
  type ResourceCategory,
} from "@successor/client/src/slice-core/resourceCategories";
import { statLabel, STAT_ORDER } from "../../crafting/composers";
import { createRejectWatcher } from "./commandReceipts";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * RESOURCE FIELD — the shared family picker for universal hand sampling and
 * trained tool surveying. Opened from the toolbar resource actions or a
 * carried survey tool (no dock button or global hotkey).
 *
 * One press of SURVEY = ONE server round-trip returning a world-anchored
 * concentration grid (established sandbox-style pull, never streamed). The map paints every
 * known disc for this area+family as a RELATIVE heatmap: the cold→hot ramp
 * re-normalizes to the min/max of the samples currently in view (a
 * 93.0–95.4% field spreads across the whole blue→red scale), quantized to
 * 12 bands so gradients read as prospecting contours. Sampling goes through
 * the store's newest-scan-wins lookup, so occluded old readings feed neither
 * the paint nor the range. The gradient legend under the map carries the
 * LIVE endpoints ("RANGE IN VIEW") so the relative scale is never misread
 * as absolute; LOCAL / CURSOR / PEAK figures give exact percentages.
 * Unscanned ground is a dotted void — scanned-empty renders cold, never
 * invisible. Only the player blip is live; disc data stays where it was
 * scanned. TAKE SAMPLE is universal and extracts at the current cell — the server
 * auto-kneels the pawn first (posture lock), so the button is honest about
 * mobility: you mine planted, not on the run.
 *
 * TARGET picks the family within the tool's category — the chips are the
 * families the authority spawn snapshot actually has live (mineral: metal /
 * copper today; carbon appears the moment it streams), remembered per
 * category for the session with the category's primary family as the
 * empty-offer fallback. The CATALOG tab is the read-only join of the same
 * snapshot: every active spawn's name, family, category and its three
 * strongest rolled stats — reference, not chrome, no new dock button.
 */

const STATUS_FLASH_MS = 1400;
/** Map view radius when nothing has been scanned yet. */
const DEFAULT_VIEW_RADIUS_CELLS = 96;
/** Pending scan gives up waiting for a result after this long. */
const SCAN_PENDING_TIMEOUT_MS = 5000;

/** Disc rims (coverage witnesses) fade with scan age — the data never does:
 *  hue stays the value channel, age lives on the rim and the SCAN readout. */
const RIM_ALPHA_FRESH = 0.55;
const RIM_ALPHA_FLOOR = 0.22;
/** Full rim fade after ~90s of server ticks at 30Hz. */
const AGE_FULL_TICKS = 2700;

/** Relative ramp band count — quantization is deliberate (contour read). */
const HEAT_BANDS = 12;
/** Cold→hot control points (blue → cyan → yellow → red), tuned for the
 *  dark glass. Fixed data-encoding colours, NOT chrome: like the storm amber
 *  and the radar's passive yellow, they must not shift with the UI theme. */
const RAMP_STOPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 36, 70, 200],
  [0.33, 56, 196, 222],
  [0.66, 238, 208, 64],
  [1.0, 232, 58, 42],
];
/** Heat fill opacity (0–255): near-solid — hue IS the datum. */
const HEAT_ALPHA = 235;
/** Visible spans under 0.1% collapse to mid-ramp: painting a full rainbow
 *  across sub-display-precision noise would be a lie of exactness. */
const DEGENERATE_SPAN_MILLI = 1;
/** Heat raster cap per axis (texels) — bounds the worst-case resample. */
const MAX_HEAT_TEXELS = 160;
/** Void lattice pitch (world cells): unscanned ground reads as a dotted
 *  surface, never black-on-black mud. */
const VOID_DOT_CELLS = 16;
const VOID_DOT_MAJOR_CELLS = 64;
/** Scale-bar length candidates (world cells). */
const SCALE_BAR_STEPS = [16, 32, 64, 128, 256] as const;

interface HeatBand {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly css: string;
}

/** t∈[0,1] → piecewise-linear colour along RAMP_STOPS. */
function rampColor(t: number): readonly [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  let lo = RAMP_STOPS[0]!;
  let hi = RAMP_STOPS[RAMP_STOPS.length - 1]!;
  for (let s = 1; s < RAMP_STOPS.length; s += 1) {
    const stop = RAMP_STOPS[s]!;
    if (x <= stop[0]) {
      lo = RAMP_STOPS[s - 1]!;
      hi = stop;
      break;
    }
  }
  const span = hi[0] - lo[0];
  const f = span > 0 ? (x - lo[0]) / span : 0;
  return [
    Math.round(lo[1] + (hi[1] - lo[1]) * f),
    Math.round(lo[2] + (hi[2] - lo[2]) * f),
    Math.round(lo[3] + (hi[3] - lo[3]) * f),
  ];
}

/** The quantized band colours; band k covers t∈[k/12,(k+1)/12). */
const HEAT_BAND_TABLE: readonly HeatBand[] = Array.from({ length: HEAT_BANDS }, (_, k) => {
  const [r, g, b] = rampColor((k + 0.5) / HEAT_BANDS);
  return { r, g, b, css: `rgb(${r}, ${g}, ${b})` };
});

function heatBandFor(t: number): HeatBand {
  const k = Math.min(HEAT_BANDS - 1, Math.max(0, Math.floor(t * HEAT_BANDS)));
  return HEAT_BAND_TABLE[k]!;
}

/** Offscreen heat raster + the visible-sample range it was normalized to. */
interface HeatLayer {
  key: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  cols: number;
  rows: number;
  /** Device pixels covered by one raster texel on each axis. */
  texelScreenX: number;
  texelScreenY: number;
  /** True when at least one in-view texel had scan data. */
  hasData: boolean;
  minMilli: number;
  maxMilli: number;
  /** Span below display precision — whole field paints mid-ramp. */
  degenerate: boolean;
}

/**
 * North-up map projection. World coordinates stay raw and deltas from the
 * player preserve the authority basis: +x right/east, -y up/north.
 */
export interface SurveyMapProjection {
  readonly playerX: number;
  readonly playerY: number;
  readonly centerX: number;
  readonly centerY: number;
  /** Device px per projected world cell. */
  readonly scale: number;
}

export function surveyScreenPointFromWorld(
  projection: SurveyMapProjection,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  const screenDelta = northUpScreenVectorFromWorld(
    worldX - projection.playerX,
    worldY - projection.playerY,
  );
  return {
    x: projection.centerX + screenDelta.x * projection.scale,
    y: projection.centerY + screenDelta.y * projection.scale,
  };
}

export function surveyWorldPointFromScreen(
  projection: SurveyMapProjection,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  const worldDelta = worldVectorFromNorthUpScreen(
    (screenX - projection.centerX) / projection.scale,
    (screenY - projection.centerY) / projection.scale,
  );
  return {
    x: projection.playerX + worldDelta.x,
    y: projection.playerY + worldDelta.y,
  };
}

/** Screen↔world mapping of the last painted frame (cursor readout). */
interface MapView extends SurveyMapProjection {
  /** Device px per CSS px (canvas backing / client box). */
  devPerCssX: number;
  devPerCssY: number;
}

export function createSurveyToolWindowDefinition(deps: { sfx?: SfxPlayer } = {}): WindowDefinition {
  return {
    id: "surveyTool",
    title: "SURVEY",
    icon: "survey",
    hotkey: null,
    dockVisible: false,
    minWidth: 340,
    minHeight: 430,
    // r2 cascade (fe-polish §1.30): hard-left — the strip's left reach stays
    // grabbable beside the macros/left-stack bodies in the all-open pile.
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = Math.max(340, Math.round(viewport.w * 0.26));
      const h = Math.max(430, Math.round(viewport.h * 0.6));
      return { x: 12, y: Math.round(viewport.h * 0.16), w, h };
    },
    mount: (contentRoot, ctx) => mountSurveyContent(contentRoot, ctx, deps),
  };
}

function mountSurveyContent(contentRoot: HTMLElement, ctx: WindowContext, deps: { sfx?: SfxPlayer } = {}): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root dws-root";
  root.innerHTML = `
    <nav class="scp-tabs" data-ref="tabs" role="tablist" aria-label="Survey tool views">
      <button type="button" class="scp-tab" data-tab="map" role="tab" aria-selected="true">MAP</button>
      <button type="button" class="scp-tab" data-tab="catalog" role="tab" aria-selected="false">CATALOG</button>
    </nav>
    <div class="dws-pane" data-ref="mapPane">
      <div class="dws-target">
        <span class="dws-target-label">TARGET</span>
        <div class="dws-target-opts" data-ref="targetOpts" role="radiogroup" aria-label="Survey target family"></div>
      </div>
      <div class="dws-readout">
        <div class="dws-readout-row">
          <span class="dws-spawn" data-ref="spawn">NO SIGNAL</span>
          <span class="dws-age" data-ref="age"></span>
        </div>
        <div class="dws-readout-row dws-readout-figures">
          <span class="dws-figure"><span class="dws-figure-label">LOCAL</span><span class="dws-figure-value" data-ref="local">—</span></span>
          <span class="dws-figure"><span class="dws-figure-label">CURSOR</span><span class="dws-figure-value" data-ref="cursorVal">—</span></span>
          <span class="dws-figure"><span class="dws-figure-label">PEAK</span><span class="dws-figure-value" data-ref="peak">—</span></span>
        </div>
      </div>
      <div class="dws-map-frame" data-ref="frame">
        <canvas class="dws-map" data-ref="map" aria-label="Survey concentration map"></canvas>
      </div>
      <div class="dws-legend">
        <canvas class="dws-legend-bar" data-ref="legendBar" aria-hidden="true"></canvas>
        <div class="dws-legend-scale">
          <span data-ref="legendLo">—</span>
          <span class="dws-legend-note" data-ref="legendNote">NO SCAN DATA</span>
          <span data-ref="legendHi">—</span>
        </div>
      </div>
      <div class="dws-actions">
        <button type="button" class="dws-btn" data-ref="surveyBtn">SURVEY</button>
        <button type="button" class="dws-btn" data-ref="sampleBtn">TAKE SAMPLE</button>
      </div>
    </div>
    <div class="dws-pane dws-catalog" data-ref="catalogPane" hidden>
      <div class="dws-catalog-list" data-ref="catalogList"></div>
      <p class="dws-catalog-empty" data-ref="catalogEmpty" hidden>NO ACTIVE RESOURCE SPAWNS · AWAITING AUTHORITY SNAPSHOT</p>
    </div>
    <footer class="scp-status-foot">
      <span class="scp-status-line" data-ref="status" role="status" aria-live="polite" aria-atomic="true"></span>
    </footer>
  `;
  contentRoot.appendChild(root);

  const tabsEl = ref(root, "tabs");
  const mapPane = ref(root, "mapPane");
  const catalogPane = ref(root, "catalogPane");
  const targetOpts = ref(root, "targetOpts");
  const catalogList = ref(root, "catalogList");
  const catalogEmpty = ref(root, "catalogEmpty");
  const frame = ref(root, "frame");
  const map = ref(root, "map") as HTMLCanvasElement;
  const legendBar = ref(root, "legendBar") as HTMLCanvasElement;
  const spawnEl = ref(root, "spawn");
  const ageEl = ref(root, "age");
  const localEl = ref(root, "local");
  const cursorEl = ref(root, "cursorVal");
  const peakEl = ref(root, "peak");
  const legendLoEl = ref(root, "legendLo");
  const legendNoteEl = ref(root, "legendNote");
  const legendHiEl = ref(root, "legendHi");
  const surveyBtn = ref(root, "surveyBtn") as HTMLButtonElement;
  const sampleBtn = ref(root, "sampleBtn") as HTMLButtonElement;
  const statusEl = ref(root, "status");

  const mctx = map.getContext("2d");
  const lctx = legendBar.getContext("2d");
  const scratch = createCollectedItemsScratch();
  const rejectWatcher = createRejectWatcher(state, [
    "SurveyResource",
    "SampleResource",
    "SetPosture",
  ]);

  let disposed = false;
  let statusFlashTimer = 0;
  let pendingScanSinceMs: number | null = null;
  let pendingScanVersion = 0;
  let appliedComposite = "";
  let appliedLegend = "";
  let view: MapView | null = null;
  let cursorCss: { x: number; y: number } | null = null;
  let activeTab: "map" | "catalog" = "map";
  /** Effective survey target family — recomputed each update from the live
   *  options + the per-category remembered pick (survey store). */
  let targetFamily = resolveSurveyFamily(activeSurveyCategory(), []);
  let renderedOptionsKey = "";
  let renderedTargetFamily = "";
  let renderedCatalogKey = "";

  const heat: HeatLayer = {
    key: "",
    canvas: document.createElement("canvas"),
    ctx: null,
    cols: 0,
    rows: 0,
    texelScreenX: 1,
    texelScreenY: 1,
    hasData: false,
    minMilli: 0,
    maxMilli: 0,
    degenerate: false,
  };
  heat.ctx = heat.canvas.getContext("2d");

  /** Diff-gated textContent writes (datapad pattern). */
  const appliedText = new Map<HTMLElement, string>();
  const setText = (el: HTMLElement, text: string): void => {
    if (appliedText.get(el) === text) return;
    appliedText.set(el, text);
    el.textContent = text;
  };

  const flashStatus = (message: string): void => {
    window.clearTimeout(statusFlashTimer);
    statusEl.textContent = message;
    statusEl.toggleAttribute("data-flash", true);
    statusFlashTimer = window.setTimeout(() => {
      statusEl.toggleAttribute("data-flash", false);
    }, STATUS_FLASH_MS);
  };

  const hasSurveyTool = (): boolean => {
    const items = collectInventoryItems(
      state,
      (row) => row.itemId === resourceCategorySpec(activeSurveyCategory()).surveyToolItemId && isLocalInventoryContainer(state, row.container),
      scratch,
    );
    return items.length > 0;
  };

  const hasCraftsmanTraining = (): boolean => {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const actor = state.serverAuthority.actors[actorId];
    return (actor?.professions ?? []).some((profession) => (
      (profession.skillBoxes ?? []).includes("craftsman-novice")
    ));
  };

  surveyBtn.addEventListener("click", () => {
    if (surveyBtn.disabled) return;
    const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const queued = enqueueAuthoritySurveyResourceCommand(state.authorityCommands, targetFamily, tick);
    if (queued) {
      deps.sfx?.play("ui_button_tick");
      pendingScanSinceMs = performance.now();
      pendingScanVersion = surveyStoreVersion();
      flashStatus("SCANNING…");
    } else {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("DENIED");
    }
  });
  sampleBtn.addEventListener("click", () => {
    if (sampleBtn.disabled) return;
    const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const queued = enqueueAuthoritySampleResourceCommand(state.authorityCommands, targetFamily, tick);
    deps.sfx?.play(queued ? "ui_button_tick" : successorAudioIds.uiDeny);
    flashStatus(queued ? "SAMPLING — HOLD POSITION" : "DENIED");
  });

  const invalidatePaint = (): void => {
    appliedComposite = "";
    appliedLegend = "";
    heat.key = "";
    // Pointer is on the grip (resize) or elsewhere (reopen/tab flip) — a
    // stale crosshair would lie; hover restores it on the next move.
    cursorCss = null;
  };

  const applyTab = (tab: "map" | "catalog"): void => {
    if (tab === activeTab) return;
    activeTab = tab;
    mapPane.hidden = tab !== "map";
    catalogPane.hidden = tab !== "catalog";
    for (const button of tabsEl.querySelectorAll<HTMLButtonElement>(".scp-tab")) {
      button.setAttribute("aria-selected", button.dataset.tab === tab ? "true" : "false");
    }
    if (tab === "map") invalidatePaint();
  };
  tabsEl.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".scp-tab") : null;
    const tab = button?.dataset.tab;
    if (tab === "map" || tab === "catalog") applyTab(tab);
  });

  targetOpts.addEventListener("click", (event) => {
    const chip = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".dws-target-btn") : null;
    const family = chip?.dataset.family;
    if (!chip || chip.disabled || !family || family === targetFamily) return;
    setSelectedSurveyFamily(activeSurveyCategory(), family);
    targetFamily = family;
    deps.sfx?.play("ui_button_tick");
  });
  // Radio semantics: arrows move AND select (roving tabindex rides the
  // checked chip); Home/End jump; Enter/Space ride the native button click.
  targetOpts.addEventListener("keydown", (event) => {
    const { key } = event;
    const forward = key === "ArrowRight" || key === "ArrowDown";
    const backward = key === "ArrowLeft" || key === "ArrowUp";
    if (!forward && !backward && key !== "Home" && key !== "End") return;
    const chips = [...targetOpts.querySelectorAll<HTMLButtonElement>(".dws-target-btn:not(:disabled)")];
    if (chips.length === 0) return;
    event.preventDefault();
    const active = document.activeElement instanceof HTMLButtonElement
      ? chips.indexOf(document.activeElement)
      : -1;
    const next = key === "Home" || active < 0
      ? 0
      : key === "End"
        ? chips.length - 1
        : (active + (forward ? 1 : chips.length - 1)) % chips.length;
    const chip = chips[next]!;
    chip.focus();
    chip.click();
  });

  /** Rebuild the target chips only when the offered set changes (full-replace
   *  snapshots keep the key identical — no DOM churn, no focus theft); pure
   *  selection moves just re-point aria-checked + the roving tabindex. */
  const renderTarget = (category: ResourceCategory, options: readonly SurveyFamilyOption[]): void => {
    const optionsKey = `${category}|${options.map((option) => `${option.family}:${option.label}`).join(",")}`;
    const rebuilt = optionsKey !== renderedOptionsKey;
    const hadFocus = rebuilt && targetOpts.contains(document.activeElement);
    if (rebuilt) {
      renderedOptionsKey = optionsKey;
      renderedTargetFamily = "";
      targetOpts.textContent = "";
      if (options.length === 0) {
        // Empty offer — the primary-family fallback chip keeps the row shape
        // and names what SURVEY would scan; nothing to choose, nothing focusable.
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "dws-target-btn";
        chip.disabled = true;
        chip.setAttribute("role", "radio");
        chip.textContent = targetFamily.toUpperCase();
        const note = document.createElement("span");
        note.className = "dws-target-note";
        note.textContent = "NO LIVE SPAWNS";
        targetOpts.append(chip, note);
      } else {
        for (const option of options) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "dws-target-btn";
          chip.dataset.family = option.family;
          chip.setAttribute("role", "radio");
          chip.title = option.family.toUpperCase();
          chip.textContent = option.label.toUpperCase();
          targetOpts.appendChild(chip);
        }
      }
    }
    if (renderedTargetFamily !== targetFamily) {
      renderedTargetFamily = targetFamily;
      for (const chip of targetOpts.querySelectorAll<HTMLButtonElement>(".dws-target-btn")) {
        const checked = chip.disabled || chip.dataset.family === targetFamily;
        chip.setAttribute("aria-checked", checked ? "true" : "false");
        chip.tabIndex = checked && !chip.disabled ? 0 : -1;
      }
    }
    if (hadFocus) targetOpts.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
  };

  /** Compact spawn catalog — the authority's full-replace list joined to the
   *  category model, one row per spawn identity. Diff-gated on identity +
   *  target so snapshot refreshes that change nothing rewrite nothing. */
  const renderCatalog = (): void => {
    const spawns = state.serverAuthority.resourceSpawns;
    const catalogKey = `${targetFamily}|${spawns
      .map((spawn) => `${spawn.spawnId}:${spawn.family}:${spawn.name}:${spawn.classLabel}`)
      .join(";")}`;
    if (catalogKey === renderedCatalogKey) return;
    renderedCatalogKey = catalogKey;
    catalogList.textContent = "";
    const seen = new Set<string>();
    const rows: Array<{ spawn: (typeof spawns)[number]; family: string; category: ResourceCategory | null }> = [];
    for (const spawn of spawns) {
      if (seen.has(spawn.spawnId)) continue; // one row per identity
      seen.add(spawn.spawnId);
      const family = canonicalSurveyFamily(spawn.family);
      rows.push({ spawn, family, category: resourceCategoryForFamily(family) });
    }
    rows.sort((a, b) => {
      const rankA = a.category === null ? RESOURCE_CATEGORIES.length : RESOURCE_CATEGORIES.indexOf(a.category);
      const rankB = b.category === null ? RESOURCE_CATEGORIES.length : RESOURCE_CATEGORIES.indexOf(b.category);
      if (rankA !== rankB) return rankA - rankB;
      if (a.family !== b.family) return a.family.localeCompare(b.family);
      return a.spawn.name.localeCompare(b.spawn.name);
    });
    catalogEmpty.hidden = rows.length > 0;
    for (const { spawn, family, category } of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "dws-cat-row";
      const head = document.createElement("div");
      head.className = "dws-cat-head";
      const nameEl = document.createElement("span");
      nameEl.className = "dws-cat-name";
      nameEl.textContent = `${spawn.name} · ${spawn.classLabel}`.toUpperCase();
      const tagEl = document.createElement("span");
      tagEl.className = "dws-cat-tag";
      tagEl.textContent = (category ?? "unclassified").toUpperCase();
      head.append(nameEl, tagEl);
      const statsEl = document.createElement("div");
      statsEl.className = "dws-cat-stats";
      const famEl = document.createElement("span");
      famEl.className = "dws-cat-fam";
      famEl.toggleAttribute("data-target", family === targetFamily);
      famEl.textContent = family.toUpperCase();
      statsEl.appendChild(famEl);
      const top = STAT_ORDER
        .map((key) => ({ key, value: spawn.stats[key] }))
        .filter((stat) => Number.isFinite(stat.value) && stat.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 3);
      if (top.length > 0) {
        statsEl.appendChild(document.createTextNode(
          ` · ${top.map((stat) => `${statLabel(stat.key)} ${Math.round(stat.value)}`).join(" · ")}`,
        ));
      }
      rowEl.append(head, statsEl);
      catalogList.appendChild(rowEl);
    }
  };

  map.addEventListener("pointermove", (event) => {
    cursorCss = { x: event.offsetX, y: event.offsetY };
  });
  map.addEventListener("pointerleave", () => {
    cursorCss = null;
  });

  /** Cursor position in world cells, from the last painted view. */
  const cursorWorld = (): { x: number; y: number } | null => {
    if (!view || !cursorCss) return null;
    return surveyWorldPointFromScreen(
      view,
      cursorCss.x * view.devPerCssX,
      cursorCss.y * view.devPerCssY,
    );
  };

  /**
   * Rebuild the offscreen heat raster and its normalization range.
   *
   * Pass 1 samples every texel center through `surveyConcentrationAt` — the
   * store's newest-scan-wins lookup — so a world point owned by a newer disc
   * contributes that disc's value and NOTHING from occluded older scans, to
   * the paint and the range alike. Every raster texel is inside the visible
   * screen rect, so the range describes exactly the pixels being painted.
   * Pass 2 colorizes with the range fixed.
   */
  const rebuildHeat = (
    key: string,
    areaId: string,
    projection: SurveyMapProjection,
    viewW: number,
    viewH: number,
  ): void => {
    heat.key = key;
    heat.hasData = false;
    heat.minMilli = 0;
    heat.maxMilli = 0;
    heat.degenerate = false;
    heat.cols = 0;
    heat.rows = 0;
    const hctx = heat.ctx;
    if (!hctx || viewW <= 0 || viewH <= 0) return;
    const discs = surveyDiscsFor(areaId, targetFamily);
    if (discs.length === 0) return;

    // The raster lives in screen space. Every texel center is inverse
    // projected before sampling, so heat and every vector overlay share one
    // fixed camera basis without changing raw survey coordinates.
    const cols = Math.min(MAX_HEAT_TEXELS, Math.max(1, Math.ceil(viewW / 4)));
    const rows = Math.min(MAX_HEAT_TEXELS, Math.max(1, Math.ceil(viewH / 4)));
    heat.cols = cols;
    heat.rows = rows;
    heat.texelScreenX = viewW / cols;
    heat.texelScreenY = viewH / rows;
    if (heat.canvas.width !== cols || heat.canvas.height !== rows) {
      heat.canvas.width = cols;
      heat.canvas.height = rows;
    }

    const values = new Float32Array(cols * rows);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let r = 0; r < rows; r += 1) {
      const sy = (r + 0.5) * heat.texelScreenY;
      for (let c = 0; c < cols; c += 1) {
        const sx = (c + 0.5) * heat.texelScreenX;
        const world = surveyWorldPointFromScreen(projection, sx, sy);
        const milli = surveyConcentrationAt(areaId, targetFamily, world.x, world.y);
        values[r * cols + c] = milli === null ? -1 : milli;
        if (milli !== null) {
          if (milli < min) min = milli;
          if (milli > max) max = milli;
        }
      }
    }
    if (max < min) {
      // No scanned texel in view — raster stays fully transparent.
      hctx.clearRect(0, 0, cols, rows);
      return;
    }
    heat.hasData = true;
    heat.minMilli = min;
    heat.maxMilli = max;
    const span = max - min;
    heat.degenerate = span < DEGENERATE_SPAN_MILLI;

    const image = hctx.createImageData(cols, rows);
    const data = image.data;
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i] ?? -1;
      if (v < 0) continue; // void texel — alpha stays 0
      const t = heat.degenerate ? 0.5 : (v - min) / span;
      const band = heatBandFor(t);
      const o = i * 4;
      data[o] = band.r;
      data[o + 1] = band.g;
      data[o + 2] = band.b;
      data[o + 3] = HEAT_ALPHA;
    }
    hctx.putImageData(image, 0, 0);
  };

  const paintMap = (estimatedTick: number): void => {
    if (!mctx) return;
    const wCss = frame.clientWidth;
    const hCss = frame.clientHeight;
    // Below this the view scale would go non-positive (face pad eats the
    // half-extent) — nothing sane to draw anyway.
    if (wCss < 40 || hCss < 40) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(wCss * dpr));
    const h = Math.max(1, Math.round(hCss * dpr));
    const areaId = state.activeAreaId;
    const px = state.player.x;
    const py = state.player.y;
    const version = surveyStoreVersion();
    const latest = lastSurveyResultFor(areaId, targetFamily);
    const viewRadius = latest
      ? Math.max(latest.rangeCells * 1.35, 64)
      : DEFAULT_VIEW_RADIUS_CELLS;
    const scale = (Math.min(w, h) / 2 - 6 * dpr) / viewRadius;
    const projection: SurveyMapProjection = {
      playerX: px,
      playerY: py,
      centerX: w / 2,
      centerY: h / 2,
      scale,
    };
    view = {
      ...projection,
      devPerCssX: w / wCss,
      devPerCssY: h / hCss,
    };

    const heatKey = [
      areaId,
      targetFamily,
      version,
      px,
      py,
      w,
      h,
    ].join("|");
    if (heat.key !== heatKey) {
      rebuildHeat(heatKey, areaId, projection, w, h);
    }

    const ageBucket = Math.floor(estimatedTick / 30);
    const themeId = document.documentElement.getAttribute("data-sc3d-theme") ?? "";
    const cursorKey = cursorCss ? `${Math.round(cursorCss.x)}:${Math.round(cursorCss.y)}` : "-";
    const compositeKey =
      `${heatKey}|${Math.round(px * 4)}|${Math.round(py * 4)}|${ageBucket}|${cursorKey}|${state.facing}|${themeId}`;
    if (compositeKey === appliedComposite) return;
    appliedComposite = compositeKey;

    if (map.width !== w || map.height !== h) {
      map.width = w;
      map.height = h;
    }

    const styles = getComputedStyle(root);
    const tone = (name: string, fallback: string): string => {
      const value = styles.getPropertyValue(name).trim();
      return value.length > 0 ? value : fallback;
    };
    const inkTone = tone("--sc3d-ink", "#cfe9ef");
    const accentTone = tone("--sc3d-accent", "#48d6e6");
    const dimTone = tone("--sc3d-ink-dim", "#5f818c");
    const panelTone = tone("--sc3d-bg-panel", "#070b0d");

    // Face.
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = withAlpha(panelTone, 0.9);
    mctx.fillRect(0, 0, w, h);

    // Void lattice — world-anchored dots; where the heat layer covers them
    // the ground has been scanned, where dots show nobody has looked yet.
    let dotStep = VOID_DOT_CELLS;
    while (dotStep * scale < 9 * dpr) dotStep *= 2;
    const corners = [
      surveyWorldPointFromScreen(projection, 0, 0),
      surveyWorldPointFromScreen(projection, w, 0),
      surveyWorldPointFromScreen(projection, 0, h),
      surveyWorldPointFromScreen(projection, w, h),
    ];
    const worldLeft = Math.min(...corners.map((point) => point.x));
    const worldRight = Math.max(...corners.map((point) => point.x));
    const worldTop = Math.min(...corners.map((point) => point.y));
    const worldBottom = Math.max(...corners.map((point) => point.y));
    const dotMinor = withAlpha(dimTone, 0.16);
    const dotMajor = withAlpha(dimTone, 0.34);
    for (let gx = Math.ceil(worldLeft / dotStep) * dotStep; gx <= worldRight; gx += dotStep) {
      const majorX = mod(gx, VOID_DOT_MAJOR_CELLS) === 0;
      for (let gy = Math.ceil(worldTop / dotStep) * dotStep; gy <= worldBottom; gy += dotStep) {
        const point = surveyScreenPointFromWorld(projection, gx, gy);
        if (point.x < 0 || point.y < 0 || point.x > w || point.y > h) continue;
        const major = majorX && mod(gy, VOID_DOT_MAJOR_CELLS) === 0;
        const size = major ? 2 * dpr : dpr;
        mctx.fillStyle = major ? dotMajor : dotMinor;
        mctx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
      }
    }

    // Heat layer — chunky texels, no smoothing (the instrument voice).
    if (heat.hasData && heat.cols > 0) {
      mctx.imageSmoothingEnabled = false;
      mctx.drawImage(heat.canvas, 0, 0, w, h);
    }

    // Disc rims — scan-coverage witnesses. Newest rim reads in ink, older
    // ones dim; age fades the rim toward a floor, never to nothing.
    const discs = surveyDiscsFor(areaId, targetFamily);
    mctx.lineWidth = Math.max(1, dpr);
    for (let d = discs.length - 1; d >= 0; d -= 1) {
      const disc = discs[d];
      if (!disc) continue;
      const center = surveyScreenPointFromWorld(projection, disc.centerX, disc.centerY);
      const radius = northUpScreenVectorFromWorld(disc.rangeCells, 0);
      const dcx = center.x;
      const dcy = center.y;
      const dr = Math.hypot(radius.x, radius.y) * scale;
      if (dcx + dr < 0 || dcy + dr < 0 || dcx - dr > w || dcy - dr > h) continue;
      const ageTicks = Math.max(0, estimatedTick - disc.scannedAtTick);
      const fade = Math.max(0, 1 - ageTicks / AGE_FULL_TICKS);
      mctx.globalAlpha = RIM_ALPHA_FLOOR + (RIM_ALPHA_FRESH - RIM_ALPHA_FLOOR) * fade;
      mctx.strokeStyle = d === 0 ? inkTone : dimTone;
      mctx.beginPath();
      mctx.arc(dcx, dcy, dr, 0, Math.PI * 2);
      mctx.stroke();
    }
    mctx.globalAlpha = 1;

    // Scale bar — bottom-left, names the lattice in world cells.
    let barCells: number = SCALE_BAR_STEPS[0];
    for (const step of SCALE_BAR_STEPS) {
      if (step * scale <= w * 0.32) barCells = step;
    }
    const barPx = barCells * scale;
    const bx = 10 * dpr;
    const by = h - 9 * dpr;
    mctx.strokeStyle = withAlpha(dimTone, 0.8);
    mctx.lineWidth = Math.max(1, dpr);
    mctx.beginPath();
    mctx.moveTo(bx, by);
    mctx.lineTo(bx + barPx, by);
    mctx.moveTo(bx, by - 3 * dpr);
    mctx.lineTo(bx, by + 3 * dpr);
    mctx.moveTo(bx + barPx, by - 3 * dpr);
    mctx.lineTo(bx + barPx, by + 3 * dpr);
    mctx.stroke();
    haloLabel(mctx, `${barCells} CELLS`, bx + barPx / 2, by - 5 * dpr, withAlpha(dimTone, 0.9), dpr, "center");

    // Cursor crosshair — the CURSOR figure names the % under these lines.
    if (cursorCss) {
      const sx = cursorCss.x * (w / wCss);
      const sy = cursorCss.y * (h / hCss);
      if (sx >= 0 && sy >= 0 && sx <= w && sy <= h) {
        mctx.strokeStyle = withAlpha(inkTone, 0.28);
        mctx.lineWidth = Math.max(1, 0.75 * dpr);
        mctx.beginPath();
        mctx.moveTo(sx, 0);
        mctx.lineTo(sx, h);
        mctx.moveTo(0, sy);
        mctx.lineTo(w, sy);
        mctx.stroke();
        mctx.strokeStyle = withAlpha(inkTone, 0.85);
        mctx.lineWidth = Math.max(1, dpr);
        mctx.beginPath();
        mctx.arc(sx, sy, 3.5 * dpr, 0, Math.PI * 2);
        mctx.stroke();
      }
    }

    // Peak pin — the point the player actually walks to. Diamond + value
    // in view; bearing chevron on the rect edge when out of view (the PEAK
    // figure keeps the number on screen either way).
    const richest = surveyRichestKnown(areaId, targetFamily);
    if (richest) {
      const peak = surveyScreenPointFromWorld(projection, richest.x, richest.y);
      const mx = peak.x;
      const my = peak.y;
      const edgePad = 12 * dpr;
      const inView = mx >= edgePad && mx <= w - edgePad && my >= edgePad && my <= h - edgePad;
      mctx.strokeStyle = inkTone;
      mctx.lineWidth = Math.max(1, 1.25 * dpr);
      if (inView) {
        const s = 5 * dpr;
        mctx.save();
        // Dark backing halo: the pin must survive the hottest band.
        mctx.shadowColor = "rgba(4, 6, 7, 0.95)";
        mctx.shadowBlur = 3 * dpr;
        mctx.beginPath();
        mctx.moveTo(mx, my - s);
        mctx.lineTo(mx + s, my);
        mctx.lineTo(mx, my + s);
        mctx.lineTo(mx - s, my);
        mctx.closePath();
        mctx.stroke();
        mctx.restore();
        const labelX = Math.min(Math.max(mx + 8 * dpr, 4 * dpr), w - 34 * dpr);
        const labelY = Math.min(Math.max(my - 7 * dpr, 10 * dpr), h - 4 * dpr);
        haloLabel(mctx, (richest.milli / 10).toFixed(1), labelX, labelY, inkTone, dpr, "left");
      } else {
        const dx = mx - w / 2;
        const dy = my - h / 2;
        const tEdge = Math.min(
          dx !== 0 ? (w / 2 - edgePad) / Math.abs(dx) : Number.POSITIVE_INFINITY,
          dy !== 0 ? (h / 2 - edgePad) / Math.abs(dy) : Number.POSITIVE_INFINITY,
        );
        if (Number.isFinite(tEdge)) {
          const ex = w / 2 + dx * tEdge;
          const ey = h / 2 + dy * tEdge;
          const angle = Math.atan2(dy, dx);
          const s = 6 * dpr;
          mctx.beginPath();
          mctx.moveTo(ex + Math.cos(angle) * s, ey + Math.sin(angle) * s);
          mctx.lineTo(ex + Math.cos(angle + 2.5) * s, ey + Math.sin(angle + 2.5) * s);
          mctx.lineTo(ex + Math.cos(angle - 2.5) * s, ey + Math.sin(angle - 2.5) * s);
          mctx.closePath();
          mctx.stroke();
        }
      }
    }

    // Player blip — dead center (the world moves, you don't) with a facing
    // tick from the 8-dir compass facing. angleForDirection maps directly to
    // this map's world axes (0 = +x, π/2 = +y = screen-down). The dark disc
    // under the blip guarantees contrast over the hottest band.
    const cx = w / 2;
    const cy = h / 2;
    const facingRad = angleForDirection(state.facing);
    const facingScreen = northUpScreenVectorFromWorld(Math.cos(facingRad), Math.sin(facingRad));
    mctx.fillStyle = withAlpha(panelTone, 0.65);
    mctx.beginPath();
    mctx.arc(cx, cy, 4.5 * dpr, 0, Math.PI * 2);
    mctx.fill();
    mctx.strokeStyle = accentTone;
    mctx.lineWidth = Math.max(1, 1.4 * dpr);
    mctx.beginPath();
    mctx.moveTo(cx + facingScreen.x * 3.5 * dpr, cy + facingScreen.y * 3.5 * dpr);
    mctx.lineTo(cx + facingScreen.x * 9 * dpr, cy + facingScreen.y * 9 * dpr);
    mctx.stroke();
    mctx.fillStyle = accentTone;
    mctx.beginPath();
    mctx.arc(cx, cy, 2.6 * dpr, 0, Math.PI * 2);
    mctx.fill();
  };

  /** Legend bar: the exact band table, or a ghost of it while idle; a
   *  degenerate span paints flat mid-band (matches the map). */
  const paintLegend = (): void => {
    if (!lctx) return;
    const wCss = legendBar.clientWidth;
    const hCss = legendBar.clientHeight;
    if (wCss <= 0 || hCss <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(wCss * dpr));
    const h = Math.max(1, Math.round(hCss * dpr));
    const key = `${w}|${h}|${heat.hasData}|${heat.minMilli}|${heat.maxMilli}|${heat.degenerate}`;
    if (key === appliedLegend) return;
    appliedLegend = key;
    if (legendBar.width !== w || legendBar.height !== h) {
      legendBar.width = w;
      legendBar.height = h;
    }
    lctx.clearRect(0, 0, w, h);
    if (heat.hasData && heat.degenerate) {
      lctx.fillStyle = heatBandFor(0.5).css;
      lctx.fillRect(0, 0, w, h);
      return;
    }
    lctx.globalAlpha = heat.hasData ? 1 : 0.22;
    const bandW = w / HEAT_BANDS;
    for (let k = 0; k < HEAT_BANDS; k += 1) {
      lctx.fillStyle = HEAT_BAND_TABLE[k]!.css;
      lctx.fillRect(Math.floor(k * bandW), 0, Math.ceil(bandW) + 1, h);
    }
    lctx.globalAlpha = 1;
  };

  return {
    update(_dtSeconds: number, _timeMs: number): void {
      const estimatedTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
      const areaId = state.activeAreaId;
      const toolCarried = hasSurveyTool();
      const craftsmanTrained = hasCraftsmanTraining();
      // Live target options ride the spawn snapshot; the effective family is
      // the per-category remembered pick with primary-family fallback.
      const category = activeSurveyCategory();
      const options = surveyFamilyOptionsFor(state.serverAuthority.resourceSpawns, category);
      targetFamily = resolveSurveyFamily(category, options.map((option) => option.family));
      renderTarget(category, options);
      const latest = lastSurveyResultFor(areaId, targetFamily);

      // Pending-scan bookkeeping: resolve on new store data, or time out.
      if (pendingScanSinceMs !== null) {
        if (surveyStoreVersion() !== pendingScanVersion) {
          pendingScanSinceMs = null;
          flashStatus("SCAN COMPLETE");
        } else if (performance.now() - pendingScanSinceMs > SCAN_PENDING_TIMEOUT_MS) {
          pendingScanSinceMs = null;
          flashStatus("NO SCAN RESPONSE");
        }
      }

      // Readout figures — exact percentages; the map's colour is relative.
      // Family rides the RESULT (category-generic survey; a hardcoded IRON
      // lied on copper/chemical scans); separator is the house `·` (C22).
      setText(spawnEl, latest ? `${latest.spawnName.toUpperCase()} · ${latest.family.toUpperCase()}` : "NO SIGNAL");
      const local = surveyConcentrationAt(areaId, targetFamily, state.player.x, state.player.y);
      setText(localEl, local === null ? "—" : formatPercent(local));
      const cw = cursorWorld();
      const cursorMilli = cw === null ? null : surveyConcentrationAt(areaId, targetFamily, cw.x, cw.y);
      setText(cursorEl, cursorMilli === null ? "—" : formatPercent(cursorMilli));
      const richest = surveyRichestKnown(areaId, targetFamily);
      setText(peakEl, richest ? formatPercent(richest.milli) : "—");
      if (latest) {
        const ageSeconds = Math.max(0, Math.round((estimatedTick - latest.tick) / Math.max(1, slice.tickRateHz)));
        setText(ageEl, `SCAN ${ageSeconds}s`);
      } else {
        setText(ageEl, "");
      }

      // Hand sampling is the universal resource bootstrap. Only the richer
      // map survey needs Craftsman training and a matching category tool;
      // survey cooldown does not lock the universal hand sample.
      const coolingTicks = latest ? latest.cooldownUntilTick - estimatedTick : 0;
      const cooling = coolingTicks > 0;
      surveyBtn.disabled = !craftsmanTrained || !toolCarried || cooling || pendingScanSinceMs !== null;
      sampleBtn.disabled = false;
      surveyBtn.textContent = cooling
        ? `SURVEY · ${Math.ceil(coolingTicks / Math.max(1, slice.tickRateHz))}s`
        : "SURVEY";
      if (!statusEl.hasAttribute("data-flash")) {
        if (!craftsmanTrained && !toolCarried) {
          statusEl.textContent = "HAND SAMPLE READY · TOOL SURVEY REQUIRES CRAFTSMAN + MATCHING TOOL";
        } else if (!craftsmanTrained) {
          statusEl.textContent = "HAND SAMPLE READY · TOOL SURVEY REQUIRES CRAFTSMAN";
        } else if (!toolCarried) {
          statusEl.textContent = "HAND SAMPLE READY · TOOL SURVEY REQUIRES MATCHING TOOL";
        } else {
          statusEl.textContent = "HAND SAMPLE READY · CRAFTSMAN SURVEY READY";
        }
      }

      const denied = rejectWatcher.poll();
      if (denied) flashStatus(denied);

      paintMap(estimatedTick);
      paintLegend();
      renderCatalog();

      // Legend endpoints — LIVE range of the visible samples. A degenerate
      // span labels both ends with the midpoint so bar and figures agree.
      if (heat.hasData) {
        const mid = (heat.minMilli + heat.maxMilli) / 2;
        // Lo endpoint spells no % — the legend names it once, on the hot end.
        setText(legendLoEl, ((heat.degenerate ? mid : heat.minMilli) / 10).toFixed(1));
        setText(legendHiEl, heat.degenerate ? formatPercent(mid) : formatPercent(heat.maxMilli));
        setText(legendNoteEl, "RANGE IN VIEW");
      } else {
        setText(legendLoEl, "—");
        setText(legendHiEl, "—");
        setText(legendNoteEl, "NO SCAN DATA");
      }
    },
    onResized(): void {
      invalidatePaint();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(statusFlashTimer);
      root.remove();
    },
  };
}

/** Milli (0–1000) → "42.5%" (one % across the whole panel per figure). */
function formatPercent(milli: number): string {
  return `${(milli / 10).toFixed(1)}%`;
}


/** Euclidean modulo (world coords go negative near the area edge). */
function mod(value: number, m: number): number {
  return ((value % m) + m) % m;
}

/** Canvas text with a dark backing halo — labels must survive hot bands
 *  and dark void alike (datapad label doctrine). */
function haloLabel(
  draw: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: string,
  dpr: number,
  align: CanvasTextAlign,
): void {
  draw.font = `${Math.max(8, Math.round(8.5 * dpr))}px ui-monospace, monospace`;
  draw.textAlign = align;
  draw.textBaseline = "alphabetic";
  draw.shadowColor = "rgba(4, 6, 7, 0.9)";
  draw.shadowBlur = 3 * dpr;
  draw.fillStyle = style;
  draw.fillText(text, x, y);
  draw.shadowBlur = 0;
  draw.shadowColor = "transparent";
  draw.textAlign = "left";
}

/** Theme tokens are hex; compose rgba for canvas (datapad pattern). */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const clean = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color;
    const value = Number.parseInt(clean.slice(1, 7), 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`survey window: missing data-ref="${name}"`);
  return el;
}
