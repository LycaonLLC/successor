import type {
  PlayState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityBankRetrieveItemCommand,
  enqueueAuthorityBankStoreItemCommand,
  enqueueAuthorityTakeLootItemCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import {
  applyInventoryAction,
  buildInventoryViewModel,
  contextActionsFor,
  dispatchInventoryAction,
  isLocalInventoryContainer,
  toolbarItemIdForInventoryItem,
  type InventoryActionId,
} from "./data";
import { DRAG_STACK_KEY, installStackOps } from "./stackOps";
import { LOOT_DRAG_MIME, parseLootDragPayload } from "./lootDrag";
import {
  BANK_DRAG_MIME,
  BANK_LINK_LOST_COPY,
  parseBankDragPayload,
  resolveBankVaultSession,
} from "./bankLink";
import { renderResourceStatRows, resourceInfoForRow } from "./resourceInfo";
import { RESOURCE_GLYPH_BY_ITEM_ID } from "./resourceGlyphs";
import { CREDIT_CHIP_ITEM_ID } from "../trade/types";
import { itemKindIconSvg } from "../iconRegistry";
import { InventoryModelRenderer } from "./modelRenderer";
import type { ContextRadial } from "../windows/contextRadial";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windows/windowManager";
import type {
  InventoryCategory,
  InventoryItemVM,
  InventoryLayoutRects,
  InventoryViewModel,
} from "./types";

/**
 * INVENTORY — window content (hairline HUD-glass skin, theme-driven).
 *
 * Housed in the WindowManager: the manager owns ALL chrome (glass panel,
 * 22px title strip, drag, resize, bounds persistence, focus, close); this
 * module owns only the content — a left slot grid and a right OPERATIVE
 * paper-doll + description ledger. A transparent canvas layer (owned and
 * painted by `InventoryModelRenderer`) is sandwiched between the window glass
 * and this DOM chrome; the model renderer paints rotating item thumbnails
 * into each slot's "well" and the doll into the doll well, using the
 * device-pixel rects this module publishes.
 *
 * Every colour comes from the --sc3d-* custom properties; zero hardcoded
 * colours, so the whole skin re-themes by swapping those variables.
 *
 * Per-frame flow (manager calls `handle.update` only while visible):
 *   buildInventoryViewModel(state) -> reconcile slots/ledger -> renderModels.
 * The VM is a reused object valid only within the frame.
 *
 * Right-click actions go through the shared context radial; EXAMINE routes
 * through the data adapter's action registry to the examine window.
 */

/** Ledger empty state is glyph-quiet (C14) — the footer owns the teaching line. */
const EMPTY_LEDGER = "";
const STATUS_IDLE = "SELECT AN ITEM";
const STATUS_DENIED = "DENIED · NOT AUTHORIZED";
const STATUS_FLASH_MS = 1400;
/** Sentinel that can never be a real `${container}:${itemId}:${variantId}` key. */
const NO_KEY = "\u0000";
const DRAG_ITEM = "text/x-sc3d-item";

export function inventoryEquipFlashStatus(
  label: string,
  local: boolean,
  result: "equipped" | "unequipped",
): string {
  const action = result === "equipped" ? "EQUIP" : "UNEQUIP";
  return `${label} · ${local ? `${action}PED` : `${action} REQUESTED`}`;
}

export const CATEGORY_LABEL: Record<InventoryCategory, string> = {
  ammo: "AMMO",
  medical: "MED",
  resource: "RES",
  tool: "TOOL",
  gear: "GEAR",
  currency: "CR",
  item: "ITM",
  weapon: "WPN",
};

/** Only weapon + gear rows can carry an EQUIP/UNEQUIP action. */
const IS_ACTION_CATEGORY: Record<InventoryCategory, boolean> = {
  ammo: false,
  medical: false,
  resource: false,
  tool: false,
  gear: true,
  currency: false,
  item: false,
  weapon: true,
};

export interface InventoryWindowDeps {
  /** Shared context radial living in the window-manager UI root. */
  radial: ContextRadial;
  /** Shared page SfxPlayer for transfer/deny affordances. */
  sfx?: SfxPlayer;
}

interface SlotNodes {
  slot: HTMLButtonElement;
  well: HTMLElement;
  chip: HTMLElement;
  variant: HTMLElement;
  count: HTMLElement;
  title: HTMLElement;
}

interface SlotApplied {
  category: InventoryCategory | "";
  count: string;
  variant: string;
  title: string;
  tooltip: string;
  equipped: boolean | null;
  hover: boolean | null;
  selected: boolean | null;
}

interface LedgerNodes {
  root: HTMLElement;
  name: HTMLElement;
  cat: HTMLElement;
  variant: HTMLElement;
  count: HTMLElement;
  desc: HTMLElement;
  stats: HTMLElement;
  actionRow: HTMLElement;
  actionBtn: HTMLButtonElement;
  discardBtn: HTMLButtonElement;
}

export function createInventoryWindowDefinition(deps: InventoryWindowDeps): WindowDefinition {
  return {
    id: "inventory",
    title: "INVENTORY",
    icon: "inventory",
    hotkey: "KeyI",
    minWidth: 440,
    minHeight: 420,
    // r3: portrait-first default (owner call 2026-07-03) — taller than wide so
    // the OPERATIVE doll reads as a standing figure, not a squeezed landscape.
    // Strip rides the top lane (§1.30 cascade): the flagship opens FIRST
    // (lowest z), so its grab bar must sit above the later windows' bodies.
    boundsRevision: 3,
    defaultBounds: (viewport) => {
      const w = Math.max(440, Math.min(640, Math.round(viewport.w * 0.38)));
      const h = Math.max(420, Math.round(viewport.h * 0.8));
      return { x: Math.round((viewport.w - w) / 2), y: Math.min(84, Math.round((viewport.h - h) / 2)), w, h };
    },
    mount: (contentRoot, ctx) => mountInventoryContent(contentRoot, ctx, deps),
  };
}

function mountInventoryContent(
  contentRoot: HTMLElement,
  ctx: WindowContext,
  deps: InventoryWindowDeps,
): WindowContentHandle {
  const state: PlayState = ctx.state;
  const slice: SliceSnapshot = ctx.slice;

  // ── DOM skeleton (built once) ────────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "inv-root";
  root.innerHTML = `
    <div class="inv-canvas-layer" data-ref="canvasLayer" aria-hidden="true"></div>
    <div class="inv-chrome">
      <div class="inv-body">
        <section class="inv-grid-col" aria-label="Inventory grid">
          <div class="inv-grid" data-ref="grid" role="grid" tabindex="-1"></div>
        </section>
        <section class="inv-detail-col" aria-label="Character and item ledger">
          <div class="inv-doll-frame" data-ref="dollFrame">
            <div class="inv-doll-well" data-ref="dollWell" aria-hidden="true"></div>
          </div>
          <div class="inv-split" data-ref="dollSplit" role="separator" aria-orientation="horizontal" title="drag to resize"></div>
          <div class="inv-ledger" data-ref="ledger">
            <div class="inv-ledger-head">
              <span class="inv-ledger-name" data-ref="name">\u2014</span>
            </div>
            <div class="inv-ledger-meta">
              <span class="inv-ledger-cat" data-ref="cat"></span>
              <span class="inv-ledger-count" data-ref="count"></span>
              <span class="inv-ledger-variant" data-ref="variant" hidden></span>
            </div>
            <p class="inv-ledger-desc" data-ref="desc">${EMPTY_LEDGER}</p>
            <div class="inv-ledger-stats" data-ref="stats" hidden></div>
            <div class="inv-action" data-ref="actionRow">
              <button class="inv-action-btn" type="button" data-ref="actionBtn" hidden></button>
              <button class="inv-action-btn inv-action-btn--danger" type="button" data-ref="discardBtn" hidden></button>
            </div>
          </div>
        </section>
      </div>
      <footer class="inv-foot">
        <span class="inv-status" data-ref="status">${STATUS_IDLE}</span>
      </footer>
    </div>
  `;
  contentRoot.appendChild(root);

  const canvasLayer = ref(root, "canvasLayer");
  const grid = ref(root, "grid");
  const dollWell = ref(root, "dollWell");
  const status = ref(root, "status");
  const ledger: LedgerNodes = {
    root: ref(root, "ledger"),
    name: ref(root, "name"),
    cat: ref(root, "cat"),
    count: ref(root, "count"),
    desc: ref(root, "desc"),
    variant: ref(root, "variant"),
    stats: ref(root, "stats"),
    actionRow: ref(root, "actionRow"),
    actionBtn: ref(root, "actionBtn") as HTMLButtonElement,
    discardBtn: ref(root, "discardBtn") as HTMLButtonElement,
  };

  // ── 3D model + paper-doll renderer (owns the canvas inside canvasLayer) ──
  const modelRenderer = InventoryModelRenderer.create(canvasLayer, { state, paperDollDragHost: dollWell });
  const inventoryProbeWindow = window as Window & {
    __successor3dInventoryModelAssetKey?: (slotKey: string) => string | null;
  };
  inventoryProbeWindow.__successor3dInventoryModelAssetKey = (slotKey) =>
    modelRenderer.slotModelAssetKey(slotKey);

  // ── OPERATIVE pane splitter: drag to resize the doll vs ledger share ─────
  const dollFrame = ref(root, "dollFrame");
  const dollSplit = ref(root, "dollSplit");
  const detailCol = dollFrame.parentElement as HTMLElement;
  const DOLL_SHARE_KEY = "successor3d.inventory.dollShare.v1";
  let dollShare = 0.62;
  try {
    const raw = window.localStorage.getItem(DOLL_SHARE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(parsed)) dollShare = parsed;
  } catch {
    // storage unavailable — share stays session-local
  }
  const applyDollShare = (): void => {
    dollShare = Math.min(0.82, Math.max(0.28, dollShare));
    detailCol.style.setProperty("--inv-doll-share", `${(dollShare * 100).toFixed(1)}%`);
  };
  applyDollShare();
  let dollDragPointer: number | null = null;
  const onSplitDown = (event: PointerEvent): void => {
    dollDragPointer = event.pointerId;
    dollSplit.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onSplitMove = (event: PointerEvent): void => {
    if (dollDragPointer !== event.pointerId) return;
    const rect = detailCol.getBoundingClientRect();
    if (rect.height <= 0) return;
    dollShare = (event.clientY - rect.top) / rect.height;
    applyDollShare();
    schedulePublish();
    event.preventDefault();
  };
  const onSplitUp = (event: PointerEvent): void => {
    if (dollDragPointer !== event.pointerId) return;
    dollDragPointer = null;
    try {
      window.localStorage.setItem(DOLL_SHARE_KEY, dollShare.toFixed(3));
    } catch {
      // storage unavailable — share stays session-local
    }
  };
  dollSplit.addEventListener("pointerdown", onSplitDown);
  dollSplit.addEventListener("pointermove", onSplitMove);
  dollSplit.addEventListener("pointerup", onSplitUp);
  dollSplit.addEventListener("pointercancel", onSplitUp);

  // ── Content state ────────────────────────────────────────────────────────
  let selectedKey: string | null = null;
  let hoveredKey: string | null = null;
  const uiState: { open: boolean; selectedKey: string | null; hoveredKey: string | null } = {
    open: true,
    selectedKey,
    hoveredKey,
  };

  const slotNodes = new Map<string, SlotNodes>();
  const applied = new Map<string, SlotApplied>();
  const publishedKeys = new Set<string>();
  let renderedFocusKey: string | null = NO_KEY;
  let renderedSpawnKey = NO_KEY;

  const slotsMap = new Map<string, DOMRectReadOnly>();
  const rects: InventoryLayoutRects = { slots: slotsMap, doll: null, gridClip: null };

  let focusedVm: InventoryItemVM | null = null;
  let statusFlashTimer = 0;
  let disposed = false;
  let latestVm: InventoryViewModel | null = null;

  // ── Rect publishing (rAF-coalesced) ──────────────────────────────────────
  let publishScheduled = false;
  const schedulePublish = (): void => {
    if (publishScheduled || disposed) return;
    publishScheduled = true;
    requestAnimationFrame(() => {
      publishScheduled = false;
      publishRects();
    });
  };
  const deviceScale = (): { scaleX: number; scaleY: number } => {
    const canvas = modelRenderer.canvas;
    const refEl = canvas.width > 0 ? canvas : canvasLayer;
    const refRect = refEl.getBoundingClientRect();
    if (canvas.width > 0 && refRect.width > 0) {
      return { scaleX: canvas.width / refRect.width, scaleY: canvas.height / refRect.height };
    }
    const dpr = window.devicePixelRatio || 1;
    return { scaleX: dpr, scaleY: dpr };
  };
  const deviceRectOf = (el: HTMLElement): DOMRect => {
    const canvas = modelRenderer.canvas;
    const refEl = canvas.width > 0 ? canvas : canvasLayer;
    const refRect = refEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const { scaleX, scaleY } = deviceScale();
    return new DOMRect(
      (r.left - refRect.left) * scaleX,
      (r.top - refRect.top) * scaleY,
      r.width * scaleX,
      r.height * scaleY,
    );
  };
  const publishRects = (): void => {
    if (disposed) return;
    slotsMap.clear();
    let sampleKey: string | null = null;
    let sampleTop: number | null = null;
    for (const [key, nodes] of slotNodes) {
      const rect = deviceRectOf(nodes.well);
      slotsMap.set(key, rect);
      if (sampleKey === null) {
        sampleKey = key;
        sampleTop = rect.top;
      }
    }
    rects.doll = dollWell ? deviceRectOf(dollWell) : null;
    // The grid's own viewport: slot previews are scissored to it so rows
    // scrolled past the edge crop instead of painting over the chrome.
    rects.gridClip = deviceRectOf(grid);
    modelRenderer.setLayoutRects(rects);
    // Verification probe (DEF-13b): scroll must republish; the sample rect
    // tracks its row through scroll by exactly the scroll delta.
    (window as Window & { __successor3dInventoryRects?: unknown }).__successor3dInventoryRects = {
      publishedAt: performance.now(),
      scrollTop: grid.scrollTop,
      sampleKey,
      sampleTop,
      dpr: deviceScale().scaleY,
    };
  };
  // Row previews are positioned in canvas space from these rects — the grid
  // scrolling MUST republish or the 3D overlays stay pinned while the row
  // tags move under them (DEF-13b owner report). rAF-coalesced, cheap.
  const onGridScroll = (): void => schedulePublish();
  grid.addEventListener("scroll", onGridScroll, { passive: true });
  const itemSetChanged = (items: readonly InventoryItemVM[]): boolean => {
    if (items.length !== publishedKeys.size) return true;
    for (const item of items) {
      if (!publishedKeys.has(item.key)) return true;
    }
    return false;
  };
  const rebuildPublishedKeys = (items: readonly InventoryItemVM[]): void => {
    publishedKeys.clear();
    for (const item of items) publishedKeys.add(item.key);
  };

  // ── Slot DOM creation ────────────────────────────────────────────────────
  const createSlot = (item: InventoryItemVM): SlotNodes => {
    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "inv-slot";
    slot.dataset.key = item.key;
    slot.dataset.itemId = toolbarItemIdForInventoryItem(item);
    slot.dataset.variantId = String(item.row.variantId);
    slot.draggable = true;
    slot.setAttribute("role", "gridcell");
    slot.tabIndex = 0;
    slot.innerHTML = `
      <span class="inv-slot-well" data-ref="well" aria-hidden="true"></span>
      <span class="inv-chip" data-ref="chip"></span>
      <span class="inv-slot-title" data-ref="title" aria-hidden="true"></span>
      <span class="inv-var-chip" data-ref="variant" aria-hidden="true" hidden></span>
      <span class="inv-count" data-ref="count" aria-hidden="true"></span>
    `;
    grid.append(slot);
    const nodes: SlotNodes = {
      slot,
      well: inner(slot, "well"),
      chip: inner(slot, "chip"),
      variant: inner(slot, "variant"),
      count: inner(slot, "count"),
      title: inner(slot, "title"),
    };
    slotNodes.set(item.key, nodes);
    applied.set(item.key, {
      category: "",
      count: "\u0000",
      variant: "\u0000",
      title: "\u0000",
      tooltip: "\u0000",
      equipped: null,
      hover: null,
      selected: null,
    });
    return nodes;
  };
  const destroySlot = (key: string): void => {
    const nodes = slotNodes.get(key);
    if (!nodes) return;
    nodes.slot.remove();
    slotNodes.delete(key);
    applied.delete(key);
    publishedKeys.delete(key);
  };
  const reconcileSlots = (items: readonly InventoryItemVM[]): void => {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(item.key);
      if (!slotNodes.has(item.key)) createSlot(item);
    }
    for (const key of [...slotNodes.keys()]) {
      if (!seen.has(key)) destroySlot(key);
    }
  };
  const diffSlotContents = (
    items: readonly InventoryItemVM[],
    curHovered: string | null,
    curSelected: string | null,
  ): void => {
    for (const item of items) {
      const nodes = slotNodes.get(item.key);
      if (!nodes) continue;
      const toolbarItemId = toolbarItemIdForInventoryItem(item);
      if (nodes.slot.dataset.itemId !== toolbarItemId) nodes.slot.dataset.itemId = toolbarItemId;
      const variantId = String(item.row.variantId);
      if (nodes.slot.dataset.variantId !== variantId) nodes.slot.dataset.variantId = variantId;
      if (!nodes.slot.draggable) nodes.slot.draggable = true;
      let a = applied.get(item.key);
      if (!a) {
        a = { category: "", count: "\u0000", variant: "\u0000", title: "\u0000", tooltip: "\u0000", equipped: null, hover: null, selected: null };
        applied.set(item.key, a);
      }
      if (a.category !== item.category) {
        a.category = item.category;
        // Kind chip: purpose glyph (item kind / resource FAMILY) + label.
        // itemId is baked into the slot key, so the category gate is enough.
        nodes.chip.textContent = CATEGORY_LABEL[item.category];
        const kindSvg = itemKindIconSvg(item.category, RESOURCE_GLYPH_BY_ITEM_ID[item.itemId]);
        if (kindSvg) nodes.chip.insertAdjacentHTML("afterbegin", kindSvg);
        nodes.slot.dataset.cat = item.category;
      }
      const countText = item.count > 1 || item.resource ? `${item.count}` : "";
      if (a.count !== countText) {
        a.count = countText;
        nodes.count.textContent = countText;
        nodes.count.hidden = countText === "";
      }
      if (a.title !== item.label) {
        a.title = item.label;
        nodes.title.textContent = item.label;
      }
      const variantText = item.resource?.variantCode ?? "";
      if (a.variant !== variantText) {
        a.variant = variantText;
        nodes.variant.textContent = variantText;
        nodes.variant.hidden = variantText === "";
      }
      // Hover leads with the full noun — the clamp's escape hatch for the
      // rare 3-line name (loot window mirrors this).
      const tooltipText = item.resource?.tooltip ?? `${item.label} — ${item.description}`;
      if (a.tooltip !== tooltipText) {
        a.tooltip = tooltipText;
        nodes.slot.title = tooltipText;
      }
      const equipped = item.equipped;
      if (a.equipped !== equipped) {
        a.equipped = equipped;
        nodes.slot.toggleAttribute("data-equipped", equipped);
      }
      const hover = item.key === curHovered;
      if (a.hover !== hover) {
        a.hover = hover;
        nodes.slot.toggleAttribute("data-hover", hover);
      }
      const selected = item.key === curSelected;
      if (a.selected !== selected) {
        a.selected = selected;
        nodes.slot.toggleAttribute("data-selected", selected);
      }
    }
  };
  const diffLedger = (vm: InventoryViewModel): void => {
    const focusKey = vm.hoveredKey ?? vm.selectedKey ?? null;
    let focusItem: InventoryItemVM | null = null;
    if (focusKey) {
      for (const item of vm.items) {
        if (item.key === focusKey) {
          focusItem = item;
          break;
        }
      }
    }
    focusedVm = focusItem;
    if (focusItem) {
      const spawn = focusItem.category === "resource"
        ? state.serverAuthority.resourceSpawns.find(
          (candidate) => String(candidate.variantId) === String(focusItem.row.variantId),
        ) ?? null
        : null;
      const resource = focusItem.category === "resource"
        ? resourceInfoForRow(focusItem.row, { category: focusItem.category, fallbackName: focusItem.label, spawn })
        : null;
      const displayName = resource?.displayName ?? focusItem.label;
      if (ledger.name.textContent !== displayName) ledger.name.textContent = displayName;
      const catText = CATEGORY_LABEL[focusItem.category];
      if (ledger.cat.textContent !== catText) ledger.cat.textContent = catText;
      const variantText = resource?.variantCode ? `VAR ${resource.variantCode}` : "";
      if (ledger.variant.textContent !== variantText) ledger.variant.textContent = variantText;
      ledger.variant.hidden = variantText === "";
      const countText = focusItem.count > 1 ? `QTY ${focusItem.count.toLocaleString("en-US")}` : "QTY 1";
      if (ledger.count.textContent !== countText) ledger.count.textContent = countText;
      // Resource descriptions arrive pre-composed from the data adapter
      // ("TAXONOMY · purpose") — one source, no duplication here.
      const descText = focusItem.description;
      if (ledger.desc.textContent !== descText) ledger.desc.textContent = descText;
      const resourceKey = resource
        ? `${resource.displayName}:${resource.variantCode ?? ""}:${resource.taxonomySubtitle}:${resource.stats.map((stat) => `${stat.key}:${stat.value}`).join(",")}`
        : "";
      if (renderedFocusKey !== focusKey || renderedSpawnKey !== resourceKey) {
        renderResourceStatRows(ledger.stats, resource?.stats ?? null);
        renderedSpawnKey = resourceKey;
      }
      renderedFocusKey = focusKey;
    } else if (renderedFocusKey !== null) {
      ledger.name.textContent = "\u2014";
      ledger.cat.textContent = "";
      ledger.variant.textContent = "";
      ledger.variant.hidden = true;
      ledger.count.textContent = "";
      ledger.desc.textContent = EMPTY_LEDGER;
      renderResourceStatRows(ledger.stats, null);
      renderedFocusKey = null;
      renderedSpawnKey = NO_KEY;
    }
    const actionable = focusItem !== null && IS_ACTION_CATEGORY[focusItem.category];
    // DISCARD STACK — authority-backed two-step deletion (stackOps owns the
    // arm/confirm state); ineligible rows never show the button at all.
    const discardable = focusItem !== null && stackOps.discardEligible(focusItem);
    ledger.actionRow.toggleAttribute("data-action", actionable || discardable);
    if (actionable && focusItem) {
      const label = focusItem.equipped ? "UNEQUIP" : "EQUIP";
      if (ledger.actionBtn.textContent !== label) ledger.actionBtn.textContent = label;
      ledger.actionBtn.hidden = false;
      ledger.actionBtn.disabled = false;
      ledger.actionBtn.title = "";
    } else {
      ledger.actionBtn.hidden = true;
      ledger.actionBtn.disabled = true;
    }
    if (discardable && focusItem) {
      const armed = stackOps.armedDiscardKey() === focusItem.key;
      const label = armed
        ? `CONFIRM · DISCARD ${Math.max(0, focusItem.row.quantity).toLocaleString("en-US")}`
        : "DISCARD STACK";
      if (ledger.discardBtn.textContent !== label) ledger.discardBtn.textContent = label;
      ledger.discardBtn.toggleAttribute("data-armed", armed);
      ledger.discardBtn.title = armed
        ? "Press again to delete this stack — it cannot be recovered"
        : "Deletes this whole stack. Asks once more before it does.";
      ledger.discardBtn.hidden = false;
      ledger.discardBtn.disabled = false;
    } else {
      ledger.discardBtn.hidden = true;
      ledger.discardBtn.disabled = true;
      ledger.discardBtn.removeAttribute("data-armed");
    }
  };

  // ── Interaction: hover/click/keyboard on the grid ────────────────────────
  const slotFromEvent = (target: EventTarget | null): HTMLButtonElement | null => {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLButtonElement>(".inv-slot");
  };
  grid.addEventListener("mouseover", (event: MouseEvent) => {
    const key = slotFromEvent(event.target)?.dataset.key ?? null;
    if (hoveredKey !== key) hoveredKey = key;
  });
  grid.addEventListener("mouseout", (event: MouseEvent) => {
    const related = event.relatedTarget;
    if (!(related instanceof Node) || !grid.contains(related)) {
      if (hoveredKey !== null) hoveredKey = null;
    }
  });
  grid.addEventListener("click", (event: MouseEvent) => {
    const key = slotFromEvent(event.target)?.dataset.key;
    if (key && selectedKey !== key) selectedKey = key;
  });
  grid.addEventListener("focusin", (event: FocusEvent) => {
    const key = slotFromEvent(event.target)?.dataset.key;
    if (key && selectedKey !== key) selectedKey = key;
  });

  const findItem = (key: string): InventoryItemVM | null => {
    const items = latestVm?.items;
    if (!items) return null;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]!.key === key) return items[i]!;
    }
    return null;
  };

  grid.addEventListener("dragstart", (event: DragEvent) => {
    const slot = slotFromEvent(event.target);
    const key = slot?.dataset.key;
    if (!key) return;
    const item = findItem(key);
    if (!item || !event.dataTransfer) return;
    event.dataTransfer.setData(DRAG_ITEM, toolbarItemIdForInventoryItem(item));
    // Carried stacks additionally ride the stack tag (slot key) so drop
    // targets (trade, bank deposit) resolve the LIVE row — emitted here as
    // well as in stackOps so the deposit path never depends on that module's
    // listener registration order.
    if (item.row.stackId !== undefined) {
      event.dataTransfer.setData(DRAG_STACK_KEY, item.key);
    }
    event.dataTransfer.effectAllowed = "copy";
    slot.setAttribute("data-dragging", "");
  });
  grid.addEventListener("dragend", (event: DragEvent) => {
    slotFromEvent(event.target)?.removeAttribute("data-dragging");
  });

  // ── Drop intake: a LOOT-window tile dropped anywhere here TAKES it; a
  // BANK-window vault tile RETRIEVES it (authoritative per-stack transfer;
  // the tile lands when the delta returns). Each source rides its own MIME
  // type, so toolbar refs and stackOps merges never collide with this path.
  root.addEventListener("dragover", (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    if (!types || (!types.includes(LOOT_DRAG_MIME) && !types.includes(BANK_DRAG_MIME))) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
  });
  root.addEventListener("drop", (event: DragEvent) => {
    // Vault tile dropped here = RETRIEVE (bank window is the drag source).
    const bankRaw = event.dataTransfer?.getData(BANK_DRAG_MIME);
    if (bankRaw) {
      event.preventDefault();
      const payload = parseBankDragPayload(bankRaw);
      if (!payload) return;
      const session = resolveBankVaultSession(state, slice);
      if (!session.inReach || !session.live) {
        deps.sfx?.play(successorAudioIds.uiDeny);
        flashStatus(BANK_LINK_LOST_COPY);
        return;
      }
      // The dragged quantity is a stale snapshot from dragstart — resolve
      // the CURRENT vault row from the live projection (same live-resolution
      // rule as the deposit direction; never trust dragged counts).
      const liveRow = state.serverAuthority.bank?.items.find((row) => row.stackId === payload.stackId);
      const quantity = liveRow ? Math.max(0, Math.trunc(liveRow.available ?? liveRow.quantity)) : 0;
      if (quantity <= 0) {
        deps.sfx?.play(successorAudioIds.uiDeny);
        flashStatus("STACK GONE");
        return;
      }
      const queued = enqueueAuthorityBankRetrieveItemCommand(
        state.authorityCommands,
        payload.stackId,
        quantity,
        authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
      );
      deps.sfx?.play(queued ? successorAudioIds.itemTransfer : successorAudioIds.uiDeny);
      flashStatus(queued ? `${(payload.label || "STACK").toUpperCase()} · RETRIEVING ${quantity}` : STATUS_DENIED);
      return;
    }
    const raw = event.dataTransfer?.getData(LOOT_DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    const payload = parseLootDragPayload(raw);
    if (!payload) return;
    const queued = enqueueAuthorityTakeLootItemCommand(
      state.authorityCommands,
      payload.container,
      payload.itemId,
      payload.variantId,
      payload.quantity,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    deps.sfx?.play(queued ? successorAudioIds.itemTransfer : successorAudioIds.uiDeny);
    flashStatus(queued ? `${(payload.label || "ITEM").toUpperCase()} · TAKING ${payload.quantity}` : STATUS_DENIED);
  });

  // Primary action shortcut: double-click (and Enter on the focused slot).
  // With a live bank session the gesture becomes DEPOSIT FULL STACK — the
  // vault grammar overrides equip/redeem so a banking player never
  // accidentally arms gear beside the terminal. Out of reach the gesture
  // denies (transfers disabled), it never falls back to equipping.
  const depositStack = (item: InventoryItemVM, inReach: boolean, live: boolean): void => {
    if (!inReach || !live) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus(BANK_LINK_LOST_COPY);
      return;
    }
    if (item.row.stackId === undefined || !isLocalInventoryContainer(state, item.row.container)) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("VAULT REFUSES THAT");
      return;
    }
    const quantity = Math.max(0, Math.trunc(item.row.available));
    if (quantity <= 0) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus(STATUS_DENIED);
      return;
    }
    const queued = enqueueAuthorityBankStoreItemCommand(
      state.authorityCommands,
      String(item.row.stackId),
      quantity,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    deps.sfx?.play(queued ? successorAudioIds.itemTransfer : successorAudioIds.uiDeny);
    flashStatus(queued ? `${item.label.toUpperCase()} · STORING ${quantity}` : STATUS_DENIED);
  };
  const triggerPrimaryAction = (key: string): void => {
    const item = findItem(key);
    if (!item) return;
    const session = resolveBankVaultSession(state, slice);
    if (session.open) {
      depositStack(item, session.inReach, session.live);
      return;
    }
    // A credit chip's primary action is REDEEM — double-click / Enter banks it.
    if (item.itemId === CREDIT_CHIP_ITEM_ID) {
      const result = dispatchInventoryAction(state, slice, item, "redeem");
      flashStatus(result === "redeemed" ? `${item.label} · REDEEMED` : STATUS_DENIED);
      return;
    }
    if (item.category !== "gear" && item.category !== "weapon") return;
    const result = applyInventoryAction(state, slice, item);
    if (result === "unsupported") flashStatus(STATUS_DENIED);
    else flashStatus(inventoryEquipFlashStatus(item.label, item.local, result));
  };
  grid.addEventListener("dblclick", (event: MouseEvent) => {
    const key = slotFromEvent(event.target)?.dataset.key;
    if (key) triggerPrimaryAction(key);
  });
  grid.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
    const key = slotFromEvent(event.target)?.dataset.key;
    if (key) {
      event.preventDefault();
      triggerPrimaryAction(key);
    }
  });

  const flashStatus = (message: string): void => {
    window.clearTimeout(statusFlashTimer);
    status.textContent = message;
    status.toggleAttribute("data-flash", true);
    statusFlashTimer = window.setTimeout(() => {
      status.textContent = STATUS_IDLE;
      status.toggleAttribute("data-flash", false);
    }, STATUS_FLASH_MS);
  };
  ledger.actionBtn.addEventListener("click", () => {
    const vm = focusedVm;
    if (!vm) return;
    const result = applyInventoryAction(state, slice, vm);
    if (result === "unsupported") {
      flashStatus(STATUS_DENIED);
    } else {
      flashStatus(inventoryEquipFlashStatus(vm.label, vm.local, result));
    }
  });
  ledger.discardBtn.addEventListener("click", () => {
    const vm = focusedVm;
    if (!vm) return;
    // Two-step: stackOps arms on the first press and enqueues DiscardStack
    // on a confirm inside the arm window (timeout disarms).
    stackOps.activateDiscard(vm.key);
  });

  // ── Right-click: shared context radial (action registry driven) ─────────
  const dispatchRadialAction = (key: string, actionId: string): void => {
    const item = findItem(key);
    if (!item) {
      flashStatus(STATUS_DENIED);
      return;
    }
    if (actionId === "split") {
      // SPLIT owns its own dialog (stackOps) — never routed through the
      // data adapter, the server resolves the actual split.
      stackOps.openSplit(key);
      return;
    }
    if (actionId === "destroy") {
      // DISCARD STACK shares the ledger's two-step arm/confirm — a radial
      // press arms; the confirm lands from the radial or the ledger button.
      stackOps.activateDiscard(key);
      return;
    }
    const result = dispatchInventoryAction(state, slice, item, actionId as InventoryActionId);
    if (result === "unsupported") flashStatus(STATUS_DENIED);
    else if (result === "equipped" || result === "unequipped") {
      flashStatus(inventoryEquipFlashStatus(item.label, item.local, result));
    }
    else if (result === "used") flashStatus(`${item.label} · USED`);
    else if (result === "placed") flashStatus(`${item.label} · DEPLOYED`);
    else if (result === "redeemed") flashStatus(`${item.label} · REDEEMED`);
    // "examined": the examine window opening IS the feedback — no flash.
    // "opened": the survey tool window opening IS the feedback — no flash.
  };
  grid.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();
    const key = slotFromEvent(event.target)?.dataset.key;
    if (!key) {
      deps.radial.close();
      return;
    }
    const item = findItem(key);
    if (!item) return;
    if (selectedKey !== key) selectedKey = key;
    deps.radial.openFor(event.clientX, event.clientY, contextActionsFor(item), {
      onAction: (actionId) => dispatchRadialAction(key, actionId),
      onDisabled: (note) => flashStatus(note || STATUS_DENIED),
    });
  });

  // ── Stack operations: SPLIT + drag-to-MERGE + two-step DISCARD ──────────
  const stackOps = installStackOps({ root, grid, state, slice, findItem, flashStatus });

  const syncPaperDollCombatPose = (vm: InventoryViewModel): void => {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const authorityActor = state.serverAuthority.actors[actorId] ?? null;
    vm.doll.inCombat = authorityActor?.inCombat;
  };

  // ── Window content handle ────────────────────────────────────────────────
  return {
    update(dtSeconds: number, timeMs: number): void {
      uiState.selectedKey = selectedKey;
      uiState.hoveredKey = hoveredKey;
      const vm = buildInventoryViewModel(state, uiState);
      syncPaperDollCombatPose(vm);
      latestVm = vm;
      if (itemSetChanged(vm.items)) {
        reconcileSlots(vm.items);
        rebuildPublishedKeys(vm.items);
        publishRects();
      }
      diffSlotContents(vm.items, vm.hoveredKey, vm.selectedKey);
      const stackReceipt = stackOps.poll();
      if (stackReceipt) flashStatus(stackReceipt);
      diffLedger(vm);
      modelRenderer.render(vm, dtSeconds, timeMs);
      (window as Window & { __successor3dInventoryPaperDollEquipmentIds?: string[] })
        .__successor3dInventoryPaperDollEquipmentIds = modelRenderer.paperDollAttachedEquipmentIds();
    },
    onResized(): void {
      schedulePublish();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(statusFlashTimer);
      stackOps.dispose();
      dollSplit.removeEventListener("pointerdown", onSplitDown);
      dollSplit.removeEventListener("pointermove", onSplitMove);
      dollSplit.removeEventListener("pointerup", onSplitUp);
      dollSplit.removeEventListener("pointercancel", onSplitUp);
      grid.removeEventListener("scroll", onGridScroll);
      delete (window as Window & { __successor3dInventoryPaperDollEquipmentIds?: string[] })
        .__successor3dInventoryPaperDollEquipmentIds;
      delete inventoryProbeWindow.__successor3dInventoryModelAssetKey;
      modelRenderer.dispose();
      root.remove();
    },
  };
}

// ── DOM helpers (durable, multi-call-site) ─────────────────────────────────

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`inventory content: missing data-ref="${name}"`);
  return el;
}

function inner(slot: HTMLElement, name: string): HTMLElement {
  const el = slot.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`inventory content: missing slot data-ref="${name}"`);
  return el;
}
