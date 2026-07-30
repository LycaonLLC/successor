import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import type { InventoryRow } from "@successor/client/src/slice-core/gameState";
import {
  collectInventoryItems,
  createCollectedItemsScratch,
  isLocalInventoryContainer,
  modelPathForItemId,
} from "../inventory/data";
import { InventoryModelRenderer } from "../inventory/modelRenderer";
import type {
  InventoryItemVM,
  InventoryLayoutRects,
  InventoryViewModel,
  PaperDollVM,
} from "../inventory/types";
import { resourceTaxonomyForItemId } from "../inventory/resourceInfo";
import { UI_ICONS } from "../icons";
import { craftSlotIconOrGenericSvg } from "../iconRegistry";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windows/windowManager";
import { createCraftReceiptWatcher, type CraftCommandPort, type CraftReceipt } from "./commands";
import {
  adjustPendingSpend,
  CATEGORY_TABS,
  clampDraftUses,
  composeBrowserGroups,
  composeFinish,
  composeRecipeLedger,
  composeSlotScreen,
  nextSlotIndex,
  type CraftCategoryFilter,
  type OptionRow,
  type PendingSpend,
  type StatHoverRow,
} from "./composers";
import { CRAFT_COPY, craftReasonLine } from "./copy";
import {
  craftRecipeDetail,
  craftRecipes,
  craftSession,
  craftStoreVersion,
  syncCraftChannelFromAuthority,
} from "./store";
import type { CraftRecipeSummaryVM, CraftSessionVM, CraftSlotSpecVM } from "./types";

import { deriveSlugthrowerStats, slugthrowerStatRows } from "../inventory/slugthrowerStats";
/**
 * CRAFT — the FIELD BENCH: five-stage crafting laid out like a portable
 * tool opened on HUD glass (SCHEMATIC · LOAD · ASSEMBLE · TUNE · FINISH).
 *
 * SCHEMATIC: eligible recipes left by default (category tabs; an explicit
 * SHOW INELIGIBLE toggle reveals locked profession paths), ledger right (3D turntable, description, required
 * materials, expected limits) — BEGIN ASSEMBLY arms when trained and a tool
 * is carried. LOAD: material WELLS left (tactile seats with purpose
 * vectors), the selected well's eligible stacks right with the server's
 * BEST FIT tag; ASSEMBLE arms when every well is seated and the rail marks
 * the ASSEMBLE step live. Assembly lands as a calm settle line — true
 * values, no theater (the old grade-stamp reveal is retired). TUNE: the
 * 7-point pool as pips, one hairline rail per property with the material
 * cap PIN and the value CARET, per-line point marks, and the EXACT
 * hold/slip chance from the authority's onePointSuccessMilli /
 * batchRiskPerExtraPointMilli — never a client-side roll. FINISH: optional
 * 1–48 item name (empty keeps the schematic name), three mode latches —
 * PROTOTYPE / PRACTICE (+5% base XP, materials spent, no item) / DRAFT
 * SCHEMATIC (uses ≤1000) — behind ONE primary press; completions land as a
 * short calm toast (reduced-motion: no animation). Post-assemble ABANDON
 * stays a two-step armed confirm because the materials are already spent.
 *
 * Server truth only: phases key off the streamed craftSession VM and every
 * reject flashes the player-language reason map + ui_deny. No dev copy.
 */

import { CRAFT_WINDOW_ID } from "./craftWindowIds";
export { CRAFT_WINDOW_ID };

export interface CraftWindowDeps {
  commands: CraftCommandPort;
  sfx?: SfxPlayer;
}

/** Keep resource outputs on their standardized container-preview lane. */
export function craftPreviewCategoryForItemId(itemId: number): InventoryItemVM["category"] {
  return resourceTaxonomyForItemId(itemId) ? "resource" : "item";
}

const STATUS_FLASH_MS = 2200;
const ABANDON_ARM_MS = 2600;
/** Assembly settle line hold (ms) — calm, then it yields to the rails. */
const SETTLE_MS = 1600;
/** Completion toast hold (ms). */
const TOAST_MS = 2600;
const CRAFT_DRAG_MIME = "text/x-sc3d-craft-mat";
const STALE_RECEIPT_MS = 10_000;
/** Browse-bootstrap nudge cadence while no craft data has streamed. */
const BOOTSTRAP_RETRY_MS = 2_000;

type Phase = "browser" | "slots" | "finish";
/** Sub-view of the assembled phase (rail steps TUNE and FINISH). */
type AssembledView = "tune" | "finish";
type FinishMode = "prototype" | "practice" | "draft";

const SVG_STROKE_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

/** ⓘ — hover/focus explainer buttons (real vector, house stroke voice). */
const INFO_SVG = `${SVG_STROKE_OPEN}<circle cx="12" cy="12" r="8.25"/><path d="M12 11.2v4.8"/><circle cx="12" cy="7.9" r="0.5" fill="currentColor"/></svg>`;
const MINUS_SVG = `${SVG_STROKE_OPEN}<path d="M6 12h12"/></svg>`;
const PLUS_SVG = `${SVG_STROKE_OPEN}<path d="M12 6v12M6 12h12"/></svg>`;
/** Rail badge arrow — better always travels toward the cap pin (right). */
const DIR_TO_CAP_SVG = `${SVG_STROKE_OPEN}<path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
/** FINISH mode latch glyphs (crate / practice rings / draft sheet). */
const MODE_PROTOTYPE_SVG = `${SVG_STROKE_OPEN}<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/></svg>`;
const MODE_PRACTICE_SVG = `${SVG_STROKE_OPEN}<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.25"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>`;
const MODE_DRAFT_SVG = `${SVG_STROKE_OPEN}<path d="M6.5 3h8l4 4v14h-12z"/><path d="M14.5 3v4h4"/><path d="M9.5 11.5h5M9.5 15h5"/></svg>`;

export function createCraftWindowDefinition(deps: CraftWindowDeps): WindowDefinition {
  return {
    id: CRAFT_WINDOW_ID,
    title: "CRAFT",
    icon: "craft",
    // Context-only bench: opened from carried raw-resource rows, the Field
    // Multitool, or device routes — no dock button or global hotkey.
    hotkey: null,
    dockVisible: false,
    minWidth: 580,
    minHeight: 440,
    // r2 cascade (fe-polish §1.30): the centered family staggers so every
    // title strip stays grabbable in the all-open pile.
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = Math.max(580, Math.round(viewport.w * 0.46));
      const h = Math.max(440, Math.round(viewport.h * 0.64));
      const x = Math.max(12, Math.round((viewport.w - w) / 2) - 100);
      return { x, y: Math.min(150, Math.round(viewport.h * 0.17)), w, h };
    },
    mount: (contentRoot, ctx) => mountCraftContent(contentRoot, ctx, deps),
  };
}

function mountCraftContent(
  contentRoot: HTMLElement,
  ctx: WindowContext,
  deps: CraftWindowDeps,
): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root scp-craft";
  root.innerHTML = `
    <div class="inv-canvas-layer" data-ref="canvasLayer" aria-hidden="true"></div>
    <div class="scp-craft-chrome">
      <nav class="scp-craft-rail" data-ref="rail" aria-label="Crafting phase"></nav>
      <section class="scp-craft-surface scp-craft-browse" data-ref="browserSurface">
        <div class="scp-craft-browse-list">
          <nav class="scp-tabs scp-craft-cats" data-ref="cats" role="tablist"></nav>
          <div class="scp-craft-filter-row">
            <input class="scp-craft-search" data-ref="recipeSearch" type="search"
              placeholder="${CRAFT_COPY.browser.searchPlaceholder}" aria-label="${CRAFT_COPY.browser.searchLabel}"
              autocomplete="off" spellcheck="false" />
            <button type="button" class="scp-craft-eligibility-toggle" data-ref="showIneligible"
              aria-pressed="false" title="${CRAFT_COPY.browser.eligibilityHint}">${CRAFT_COPY.browser.showIneligible}</button>
          </div>
          <div class="scp-craft-recipes" data-ref="recipeList"></div>
          <div class="scp-empty" data-ref="recipeEmpty" hidden>
            <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.craft}</span>
            <span data-ref="recipeEmptyText">${CRAFT_COPY.browser.empty}</span>
            <small data-ref="recipeEmptyHint">${CRAFT_COPY.browser.emptyHint}</small>
          </div>
        </div>
        <div class="scp-craft-ledger" data-ref="ledger" hidden>
          <div class="scp-craft-well" data-ref="browserWell"></div>
          <strong class="scp-craft-name" data-ref="ledgerName"></strong>
          <span class="scp-craft-meta" data-ref="ledgerMeta"></span>
          <p class="scp-craft-desc" data-ref="ledgerDesc"></p>
          <div class="scp-craft-sect" data-ref="reqSect" hidden>
            <span class="scp-section-title">${CRAFT_COPY.browser.requirements}</span>
            <div class="scp-craft-reqs" data-ref="reqList"></div>
          </div>
          <div class="scp-craft-sect" data-ref="limitSect" title="${CRAFT_COPY.browser.limitsHint}" hidden>
            <span class="scp-section-title">${CRAFT_COPY.browser.limits}</span>
            <div class="scp-craft-limits" data-ref="limitList"></div>
          </div>
          <div class="scp-craft-cta">
            <button type="button" class="scp-craft-btn scp-craft-btn--accent" data-ref="begin">${CRAFT_COPY.browser.begin}</button>
            <span class="scp-craft-note" data-ref="beginNote"></span>
          </div>
        </div>
        <div class="scp-craft-ledger scp-craft-ledger--idle" data-ref="ledgerIdle">
          <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.craft}</span>
          <span>Select a recipe</span>
        </div>
      </section>
      <section class="scp-craft-surface scp-craft-slots" data-ref="slotsSurface" hidden>
        <header class="scp-craft-phase-head">
          <div class="scp-craft-well scp-craft-well--mini" data-ref="slotsWell"></div>
          <div class="scp-craft-phase-title">
            <strong data-ref="slotsName"></strong>
            <span class="scp-craft-active-slot" data-ref="activeSlot"></span>
            <span>${CRAFT_COPY.slots.assign}</span>
          </div>
        </header>
        <div class="scp-craft-slots-body">
          <div class="scp-craft-slotcards" data-ref="slotCards" role="radiogroup" aria-label="Material wells"></div>
          <div class="scp-craft-options">
            <header class="scp-craft-options-head">
              <span class="scp-craft-options-title">${CRAFT_COPY.slots.eligibleTitle}
                <button type="button" class="scp-craft-info" data-ref="qualityInfo" title="${CRAFT_COPY.slots.qualityInfo}" aria-label="About material quality">${INFO_SVG}</button>
              </span>
              <span class="scp-craft-options-stat" data-ref="optStat"></span>
            </header>
            <div class="scp-craft-optlist" data-ref="optList"></div>
            <div class="scp-empty scp-craft-optempty" data-ref="optEmpty" hidden>
              <span>${CRAFT_COPY.slots.eligibleEmpty}</span>
            </div>
            <div class="scp-craft-statbox" data-ref="statBox" hidden></div>
          </div>
        </div>
        <footer class="scp-craft-cta scp-craft-cta--split">
          <button type="button" class="scp-craft-btn scp-craft-btn--accent" data-ref="assemble">${CRAFT_COPY.slots.assemble}</button>
          <span class="scp-craft-note" data-ref="assembleNote"></span>
          <button type="button" class="scp-craft-btn" data-ref="cancelFree" title="${CRAFT_COPY.slots.cancelFree}">${CRAFT_COPY.slots.cancel}</button>
        </footer>
      </section>
      <section class="scp-craft-surface scp-craft-finish" data-ref="finishSurface" data-view="tune" hidden>
        <header class="scp-craft-phase-head">
          <div class="scp-craft-well scp-craft-well--mini" data-ref="finishWell"></div>
          <div class="scp-craft-quality">
            <span class="scp-craft-assembly-readout" data-ref="quality"></span>
            <span class="scp-craft-settle" data-ref="settle" hidden>${CRAFT_COPY.tune.settle}</span>
          </div>
          <div class="scp-craft-points">
            <span class="scp-craft-points-label">${CRAFT_COPY.tune.points}
              <button type="button" class="scp-craft-info" data-ref="riskInfo" title="${CRAFT_COPY.tune.riskInfo}" aria-label="About tuning risk">${INFO_SVG}</button>
            </span>
            <span class="scp-craft-pips" data-ref="pips" aria-hidden="true"></span>
            <strong data-ref="points"></strong>
          </div>
        </header>
        <div class="scp-craft-lines-head">
          <span class="scp-craft-lines-title">${CRAFT_COPY.tune.linesTitle}
            <button type="button" class="scp-craft-info" data-ref="capInfo" title="${CRAFT_COPY.tune.capInfo}" aria-label="About cap pins">${INFO_SVG}</button>
          </span>
          <span class="scp-craft-lines-hint" data-ref="slipHint">${CRAFT_COPY.tune.slipWarn}</span>
        </div>
        <div class="scp-craft-lines" data-ref="lines"></div>
        <div class="scp-craft-weapon-preview" data-ref="weaponPreview" aria-live="polite"></div>
        <footer class="scp-craft-cta scp-craft-cta--split" data-ref="tuneFoot">
          <button type="button" class="scp-craft-btn" data-ref="exitExperiment" title="${CRAFT_COPY.finish.applyHint}">${CRAFT_COPY.finish.apply}</button>
          <span class="scp-craft-note" data-ref="tuneNote"></span>
          <button type="button" class="scp-craft-btn" data-ref="toFinish">${CRAFT_COPY.tune.toFinish}</button>
        </footer>
        <div class="scp-craft-finishform" data-ref="finishForm" hidden>
          <div class="scp-craft-field">
            <span class="scp-craft-field-label">${CRAFT_COPY.finish.nameLabel}</span>
            <input class="scp-craft-name-input" data-ref="nameInput" type="text" maxlength="48"
              placeholder="${CRAFT_COPY.finish.namePlaceholder}" aria-label="Custom item name" />
            <small class="scp-craft-field-hint">${CRAFT_COPY.finish.nameHint}</small>
          </div>
          <div class="scp-craft-field">
            <span class="scp-craft-field-label">${CRAFT_COPY.finish.modeLabel}</span>
            <div class="scp-craft-modes" role="radiogroup" aria-label="Finish mode">
              <div class="scp-craft-mode">
                <button type="button" class="scp-craft-mode-latch" role="radio" aria-checked="true" data-mode="prototype" data-ref="modePrototype">
                  <span class="scp-craft-mode-ic" aria-hidden="true">${MODE_PROTOTYPE_SVG}</span>
                  <span class="scp-craft-mode-text"><strong>${CRAFT_COPY.finish.prototype}</strong><small>${CRAFT_COPY.finish.prototypeNote}</small></span>
                  <span class="scp-craft-mode-dot" aria-hidden="true"></span>
                </button>
              </div>
              <div class="scp-craft-mode">
                <button type="button" class="scp-craft-mode-latch" role="radio" aria-checked="false" data-mode="practice" data-ref="modePractice">
                  <span class="scp-craft-mode-ic" aria-hidden="true">${MODE_PRACTICE_SVG}</span>
                  <span class="scp-craft-mode-text"><strong>${CRAFT_COPY.finish.practice}</strong><small>${CRAFT_COPY.finish.practiceNote}</small></span>
                  <span class="scp-craft-mode-dot" aria-hidden="true"></span>
                </button>
                <button type="button" class="scp-craft-info" data-ref="practiceInfo" title="${CRAFT_COPY.finish.practiceInfo}" aria-label="About practice">${INFO_SVG}</button>
              </div>
              <div class="scp-craft-mode">
                <button type="button" class="scp-craft-mode-latch" role="radio" aria-checked="false" data-mode="draft" data-ref="modeDraft">
                  <span class="scp-craft-mode-ic" aria-hidden="true">${MODE_DRAFT_SVG}</span>
                  <span class="scp-craft-mode-text"><strong>${CRAFT_COPY.finish.draft}</strong><small>${CRAFT_COPY.finish.draftNote}</small></span>
                  <span class="scp-craft-mode-dot" aria-hidden="true"></span>
                </button>
                <button type="button" class="scp-craft-info" data-ref="draftInfo" title="${CRAFT_COPY.finish.draftHint}" aria-label="About draft schematics">${INFO_SVG}</button>
              </div>
            </div>
          </div>
          <div class="scp-craft-draftrow" data-ref="draftRow" hidden>
            <span class="scp-craft-draftrow-label">${CRAFT_COPY.finish.draftUses}
              <button type="button" class="scp-craft-info" data-ref="usesInfo" title="${CRAFT_COPY.finish.draftUsesInfo}" aria-label="About schematic uses">${INFO_SVG}</button>
            </span>
            <button type="button" class="scp-craft-btn scp-craft-step" data-ref="usesDown" aria-label="Fewer uses">${MINUS_SVG}</button>
            <input class="scp-craft-uses" data-ref="usesInput" type="text" inputmode="numeric" maxlength="4" aria-label="Schematic uses" />
            <button type="button" class="scp-craft-btn scp-craft-step" data-ref="usesUp" aria-label="More uses">${PLUS_SVG}</button>
          </div>
        </div>
        <footer class="scp-craft-cta scp-craft-cta--split" data-ref="finishFoot" hidden>
          <button type="button" class="scp-craft-btn" data-ref="backTune">${CRAFT_COPY.finish.backToTune}</button>
          <span class="scp-craft-note" data-ref="finishNote"></span>
          <button type="button" class="scp-craft-btn scp-craft-btn--accent scp-craft-go" data-ref="finishGo">${CRAFT_COPY.finish.prototypeGo}</button>
        </footer>
        <footer class="scp-craft-abandon" title="${CRAFT_COPY.finish.abandonHint}">
          <button type="button" class="scp-craft-btn scp-craft-btn--danger" data-ref="abandon">${CRAFT_COPY.finish.abandon}</button>
          <span class="scp-craft-note" data-ref="abandonNote"></span>
        </footer>
      </section>
      <div class="scp-craft-toast" data-ref="toast" role="status" hidden>
        <span class="scp-craft-toast-main" data-ref="toastMain"></span>
        <small class="scp-craft-toast-sub" data-ref="toastSub"></small>
      </div>
      <footer class="scp-status-foot">
        <span class="scp-status-line" data-ref="status"></span>
        <span class="scp-craft-session-tag" data-ref="sessionTag"></span>
      </footer>
    </div>
  `;
  contentRoot.appendChild(root);

  const canvasLayer = ref(root, "canvasLayer");
  const railEl = ref(root, "rail");
  const browserSurface = ref(root, "browserSurface");
  const catsEl = ref(root, "cats");
  const recipeListEl = ref(root, "recipeList");
  const recipeSearchEl = ref(root, "recipeSearch") as HTMLInputElement;
  const showIneligibleBtn = ref(root, "showIneligible") as HTMLButtonElement;
  const recipeEmptyEl = ref(root, "recipeEmpty");
  const recipeEmptyTextEl = ref(root, "recipeEmptyText");
  const recipeEmptyHintEl = ref(root, "recipeEmptyHint");
  const ledgerEl = ref(root, "ledger");
  const ledgerIdleEl = ref(root, "ledgerIdle");
  const browserWell = ref(root, "browserWell");
  const ledgerNameEl = ref(root, "ledgerName");
  const ledgerMetaEl = ref(root, "ledgerMeta");
  const ledgerDescEl = ref(root, "ledgerDesc");
  const reqSectEl = ref(root, "reqSect");
  const reqListEl = ref(root, "reqList");
  const limitSectEl = ref(root, "limitSect");
  const limitListEl = ref(root, "limitList");
  const beginBtn = ref(root, "begin") as HTMLButtonElement;
  const beginNoteEl = ref(root, "beginNote");
  const slotsSurface = ref(root, "slotsSurface");
  const slotsWell = ref(root, "slotsWell");
  const slotsNameEl = ref(root, "slotsName");
  const activeSlotEl = ref(root, "activeSlot");
  const slotCardsEl = ref(root, "slotCards");
  const optStatEl = ref(root, "optStat");
  const optListEl = ref(root, "optList");
  const optEmptyEl = ref(root, "optEmpty");
  const statBoxEl = ref(root, "statBox");
  const assembleBtn = ref(root, "assemble") as HTMLButtonElement;
  const assembleNoteEl = ref(root, "assembleNote");
  const cancelFreeBtn = ref(root, "cancelFree") as HTMLButtonElement;
  const finishSurface = ref(root, "finishSurface");
  const finishWell = ref(root, "finishWell");
  const settleEl = ref(root, "settle");
  const qualityEl = ref(root, "quality");
  const pipsEl = ref(root, "pips");
  const pointsEl = ref(root, "points");
  const linesEl = ref(root, "lines");
  const weaponPreviewEl = ref(root, "weaponPreview");
  const exitExperimentBtn = ref(root, "exitExperiment") as HTMLButtonElement;
  const tuneNoteEl = ref(root, "tuneNote");
  const toFinishBtn = ref(root, "toFinish") as HTMLButtonElement;
  const finishFormEl = ref(root, "finishForm");
  const nameInput = ref(root, "nameInput") as HTMLInputElement;
  const modeLatches = [
    ref(root, "modePrototype") as HTMLButtonElement,
    ref(root, "modePractice") as HTMLButtonElement,
    ref(root, "modeDraft") as HTMLButtonElement,
  ];
  const draftRowEl = ref(root, "draftRow");
  const usesDownBtn = ref(root, "usesDown") as HTMLButtonElement;
  const usesInput = ref(root, "usesInput") as HTMLInputElement;
  const usesUpBtn = ref(root, "usesUp") as HTMLButtonElement;
  const finishFootEl = ref(root, "finishFoot");
  const backTuneBtn = ref(root, "backTune") as HTMLButtonElement;
  const finishGoBtn = ref(root, "finishGo") as HTMLButtonElement;
  const abandonBtn = ref(root, "abandon") as HTMLButtonElement;
  const abandonNoteEl = ref(root, "abandonNote");
  const toastEl = ref(root, "toast");
  const toastMainEl = ref(root, "toastMain");
  const toastSubEl = ref(root, "toastSub");
  const statusEl = ref(root, "status");
  const sessionTagEl = ref(root, "sessionTag");

  // ── Local UI state ───────────────────────────────────────────────────────
  let disposed = false;
  let appliedVersion = -1;
  let uiDirty = true;
  let categoryFilter: CraftCategoryFilter = "all";
  let selectedRecipeId: string | null = null;
  let searchQuery = "";
  let showIneligible = false;
  let selectedSlotIndex = 0;
  let pending: PendingSpend = new Map<number, number>();
  let hoveredOptionKey: string | null = null;
  let finishMode: FinishMode = "prototype";
  let assembledView: AssembledView = "tune";
  let armedAbandonAt = 0;
  let statusFlashTimer = 0;
  let prevPhase: Phase | null = null;
  let prevSessionRecipe: string | null = null;
  /** Which exit we asked for — names the completion toast when VM closes. */
  let lastExit: "prototype" | "practice" | "draft" | "abandon" | "cancel" | null = null;
  /** Assembly settle clock: 0 = idle, else start ms (reduced-motion: never set). */
  let settleShownAt = 0;
  let toastTimer = 0;
  /** Name sent with the last CraftFinalizePrototype — echoed in the toast. */
  let lastRequestedName = "";

  const receiptWatcher = createCraftReceiptWatcher(state);
  const receiptScratch: CraftReceipt[] = [];
  const inventoryScratch = createCollectedItemsScratch();
  const reducedMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const flash = (message: string, ok: boolean): void => {
    window.clearTimeout(statusFlashTimer);
    statusEl.textContent = message;
    statusEl.toggleAttribute("data-flash", true);
    statusEl.toggleAttribute("data-bad", !ok);
    statusFlashTimer = window.setTimeout(() => {
      statusEl.toggleAttribute("data-flash", false);
    }, STATUS_FLASH_MS);
  };

  /** Queue receipt: tick on queued, deny tone + flash on a dead link. */
  const queueFeedback = (queued: boolean): boolean => {
    if (queued) {
      deps.sfx?.play("ui_button_tick");
    } else {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flash(`${CRAFT_COPY.deny} · NO LINK`, false);
    }
    return queued;
  };

  /**
   * Completion toast — the calm exit beat that replaced the grade stamp.
   * Reduced motion: same text, no settle animation (CSS gates it).
   */
  const showToast = (main: string, sub: string): void => {
    window.clearTimeout(toastTimer);
    toastMainEl.textContent = main;
    toastSubEl.textContent = sub;
    toastEl.hidden = false;
    toastEl.toggleAttribute("data-show", true);
    toastTimer = window.setTimeout(() => {
      toastEl.toggleAttribute("data-show", false);
      toastEl.hidden = true;
    }, TOAST_MS);
  };

  // ⓘ buttons: hover/focus shows the title tooltip; activation echoes the
  // same explainer to the status line (keyboard / gamepad parity).
  root.addEventListener("click", (event) => {
    const info = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".scp-craft-info") : null;
    if (!info?.title) return;
    event.stopPropagation();
    flash(info.title, true);
  });

  // ── 3D preview (shared turntable, one active well per phase) ─────────────
  const modelRenderer = InventoryModelRenderer.create(canvasLayer, { state, paperDoll: false });
  const doll: PaperDollVM = { body: "male", equipmentIds: [], weaponId: null };
  const previewVm: InventoryViewModel = { open: true, items: [], selectedKey: null, hoveredKey: null, doll };
  const slotsMap = new Map<string, DOMRectReadOnly>();
  const rects: InventoryLayoutRects = { slots: slotsMap, doll: null, gridClip: null };
  let publishedPreviewKey = "";
  /** The well the rect was computed against — phases share item keys. */
  let publishedWell: HTMLElement | null = null;
  let publishedCanvasW = 0;
  let publishedCanvasH = 0;

  const previewItemFor = (itemId: number, variantId: number, label: string): InventoryItemVM => {
    const row: InventoryRow = {
      container: "craft-preview",
      item: label,
      itemId,
      variantId,
      quantity: 1,
      reserved: 0,
      available: 1,
    };
    return {
      key: `craft-preview:${itemId}:${variantId}`,
      itemId,
      label,
      description: "",
      category: craftPreviewCategoryForItemId(itemId),
      count: 1,
      equipped: false,
      glb: modelPathForItemId(itemId),
      local: false,
      equipmentId: null,
      resource: null,
      row,
    };
  };

  const publishPreview = (well: HTMLElement, item: InventoryItemVM): void => {
    const canvas = modelRenderer.canvas;
    const layerRect = canvasLayer.getBoundingClientRect();
    const wellRect = well.getBoundingClientRect();
    let scaleX: number;
    let scaleY: number;
    if (canvas.width > 0 && layerRect.width > 0) {
      scaleX = canvas.width / layerRect.width;
      scaleY = canvas.height / layerRect.height;
    } else {
      const dpr = window.devicePixelRatio || 1;
      scaleX = dpr;
      scaleY = dpr;
    }
    const inset = 4;
    slotsMap.clear();
    slotsMap.set(item.key, new DOMRect(
      (wellRect.left - layerRect.left + inset) * scaleX,
      (wellRect.top - layerRect.top + inset) * scaleY,
      Math.max(1, (wellRect.width - inset * 2) * scaleX),
      Math.max(1, (wellRect.height - inset * 2) * scaleY),
    ));
    rects.doll = null;
    modelRenderer.setLayoutRects(rects);
    publishedPreviewKey = item.key;
    publishedWell = well;
    publishedCanvasW = canvas.width;
    publishedCanvasH = canvas.height;
  };

  const renderPreview = (dtSeconds: number, timeMs: number): void => {
    const phase = currentPhase();
    const session = craftSession();
    let well: HTMLElement | null = null;
    let item: InventoryItemVM | null = null;
    if (phase === "browser") {
      const summary = selectedRecipe();
      if (summary) {
        well = browserWell;
        item = previewItemFor(summary.outputItemId, summary.outputPreviewVariantId, summary.name);
      }
    } else if (session) {
      const summary = recipeById(session.recipeId);
      const outputItemId = summary?.outputItemId ?? craftRecipeDetail(session.recipeId)?.outputItemId ?? 0;
      const label = summary?.name ?? session.recipeId;
      if (phase === "slots") {
        well = slotsWell;
        item = previewItemFor(outputItemId, summary?.outputPreviewVariantId ?? 0, label);
      } else if (session.assembled) {
        well = finishWell;
        item = previewItemFor(outputItemId, session.assembled.outputPreviewVariantId, label);
      }
    }
    if (!well || !item) {
      previewVm.open = false;
      modelRenderer.render(previewVm, dtSeconds, timeMs);
      return;
    }
    const canvas = modelRenderer.canvas;
    if (
      publishedPreviewKey !== item.key
      || publishedWell !== well
      || canvas.width !== publishedCanvasW
      || canvas.height !== publishedCanvasH
    ) {
      previewVm.items = [item];
      publishPreview(well, item);
    } else {
      previewVm.items[0] = item;
    }
    previewVm.open = true;
    modelRenderer.render(previewVm, dtSeconds, timeMs);
  };

  // ── Data helpers ─────────────────────────────────────────────────────────
  const recipeById = (recipeId: string): CraftRecipeSummaryVM | null => (
    craftRecipes().find((candidate) => candidate.recipeId === recipeId) ?? null
  );

  const selectedRecipe = (): CraftRecipeSummaryVM | null => {
    if (selectedRecipeId) {
      const summary = recipeById(selectedRecipeId);
      if (summary) return summary;
    }
    return null;
  };

  const toolCarriedFor = (summary: CraftRecipeSummaryVM): boolean => {
    const items = collectInventoryItems(
      state,
      (row) => row.itemId === summary.requiredToolItemId && isLocalInventoryContainer(state, row.container),
      inventoryScratch,
    );
    return items.length > 0;
  };

  /**
   * Carried quantity for one recipe requirement, summed over the player's
   * local authoritative containers. Exact item id wins when the spec names
   * one; family requirements fall back to the resource taxonomy path.
   */
  const ownedQtyForSlot = (spec: CraftSlotSpecVM): number => {
    const family = spec.requiredFamily?.trim().toLowerCase() ?? null;
    const matches = (row: InventoryRow): boolean => {
      if (!isLocalInventoryContainer(state, row.container)) return false;
      if (spec.requiredItemId !== null && spec.requiredItemId !== undefined) {
        return row.itemId === spec.requiredItemId;
      }
      if (!family) return false;
      const path = resourceTaxonomyForItemId(row.itemId)?.taxonomyPath;
      return path !== undefined && path.some((part) => part.toLowerCase() === family);
    };
    let total = 0;
    for (const item of collectInventoryItems(state, matches, inventoryScratch)) {
      total += Math.max(0, item.row.available);
    }
    return total;
  };

  const currentPhase = (): Phase => {
    const session = craftSession();
    if (!session) return "browser";
    return session.phase === "assembled" ? "finish" : "slots";
  };

  // ── Phase rail ───────────────────────────────────────────────────────────
  const railSteps: HTMLElement[] = [];
  for (const [index, label] of CRAFT_COPY.phases.entries()) {
    const step = document.createElement("span");
    step.className = "scp-craft-rail-step";
    step.dataset.step = String(index);
    step.textContent = label;
    railEl.appendChild(step);
    railSteps.push(step);
    if (index < CRAFT_COPY.phases.length - 1) {
      const tick = document.createElement("i");
      tick.className = "scp-craft-rail-tick";
      tick.setAttribute("aria-hidden", "true");
      railEl.appendChild(tick);
    }
  }

  /**
   * Five honest steps. LOAD hands off to ASSEMBLE the moment every well is
   * seated (the armed button IS the step); the assembled phase splits into
   * TUNE and FINISH on the local sub-view.
   */
  const applyRail = (phase: Phase, canAssembleNow: boolean, view: AssembledView): void => {
    const active = phase === "browser"
      ? 0
      : phase === "slots"
        ? (canAssembleNow ? 2 : 1)
        : view === "tune" ? 3 : 4;
    for (const [index, step] of railSteps.entries()) {
      step.toggleAttribute("data-active", index === active);
      step.toggleAttribute("data-done", index < active);
    }
  };

  // ── Category tabs ────────────────────────────────────────────────────────
  for (const [id, label] of CATEGORY_TABS) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "scp-tab";
    tab.dataset.cat = id;
    tab.setAttribute("role", "tab");
    tab.textContent = label;
    catsEl.appendChild(tab);
  }
  catsEl.addEventListener("click", (event) => {
    const tab = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".scp-tab") : null;
    const cat = tab?.dataset.cat as CraftCategoryFilter | undefined;
    if (!cat || cat === categoryFilter) return;
    categoryFilter = cat;
    uiDirty = true;
  });

  recipeSearchEl.addEventListener("input", () => {
    if (recipeSearchEl.value === searchQuery) return;
    searchQuery = recipeSearchEl.value;
    uiDirty = true;
  });
  showIneligibleBtn.addEventListener("click", () => {
    showIneligible = !showIneligible;
    showIneligibleBtn.setAttribute("aria-pressed", showIneligible ? "true" : "false");
    showIneligibleBtn.textContent = showIneligible
      ? CRAFT_COPY.browser.hideIneligible
      : CRAFT_COPY.browser.showIneligible;
    uiDirty = true;
  });

  // ── Browser interactions ─────────────────────────────────────────────────
  const beginSelected = (): void => {
    const summary = selectedRecipe();
    if (!summary || beginBtn.disabled) return;
    if (queueFeedback(deps.commands.begin(summary.recipeId))) {
      flash(`${summary.name.toUpperCase()} · ON THE BENCH`, true);
    }
  };

  recipeListEl.addEventListener("click", (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-craft-recipe") : null;
    const id = row?.dataset.recipeId;
    if (!id || id === selectedRecipeId) return;
    selectedRecipeId = id;
    uiDirty = true;
  });
  recipeListEl.addEventListener("dblclick", (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-craft-recipe") : null;
    if (!row?.dataset.recipeId) return;
    selectedRecipeId = row.dataset.recipeId;
    uiDirty = true;
    renderAll();
    beginSelected();
  });
  beginBtn.addEventListener("click", beginSelected);

  // ── Slot screen interactions ─────────────────────────────────────────────
  const assignOption = (slotIndex: number, option: Pick<OptionRow, "container" | "stackId" | "variantId" | "shortStack" | "name">): void => {
    if (option.shortStack) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flash(`${CRAFT_COPY.deny} · ${craftReasonLine("craftslotquantity")}`, false);
      return;
    }
    if (queueFeedback(deps.commands.assignSlot(slotIndex, option.container, option.stackId, option.variantId))) {
      flash(`${option.name.toUpperCase()} · LOADED`, true);
    }
  };

  slotCardsEl.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest<HTMLElement>(".scp-craft-slotcard");
    if (!card) return;
    const slotIndex = Number(card.dataset.slotIndex ?? "0");
    if (target?.closest("[data-clear]")) {
      queueFeedback(deps.commands.clearSlot(slotIndex));
      return;
    }
    if (slotIndex !== selectedSlotIndex) {
      selectedSlotIndex = slotIndex;
      hoveredOptionKey = null;
      uiDirty = true;
    }
  });
  slotCardsEl.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes(CRAFT_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });
  slotCardsEl.addEventListener("drop", (event) => {
    const raw = event.dataTransfer?.getData(CRAFT_DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-craft-slotcard") : null;
    if (!card) return;
    try {
      const payload = JSON.parse(raw) as { container: string; stackId: string; variantId: number; shortStack: boolean; name: string };
      assignOption(Number(card.dataset.slotIndex ?? "0"), payload);
    } catch {
      // malformed foreign payload — ignore
    }
  });
  // Keyboard slot selection rides the native seat <button> — its synthetic
  // click on Enter/Space lands in the click handler above; no extra keydown
  // path, no nested interactive controls.

  // Single-click LOAD is the primary assign path; double-click and drag stay
  // as shortcuts for players who already learned them.
  optListEl.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>(".scp-craft-opt");
    if (!row) return;
    if (row.dataset.key && row.dataset.key !== hoveredOptionKey) {
      // Plain row click pins the 12-stat readout to that stack.
      hoveredOptionKey = row.dataset.key;
      uiDirty = true;
    }
    if (target?.closest("[data-load]")) assignOption(selectedSlotIndex, optionPayloadOf(row));
  });
  optListEl.addEventListener("dblclick", (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-craft-opt") : null;
    if (!row) return;
    assignOption(selectedSlotIndex, optionPayloadOf(row));
  });
  optListEl.addEventListener("dragstart", (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-craft-opt") : null;
    if (!row || !event.dataTransfer) return;
    event.dataTransfer.setData(CRAFT_DRAG_MIME, JSON.stringify(optionPayloadOf(row)));
    event.dataTransfer.effectAllowed = "move";
  });
  optListEl.addEventListener("pointerover", (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-craft-opt") : null;
    if (!row || row.dataset.key === hoveredOptionKey) return;
    hoveredOptionKey = row.dataset.key ?? null;
    uiDirty = true;
  });

  assembleBtn.addEventListener("click", () => {
    if (assembleBtn.disabled) return;
    queueFeedback(deps.commands.assemble());
  });
  cancelFreeBtn.addEventListener("click", () => {
    lastExit = "cancel";
    queueFeedback(deps.commands.cancel());
  });

  // ── TUNE / FINISH interactions ───────────────────────────────────────────
  linesEl.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-spend]") : null;
    if (!button) return;
    const session = craftSession();
    if (!session?.assembled) return;
    const line = button.closest<HTMLElement>(".scp-craft-line");
    const lineId = Number(line?.dataset.lineId ?? "-1");
    const delta = button.dataset.spend === "+" ? 1 : -1;
    const next = adjustPendingSpend(pending, session.assembled, lineId, delta);
    if (next === pending) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      return;
    }
    deps.sfx?.play("ui_button_tick");
    pending = next;
    uiDirty = true;
  });

  exitExperimentBtn.addEventListener("click", () => {
    if (exitExperimentBtn.disabled) return;
    const spends = [...pending.entries()].filter(([, points]) => points > 0);
    if (spends.length === 0) return;
    let queuedAll = true;
    for (const [lineId, points] of spends) {
      queuedAll = deps.commands.experiment(lineId, points) && queuedAll;
    }
    queueFeedback(queuedAll);
    if (queuedAll) {
      pending = new Map<number, number>();
      uiDirty = true;
    }
  });
  toFinishBtn.addEventListener("click", () => {
    if (assembledView === "finish") return;
    assembledView = "finish";
    deps.sfx?.play("ui_button_tick");
    uiDirty = true;
  });
  backTuneBtn.addEventListener("click", () => {
    if (assembledView === "tune") return;
    assembledView = "tune";
    deps.sfx?.play("ui_button_tick");
    uiDirty = true;
  });

  const setFinishMode = (mode: FinishMode): void => {
    if (mode === finishMode) return;
    finishMode = mode;
    if (mode === "draft" && usesInput.value.trim().length === 0) usesInput.value = "10";
    deps.sfx?.play("ui_button_tick");
    uiDirty = true;
  };
  for (const latch of modeLatches) {
    latch.addEventListener("click", () => {
      setFinishMode(latch.dataset.mode as FinishMode);
    });
  }

  /** ONE primary press — routes on the latched mode (owner exits intact). */
  const commitFinish = (): void => {
    if (finishMode === "prototype") {
      lastExit = "prototype";
      lastRequestedName = nameInput.value.trim();
      queueFeedback(deps.commands.finalizePrototype(lastRequestedName));
      return;
    }
    if (finishMode === "practice") {
      lastExit = "practice";
      queueFeedback(deps.commands.finalizePractice());
      return;
    }
    const uses = clampDraftUses(Number(usesInput.value));
    usesInput.value = String(uses);
    lastExit = "draft";
    queueFeedback(deps.commands.draftSchematic(uses));
  };
  finishGoBtn.addEventListener("click", commitFinish);

  usesDownBtn.addEventListener("click", () => {
    usesInput.value = String(clampDraftUses(Number(usesInput.value) - 1));
  });
  usesUpBtn.addEventListener("click", () => {
    usesInput.value = String(clampDraftUses(Number(usesInput.value) + 1));
  });
  const blurOnEscape = (input: HTMLInputElement) => (event: KeyboardEvent): void => {
    if (event.code === "Enter") {
      event.preventDefault();
      commitFinish();
      return;
    }
    if (event.code !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    input.blur();
  };
  usesInput.addEventListener("keydown", blurOnEscape(usesInput));
  nameInput.addEventListener("keydown", blurOnEscape(nameInput));

  abandonBtn.addEventListener("click", () => {
    const now = performance.now();
    if (armedAbandonAt === 0 || now - armedAbandonAt > ABANDON_ARM_MS) {
      armedAbandonAt = now;
      deps.sfx?.play(successorAudioIds.uiDeny);
      flash(CRAFT_COPY.finish.abandonArm, false);
      uiDirty = true;
      return;
    }
    armedAbandonAt = 0;
    lastExit = "abandon";
    queueFeedback(deps.commands.cancel());
    uiDirty = true;
  });

  // ── Renderers (structural reconcile) ─────────────────────────────────────
  // The store can emit several times per authority command (session + detail
  // + drafts land as separate ingests). Rebuilding interactive rows on every
  // version bump detaches a button between pointerdown and pointerup, which
  // swallows the click. Each surface therefore rebuilds its row skeletons
  // ONLY when structural identity changes (row set / order / lock state) and
  // mutates text, disabled, selected, and pending state on the live nodes.
  let browserKey = "";
  let recipeStructKey = "";
  const renderBrowser = (): void => {
    const recipes = craftRecipes();
    // Groups render the authority stream verbatim (category → profession →
    // tier → skill box → id) — headers land where the progression changes.
    // Resolve selection BEFORE keying: the first paint auto-selects the
    // first unlocked row, and the ledger must follow in the same frame.
    const groups = composeBrowserGroups(recipes, categoryFilter, searchQuery, showIneligible);
    const rows = groups.flatMap((group) => group.rows);
    if (rows.length === 0) {
      selectedRecipeId = null;
    } else if (!rows.some((row) => row.recipeId === selectedRecipeId)) {
      const firstUnlocked = rows.find((row) => row.unlocked) ?? rows[0]!;
      selectedRecipeId = firstUnlocked.recipeId;
    }
    const summary = selectedRecipe();
    const toolCarried = summary ? toolCarriedFor(summary) : false;
    const detail = summary ? craftRecipeDetail(summary.recipeId) : null;
    // Owned counts live in the inventory channel, not the craft store — the
    // key must carry them or a loot pickup wouldn't refresh READY/MISSING.
    const ownedSig = detail ? detail.slots.map((slot) => ownedQtyForSlot(slot)).join(",") : "";
    const key = [
      categoryFilter,
      searchQuery,
      showIneligible ? "ineligible" : "eligible",
      selectedRecipeId ?? "-",
      toolCarried ? "t" : "b",
      ownedSig,
      craftStoreVersion(),
      recipes.length,
    ].join("|");
    if (key === browserKey) return;
    browserKey = key;

    for (const tab of catsEl.querySelectorAll<HTMLButtonElement>(".scp-tab")) {
      tab.setAttribute("aria-selected", tab.dataset.cat === categoryFilter ? "true" : "false");
    }

    recipeEmptyEl.hidden = rows.length > 0;
    // Honest empties: no recipes at all vs. a filter that matched nothing.
    const searchEmpty = rows.length === 0 && recipes.length > 0 && searchQuery.trim().length > 0;
    const eligibleEmpty = rows.length === 0 && recipes.length > 0 && !showIneligible;
    recipeEmptyTextEl.textContent = searchEmpty
      ? CRAFT_COPY.browser.searchEmpty
      : eligibleEmpty
        ? CRAFT_COPY.browser.eligibleEmpty
        : CRAFT_COPY.browser.empty;
    recipeEmptyHintEl.textContent = searchEmpty
      ? CRAFT_COPY.browser.searchEmptyHint
      : eligibleEmpty
        ? CRAFT_COPY.browser.eligibleEmptyHint
        : CRAFT_COPY.browser.emptyHint;
    // Skeletons (group headers + rows) rebuild only when the grouped SET
    // changes; selection and label churn update in place so a live emission
    // never replaces the recipe button under the player's pointer.
    const structKey = `${categoryFilter}::${searchQuery}::${showIneligible ? "all" : "eligible"}::${groups
      .map((group) => `${group.key}[${group.rows.map((row) => `${row.recipeId}${row.unlocked ? "" : "!"}`).join(",")}]`)
      .join(";")}`;
    if (structKey !== recipeStructKey) {
      recipeStructKey = structKey;
      recipeListEl.textContent = "";
      for (const group of groups) {
        const head = document.createElement("div");
        head.className = "scp-craft-group";
        head.toggleAttribute("data-locked", group.unlockedCount === 0);
        head.toggleAttribute("data-next", group.nextUp);
        const title = document.createElement("b");
        title.textContent = `${group.professionLabel} · ${group.progressionLabel}`;
        const meta = document.createElement("span");
        meta.textContent = group.nextUp
          ? `${CRAFT_COPY.browser.nextUp} · ${group.categoryLabel}`
          : `${CRAFT_COPY.browser.groupKnown(group.unlockedCount, group.rows.length)} · ${group.categoryLabel}`;
        head.append(title, meta);
        recipeListEl.appendChild(head);
        for (const row of group.rows) {
          const el = document.createElement("button");
          el.type = "button";
          el.className = "scp-craft-recipe";
          el.dataset.recipeId = row.recipeId;
          el.toggleAttribute("data-locked", !row.unlocked);
          const name = document.createElement("strong");
          const rowMeta = document.createElement("span");
          rowMeta.className = "scp-craft-recipe-meta";
          el.append(name, rowMeta);
          if (!row.unlocked) {
            const lock = document.createElement("span");
            lock.className = "scp-craft-lock";
            lock.setAttribute("aria-hidden", "true");
            lock.innerHTML = UI_ICONS.lock;
            el.appendChild(lock);
          }
          recipeListEl.appendChild(el);
        }
      }
    }
    const rowEls = new Map(
      [...recipeListEl.querySelectorAll<HTMLElement>(".scp-craft-recipe")]
        .map((el) => [el.dataset.recipeId ?? "", el] as const),
    );
    for (const row of rows) {
      const el = rowEls.get(row.recipeId);
      if (!el) continue;
      el.toggleAttribute("data-selected", row.recipeId === selectedRecipeId);
      // Full noun on hover — long schematic names ("Crafted Slugthrower Mk I")
      // ellipsize in the row band (fe-polish §1.19). Lock notes outrank it.
      const title = row.lockedNote ?? row.name;
      if (el.title !== title) el.title = title;
      const nameEl = el.children[0] as HTMLElement;
      if (nameEl.textContent !== row.name) nameEl.textContent = row.name;
      const metaText = [
        row.categoryLabel,
        row.remainingLine ? row.remainingLine.toUpperCase() : row.sourceLabel,
      ].join(" · ");
      const metaEl = el.children[1] as HTMLElement;
      if (metaEl.textContent !== metaText) metaEl.textContent = metaText;
    }

    ledgerEl.hidden = summary === null;
    // With NO recipes at all the list's empty state owns the surface — a
    // "select a recipe" prompt beside it would name an impossible action.
    ledgerIdleEl.hidden = summary !== null || rows.length === 0;
    if (!summary) return;
    const ledger = composeRecipeLedger(summary, detail, { toolCarried, ownedQtyOf: ownedQtyForSlot });
    ledgerNameEl.textContent = ledger.name;
    ledgerMetaEl.textContent = ledger.metaLine;
    ledgerDescEl.textContent = ledger.description;
    // Materials/limits ride the recipe DETAIL, which streams with a session
    // — before then the headers would caption nothing. Hide, don't tease.
    reqSectEl.hidden = ledger.requirements.length === 0;
    limitSectEl.hidden = ledger.limits.length === 0;
    reqListEl.textContent = "";
    for (const req of ledger.requirements) {
      const rowEl = document.createElement("div");
      rowEl.className = "scp-craft-req";
      rowEl.innerHTML = `
        <span class="scp-craft-req-symbol" aria-hidden="true"></span>
        <span class="scp-craft-req-text">
          <span class="scp-craft-req-kind"></span>
          <small class="scp-craft-req-material"></small>
        </span>
        <span class="scp-craft-req-stat"></span>
        <span class="scp-craft-req-have">
          <b class="scp-craft-req-state"></b>
          <small class="scp-craft-req-owned"></small>
        </span>
        <span class="scp-craft-req-qty"></span>
      `;
      const reqSymbolEl = rowEl.children[0] as HTMLElement;
      // Real vector always: mapped purpose glyph, else the generic stock
      // silhouette — never a raw server token as pseudo-icon.
      reqSymbolEl.innerHTML = craftSlotIconOrGenericSvg(req.symbol);
      const textEl = rowEl.children[1] as HTMLElement;
      (textEl.children[0] as HTMLElement).textContent = req.kindLabel;
      (textEl.children[1] as HTMLElement).textContent = req.materialLine ?? "";
      (textEl.children[1] as HTMLElement).hidden = req.materialLine === null;
      (rowEl.children[2] as HTMLElement).textContent = req.statLabel;
      const haveEl = rowEl.children[3] as HTMLElement;
      haveEl.hidden = req.stateLabel === null;
      if (req.stateLabel !== null) {
        rowEl.toggleAttribute("data-ready", req.ready === true);
        rowEl.toggleAttribute("data-missing", req.ready === false);
        (haveEl.children[0] as HTMLElement).textContent = req.stateLabel;
        (haveEl.children[1] as HTMLElement).textContent = req.carriedLine ?? "";
      }
      (rowEl.children[4] as HTMLElement).textContent = req.materialLine ? "" : req.qtyText;
      reqListEl.appendChild(rowEl);
    }
    limitListEl.textContent = "";
    for (const limit of ledger.limits) {
      const rowEl = document.createElement("div");
      rowEl.className = "inv-stat-row";
      rowEl.innerHTML = `
        <span class="inv-stat-label"></span>
        <span class="inv-stat-meter" aria-hidden="true"><span class="inv-stat-fill"></span></span>
        <span class="inv-stat-value"></span>
      `;
      (rowEl.children[0] as HTMLElement).textContent = limit.label;
      ((rowEl.children[1] as HTMLElement).firstElementChild as HTMLElement).style.width = `${limit.meterPct}%`;
      (rowEl.children[2] as HTMLElement).textContent = limit.capText;
      limitListEl.appendChild(rowEl);
    }
    beginBtn.disabled = !ledger.canBegin;
    beginNoteEl.textContent = ledger.beginNote ?? "";
    beginNoteEl.toggleAttribute("data-warn", ledger.beginNote !== null && ledger.canBegin);
  };

  let slotsKey = "";
  let slotCardsStructKey = "";
  let optionsStructKey = "";
  const renderSlots = (session: CraftSessionVM): void => {
    const screen = session.slotScreen;
    if (!screen) return;
    const key = [craftStoreVersion(), selectedSlotIndex, hoveredOptionKey ?? "-"].join("|");
    if (key === slotsKey) return;
    slotsKey = key;
    const summary = recipeById(session.recipeId);
    slotsNameEl.textContent = summary?.name ?? session.recipeId;
    activeSlotEl.textContent = "";

    const model = composeSlotScreen(screen, selectedSlotIndex);
    // Slot cards: skeleton rebuild only when the slot set changes; the
    // fill/selection state mutates on the live cards so the CLEAR button
    // and the focused seat survive live emissions. The card wrapper is
    // NON-interactive: the selection radio is its own seat <button>, CLEAR
    // is a sibling — no interactive control nests inside another.
    const cardsStructKey = model.cards.map((card) => `${card.slotIndex}:${card.symbol}`).join("|");
    if (cardsStructKey !== slotCardsStructKey) {
      slotCardsStructKey = cardsStructKey;
      slotCardsEl.textContent = "";
      for (const card of model.cards) {
        const el = document.createElement("div");
        el.className = "scp-craft-slotcard";
        el.dataset.slotIndex = String(card.slotIndex);
        el.innerHTML = `
          <button type="button" class="scp-craft-slot-seat" role="radio">
            <span class="scp-craft-slot-symbol" aria-hidden="true"></span>
            <span class="scp-craft-slot-main">
              <strong></strong>
              <small class="scp-craft-slot-material"></small>
              <span></span>
            </span>
            <span class="scp-craft-slot-qty"></span>
          </button>
          <button type="button" class="scp-craft-btn scp-craft-slot-clear" data-clear hidden>${CRAFT_COPY.slots.clear}</button>
        `;
        // Fill-slot PURPOSE glyph (casing/conductor/…): purpose-icon set;
        // unmapped vocabulary fails closed to the generic stock vector.
        const symbolEl = el.querySelector<HTMLElement>(".scp-craft-slot-symbol")!;
        symbolEl.innerHTML = craftSlotIconOrGenericSvg(card.symbol);
        slotCardsEl.appendChild(el);
      }
    }
    for (const [index, card] of model.cards.entries()) {
      const el = slotCardsEl.children[index] as HTMLElement;
      const seat = el.children[0] as HTMLButtonElement;
      seat.setAttribute("aria-checked", card.selected ? "true" : "false");
      seat.setAttribute(
        "aria-label",
        `${card.kindLabel} slot${card.filled ? ", loaded" : ", empty"}${card.selected ? ", selected" : ""}`,
      );
      el.toggleAttribute("data-selected", card.selected);
      el.toggleAttribute("data-filled", card.filled);
      (seat.children[0] as HTMLElement).title = card.kindLabel;
      const main = seat.children[1] as HTMLElement;
      (main.children[0] as HTMLElement).textContent = card.kindLabel;
      (main.children[1] as HTMLElement).textContent = card.materialLine ?? "";
      (main.children[1] as HTMLElement).hidden = card.materialLine === null;
      (main.children[2] as HTMLElement).textContent = card.assignedLine ?? "EMPTY";
      (main.children[2] as HTMLElement).toggleAttribute("data-empty", card.assignedLine === null);
      (seat.children[2] as HTMLElement).textContent = card.materialLine ? "" : card.qtyText;
      (el.children[1] as HTMLElement).hidden = !card.filled;
    }

    optStatEl.textContent = model.optionStatLabel;
    if (model.activeSlotLine) activeSlotEl.textContent = model.activeSlotLine;
    optEmptyEl.hidden = model.options.length > 0;
    // Option rows: keyed by the stable stack key per selected slot. A live
    // emission that only flips assigned/qty state mutates the existing rows
    // — the LOAD button the player is pressing is never detached.
    const optStructKey = `${selectedSlotIndex}::${model.options.map((option) => option.key).join("|")}`;
    if (optStructKey !== optionsStructKey) {
      optionsStructKey = optStructKey;
      optListEl.textContent = "";
      for (const option of model.options) {
        const el = document.createElement("div");
        el.className = "scp-craft-opt";
        el.dataset.key = option.key;
        el.dataset.container = option.container;
        el.dataset.stackId = option.stackId;
        el.dataset.variantId = String(option.variantId);
        el.innerHTML = `
          <div class="scp-craft-opt-main">
            <strong></strong>
            <span class="scp-craft-opt-tags"></span>
            <small class="scp-craft-opt-note" hidden></small>
          </div>
          <span class="inv-stat-meter" aria-hidden="true"><span class="inv-stat-fill"></span></span>
          <span class="scp-craft-opt-value"></span>
          <span class="scp-craft-opt-qty"></span>
          <button type="button" class="scp-craft-btn scp-craft-opt-load" data-load></button>
        `;
        optListEl.appendChild(el);
      }
    }
    let hoverRows: StatHoverRow[] | null = null;
    for (const [index, option] of model.options.entries()) {
      const el = optListEl.children[index] as HTMLElement;
      el.draggable = !option.shortStack;
      el.dataset.name = option.name;
      el.toggleAttribute("data-recommended", option.recommended);
      el.toggleAttribute("data-short", option.shortStack);
      el.toggleAttribute("data-assigned", option.assigned);
      if (option.unavailableNote) el.title = `${CRAFT_COPY.slots.shortStack} — ${option.unavailableNote}`;
      else el.removeAttribute("title");
      const main = el.children[0] as HTMLElement;
      (main.children[0] as HTMLElement).textContent = option.name;
      const tags = main.children[1] as HTMLElement;
      tags.textContent = "";
      if (option.recommended) {
        const best = document.createElement("b");
        best.className = "scp-craft-best";
        best.textContent = CRAFT_COPY.slots.recommended;
        tags.appendChild(best);
      }
      if (option.assigned) {
        const loaded = document.createElement("b");
        loaded.className = "scp-craft-loadedtag";
        loaded.textContent = "LOADED";
        tags.appendChild(loaded);
      }
      const noteEl = main.children[2] as HTMLElement;
      noteEl.textContent = option.unavailableNote ?? "";
      noteEl.hidden = option.unavailableNote === null;
      ((el.children[1] as HTMLElement).firstElementChild as HTMLElement).style.width = `${option.meterPct}%`;
      (el.children[2] as HTMLElement).textContent = String(option.statValue);
      (el.children[3] as HTMLElement).textContent = option.qtyText;
      const loadBtn = el.children[4] as HTMLButtonElement;
      loadBtn.textContent = option.assigned ? CRAFT_COPY.slots.loadedTag : CRAFT_COPY.slots.load;
      loadBtn.disabled = option.shortStack || option.assigned;
      if (option.unavailableNote) loadBtn.title = `${CRAFT_COPY.slots.shortStack} — ${option.unavailableNote}`;
      else loadBtn.removeAttribute("title");
      loadBtn.setAttribute(
        "aria-label",
        option.assigned ? `${option.name} loaded` : `Load ${option.name}`,
      );
      if (option.key === hoveredOptionKey || (hoverRows === null && option.recommended)) {
        hoverRows = option.hover;
      }
    }
    if (hoverRows === null && model.options.length > 0) hoverRows = model.options[0]!.hover;
    statBoxEl.hidden = hoverRows === null;
    statBoxEl.textContent = "";
    if (hoverRows) {
      for (const stat of hoverRows) {
        const rowEl = document.createElement("div");
        rowEl.className = "inv-stat-row scp-craft-statrow";
        rowEl.toggleAttribute("data-relevant", stat.relevant);
        rowEl.innerHTML = `
          <span class="inv-stat-label"></span>
          <span class="inv-stat-meter" aria-hidden="true"><span class="inv-stat-fill"></span></span>
          <span class="inv-stat-value"></span>
        `;
        (rowEl.children[0] as HTMLElement).textContent = stat.label;
        ((rowEl.children[1] as HTMLElement).firstElementChild as HTMLElement).style.width = `${stat.meterPct}%`;
        (rowEl.children[2] as HTMLElement).textContent = String(stat.value);
        statBoxEl.appendChild(rowEl);
      }
    }

    assembleBtn.disabled = !model.canAssemble;
    assembleNoteEl.textContent = model.assembleNote ?? "";
    assembleNoteEl.toggleAttribute("data-warn", model.canAssemble);
  };

  let finishKey = "";
  let finishLinesStructKey = "";
  let pipCount = -1;
  const renderFinish = (session: CraftSessionVM): void => {
    const assembled = session.assembled;
    if (!assembled) return;
    const pendingKey = [...pending.entries()].map(([id, points]) => `${id}:${points}`).join(",");
    const key = [
      craftStoreVersion(),
      pendingKey,
      assembledView,
      finishMode,
      armedAbandonAt > 0 ? "a" : "-",
      settleShownAt > 0 ? "s" : "-",
    ].join("|");
    if (key === finishKey) return;
    finishKey = key;

    const model = composeFinish(assembled, pending);
    finishSurface.dataset.view = assembledView;
    qualityEl.textContent = `${CRAFT_COPY.finish.quality} ${model.qualityText}`;
    settleEl.hidden = settleShownAt === 0;

    // Pool pips — the 7-point grant at a glance; the number is exact truth.
    if (pipCount !== model.poolMax) {
      pipCount = model.poolMax;
      pipsEl.textContent = "";
      for (let index = 0; index < model.poolMax; index += 1) {
        const pip = document.createElement("i");
        pip.className = "scp-craft-pip";
        pipsEl.appendChild(pip);
      }
    }
    for (const [index, pip] of [...pipsEl.children].entries()) {
      pip.toggleAttribute("data-lit", index < model.pointsAfterPending);
      pip.toggleAttribute("data-staged", index >= model.pointsAfterPending && index < model.pointsLeft);
    }
    pointsEl.textContent = model.poolText;

    // Property rails: keyed by lineId — the +/- allocator buttons are the
    // hot interactive path here and must survive both pending re-stages and
    // live experiment-result emissions. Each rail carries the cap PIN and
    // the value CARET (authority milli, never projected client-side) plus
    // the neutral toward-cap badge (milli is normalized goodness).
    const linesStructKey = model.lines.map((line) => line.lineId).join(",");
    if (linesStructKey !== finishLinesStructKey) {
      finishLinesStructKey = linesStructKey;
      linesEl.textContent = "";
      for (const line of model.lines) {
        const el = document.createElement("div");
        el.className = "scp-craft-line";
        el.dataset.lineId = String(line.lineId);
        el.innerHTML = `
          <div class="scp-craft-line-top">
            <span class="scp-craft-line-label"></span>
            <span class="scp-craft-line-dir">${DIR_TO_CAP_SVG}<i>${line.dirLabel}</i></span>
            <span class="scp-craft-line-vals"></span>
          </div>
          <span class="scp-craft-line-bar" aria-hidden="true">
            <i class="scp-craft-line-fill"></i>
            <i class="scp-craft-line-cap"></i>
            <i class="scp-craft-line-caret"></i>
          </span>
          <div class="scp-craft-line-foot">
            <span class="scp-craft-line-chance"></span>
            <span class="scp-craft-line-note"></span>
            <span class="scp-craft-line-spend">
              <button type="button" class="scp-craft-btn scp-craft-step" data-spend="-" aria-label="Unmark point">${MINUS_SVG}</button>
              <b></b>
              <button type="button" class="scp-craft-btn scp-craft-step" data-spend="+" aria-label="Mark point">${PLUS_SVG}</button>
            </span>
          </div>
        `;
        linesEl.appendChild(el);
      }
    }
    for (const [index, line] of model.lines.entries()) {
      const el = linesEl.children[index] as HTMLElement;
      el.toggleAttribute("data-capped", !line.canRaise);
      const top = el.children[0] as HTMLElement;
      (top.children[0] as HTMLElement).textContent = line.label;
      (top.children[2] as HTMLElement).textContent = `${line.valueText} / ${line.capText}`;
      const bar = el.children[1] as HTMLElement;
      (bar.children[0] as HTMLElement).style.width = `${line.valuePct}%`;
      (bar.children[1] as HTMLElement).style.left = `${line.capPct}%`;
      (bar.children[2] as HTMLElement).style.left = `${line.valuePct}%`;
      const foot = el.children[2] as HTMLElement;
      const chanceEl = foot.children[0] as HTMLElement;
      chanceEl.textContent = line.holdChanceText === null
        ? ""
        : `${CRAFT_COPY.tune.hold(line.holdChanceText)} · ${CRAFT_COPY.tune.slip(line.slipChanceText ?? "")}`;
      chanceEl.toggleAttribute("data-staged", line.pendingPoints > 0);
      (foot.children[1] as HTMLElement).textContent = line.noteLine ?? "";
      (foot.children[1] as HTMLElement).toggleAttribute("data-marked", line.pendingPoints > 0);
      const spend = foot.children[2] as HTMLElement;
      (spend.children[1] as HTMLElement).textContent = String(line.pendingPoints);
      (spend.children[0] as HTMLButtonElement).disabled = line.pendingPoints <= 0;
      (spend.children[2] as HTMLButtonElement).disabled = !line.canRaise || model.pointsAfterPending <= 0;
      spend.toggleAttribute("data-inert", !line.canRaise);
    }

    // TUNE view: EXPERIMENT is the primary press while marks are staged;
    // TO FINISH takes over once the player is done pushing.
    const tuneView = assembledView === "tune";
    finishFormEl.hidden = tuneView;
    finishFootEl.hidden = tuneView;
    (exitExperimentBtn.parentElement as HTMLElement).hidden = !tuneView;
    exitExperimentBtn.disabled = !model.canExperiment;
    exitExperimentBtn.classList.toggle("scp-craft-btn--accent", model.canExperiment);
    toFinishBtn.classList.toggle("scp-craft-btn--accent", !model.canExperiment);
    tuneNoteEl.textContent = model.canExperiment
      ? CRAFT_COPY.finish.applyHint
      : CRAFT_COPY.tune.slipWarn;

    // FINISH view: name + mode latches + one primary press.
    for (const latch of modeLatches) {
      latch.setAttribute("aria-checked", latch.dataset.mode === finishMode ? "true" : "false");
    }
    const summary = recipeById(session.recipeId);
    nameInput.placeholder = summary?.name ?? CRAFT_COPY.finish.namePlaceholder;
    draftRowEl.hidden = finishMode !== "draft";
    finishGoBtn.textContent = finishMode === "prototype"
      ? CRAFT_COPY.finish.prototypeGo
      : finishMode === "practice"
        ? CRAFT_COPY.finish.practiceGo
        : CRAFT_COPY.finish.draftGo;
    const finishNoteEl = finishGoBtn.previousElementSibling as HTMLElement;
    finishNoteEl.textContent = finishMode === "prototype"
      ? CRAFT_COPY.finish.prototypeNote
      : finishMode === "practice"
        ? CRAFT_COPY.finish.practiceNote
        : CRAFT_COPY.finish.draftNote;

    abandonBtn.toggleAttribute("data-armed", armedAbandonAt > 0);
    abandonNoteEl.textContent = armedAbandonAt > 0 ? CRAFT_COPY.finish.abandonArm : "";
    // Strictly the slugthrower recipe: variant-id namespaces collide across
    // families (battery 32M ≥ 31M), so the id range is NOT a weapon test.
    const slugthrower = session.recipeId === "slugthrower";
    if (slugthrower) {
      const lineValues: Record<string, number> = {};
      for (const line of assembled.lines) {
        const name = line.label.toLowerCase();
        if (name.includes("power")) lineValues.power = Math.floor(line.valueMilli / 10);
        if (name.includes("handling")) lineValues.handling = Math.floor(line.valueMilli / 10);
        if (name.includes("reliab")) lineValues.reliability = Math.floor(line.valueMilli / 10);
      }
      const preview = deriveSlugthrowerStats(assembled.outputPreviewVariantId, lineValues);
      weaponPreviewEl.textContent = slugthrowerStatRows(
        preview,
        undefined,
        slice.combatTuning?.weaponRangeBands?.slugthrower,
      ).map((row) => `${row.label}: ${row.value}`).join(" · ");
    } else {
      weaponPreviewEl.textContent = "";
    }
  };

  /**
   * Assembly settle — the calm beat that replaced the stamp theater: the
   * true rails are already on screen; one quiet line names what happened.
   * Reduced motion bypasses it entirely.
   */
  const startSettle = (): void => {
    deps.sfx?.play(successorAudioIds.itemTransfer);
    if (reducedMotion) return;
    settleShownAt = performance.now();
    uiDirty = true;
  };

  // ── Receipts → player language ───────────────────────────────────────────
  const handleReceipts = (): void => {
    receiptScratch.length = 0;
    receiptWatcher.poll(receiptScratch);
    for (const receipt of receiptScratch) {
      // A reopened window drains everything since it closed — the VM already
      // told that story. Only fresh receipts may speak (no stale DENIED).
      if (receipt.sentAtMs !== null && performance.now() - receipt.sentAtMs > STALE_RECEIPT_MS) continue;
      if (!receipt.accepted) {
        deps.sfx?.play(successorAudioIds.uiDeny);
        flash(`${CRAFT_COPY.deny} · ${craftReasonLine(receipt.reasonCode)}`, false);
        continue;
      }
      if (receipt.kind === "CraftFinalizePrototype") {
        deps.sfx?.play(successorAudioIds.itemTransfer);
        showToast(
          CRAFT_COPY.finish.prototypeDone,
          lastRequestedName.length > 0 ? `“${lastRequestedName}”` : "",
        );
      } else if (receipt.kind === "CraftFinalizePractice") {
        deps.sfx?.play(successorAudioIds.itemTransfer);
        showToast(CRAFT_COPY.finish.practiceDone, CRAFT_COPY.finish.practiceDoneSub);
      } else if (receipt.kind === "CraftDraftSchematic") {
        deps.sfx?.play(successorAudioIds.itemTransfer);
        showToast(CRAFT_COPY.finish.draftDone, `${clampDraftUses(Number(usesInput.value))} USES`);
      } else if (receipt.kind === "FactoryManufacture") {
        deps.sfx?.play(successorAudioIds.itemTransfer);
        showToast(CRAFT_COPY.drafts.manufactureDone, "");
      } else if (receipt.kind === "CraftCancel") {
        // Any accepted cancel proves the craft channel answered — the
        // browse bootstrap may stop nudging even if the VM came back empty.
        bootstrapSatisfied = true;
        // Bootstrap refreshes (no user exit staged) stay silent — the
        // browse VM that follows is the whole point.
        if (lastExit === "abandon") flash("ABANDONED · MATERIALS FORFEITED", true);
        else if (lastExit === "cancel") flash("CANCELLED · NOTHING SPENT", true);
      }
      if (
        receipt.kind === "CraftCancel"
        || receipt.kind === "CraftFinalizePrototype"
        || receipt.kind === "CraftFinalizePractice"
        || receipt.kind === "CraftDraftSchematic"
      ) {
        lastExit = null;
      }
    }
  };

  /**
   * Browse bootstrap — the session channel only publishes on craft command
   * responses (wire ruling: CraftCancel with no session is an accepted
   * no-op that publishes the browse VM). Nudge on a slow cadence until
   * either craft data streams (recipes/session) or an accepted CraftCancel
   * receipt proves contact (a fresh character's browse VM can be EMPTY —
   * the receipt is the stop signal there). Fixture harnesses load recipes
   * on boot and never reach the send.
   */
  let bootstrapAttemptAt = 0;
  let bootstrapSatisfied = false;
  const bootstrapBrowse = (): void => {
    if (bootstrapSatisfied || craftRecipes().length > 0 || craftSession() !== null) return;
    const now = performance.now();
    if (now - bootstrapAttemptAt < BOOTSTRAP_RETRY_MS) return;
    bootstrapAttemptAt = now;
    deps.commands.cancel();
  };

  // ── Frame update ─────────────────────────────────────────────────────────
  const renderAll = (): void => {
    const phase = currentPhase();
    const session = craftSession();
    browserSurface.hidden = phase !== "browser";
    slotsSurface.hidden = phase !== "slots";
    finishSurface.hidden = phase !== "finish";
    applyRail(phase, session?.slotScreen?.canAssemble === true, assembledView);
    if (phase === "browser") renderBrowser();
    else if (phase === "slots" && session) renderSlots(session);
    else if (phase === "finish" && session) renderFinish(session);
    const summary = session ? recipeById(session.recipeId) : null;
    const tag = session ? `BENCH · ${(summary?.name ?? session.recipeId).toUpperCase()}` : "";
    if (sessionTagEl.textContent !== tag) sessionTagEl.textContent = tag;
  };

  return {
    update(dtSeconds: number, timeMs: number): void {
      // Live channel first: the streamed craftSession/drafts land in the
      // store before anything reads phase (no-op until the root opts in).
      syncCraftChannelFromAuthority(state);
      bootstrapBrowse();
      handleReceipts();

      const phase = currentPhase();
      const session = craftSession();
      if (phase !== prevPhase) {
        if (phase === "finish" && session?.assembled) {
          // Fresh assembly on the bench — reset the local finish staging
          // and land on TUNE with the calm settle line.
          assembledView = "tune";
          finishMode = "prototype";
          nameInput.value = "";
          if (prevPhase === "slots") startSettle();
        }
        if (phase === "browser") {
          // Session closed — local staging dies with it.
          pending = new Map<number, number>();
          assembledView = "tune";
          finishMode = "prototype";
          nameInput.value = "";
          armedAbandonAt = 0;
          lastExit = null;
          slotsKey = "";
          finishKey = "";
        }
        if (phase === "slots" && session?.slotScreen) {
          selectedSlotIndex = nextSlotIndex(session.slotScreen, 0);
          hoveredOptionKey = null;
        }
        prevPhase = phase;
        prevSessionRecipe = session?.recipeId ?? null;
        uiDirty = true;
      } else if (session && session.recipeId !== prevSessionRecipe) {
        prevSessionRecipe = session.recipeId;
        pending = new Map<number, number>();
        uiDirty = true;
      }

      // Server confirmed an assignment — advance to the next open slot.
      if (phase === "slots" && session?.slotScreen) {
        const current = session.slotScreen.slots.find((slot) => slot.slotIndex === selectedSlotIndex);
        if (current && current.assigned !== null) {
          const next = nextSlotIndex(session.slotScreen, selectedSlotIndex);
          if (next !== selectedSlotIndex) {
            selectedSlotIndex = next;
            hoveredOptionKey = null;
            uiDirty = true;
          }
        }
      }

      if (armedAbandonAt > 0 && performance.now() - armedAbandonAt > ABANDON_ARM_MS) {
        armedAbandonAt = 0;
        uiDirty = true;
      }

      if (settleShownAt > 0 && performance.now() - settleShownAt > SETTLE_MS) {
        settleShownAt = 0;
        uiDirty = true;
      }

      const version = craftStoreVersion();
      if (version !== appliedVersion || uiDirty) {
        appliedVersion = version;
        uiDirty = false;
        renderAll();
      }
      renderPreview(dtSeconds, timeMs);
    },
    onResized(): void {
      publishedPreviewKey = "";
      browserKey = "";
      slotsKey = "";
      finishKey = "";
      uiDirty = true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(statusFlashTimer);
      window.clearTimeout(toastTimer);
      modelRenderer.dispose();
      root.remove();
    },
  };
}


function optionPayloadOf(row: HTMLElement): { container: string; stackId: string; variantId: number; shortStack: boolean; name: string } {
  return {
    container: row.dataset.container ?? "",
    stackId: row.dataset.stackId ?? "",
    variantId: Number(row.dataset.variantId ?? "0"),
    shortStack: row.hasAttribute("data-short"),
    name: row.dataset.name ?? "",
  };
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`craft window: missing data-ref="${name}"`);
  return el;
}
