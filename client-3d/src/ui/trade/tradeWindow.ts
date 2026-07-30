import "./trade.css";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import type { InventoryRow } from "@successor/client/src/slice-core/gameState";
import {
  displayMetadataForRow,
  equipmentIdForInventoryRow,
  modelPathForItemId,
  resolveInventoryItem,
  resolveInventoryItemByCatalogId,
} from "../inventory/data";
import { InventoryModelRenderer } from "../inventory/modelRenderer";
import { renderResourceStatRows, resourceInfoForRow } from "../inventory/resourceInfo";
import type {
  InventoryItemVM,
  InventoryLayoutRects,
  InventoryViewModel,
  PaperDollVM,
} from "../inventory/types";
import { UI_ICONS } from "../icons";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windows/windowManager";
import { createTradeReceiptWatcher, type TradeCommandPort, type TradeReceipt } from "./commands";
import {
  clampTradeCoin,
  composeTradeView,
  type TradeCellModel,
  type TradeColumnModel,
  type TradeViewModel,
} from "./composers";
import { TRADE_COPY, tradeReasonLine } from "./copy";
import { isTerminalTradeStage } from "./machine";
import { clearTradeOpenRequested, TRADE_WINDOW_ID, tradeOpenRequestedAt } from "./lifecycle";
import {
  acknowledgeTradeClose,
  syncTradeChannelFromAuthority,
  tradeSession,
  tradeStoreVersion,
} from "./store";
import type { TradeSelection, TradeSessionVM } from "./types";

/**
 * TRADE — the secure trade window in the Quartermaster's Slate chrome.
 *
 * Two notarized columns (YOUR OFFER | partner) of turntable item cells, a
 * wallet-credit line per side, and an examine-scale preview well for whichever
 * offered line is selected — informed consent on what you're receiving is
 * part of the soul, so partner lines get the full resource ledger (taxonomy,
 * variant, stats) exactly like EXAMINE.
 *
 * Double-lock journey (server truth only — the streamed tradeSession VM
 * decides everything): stage offers → ACCEPT seals your column (visible on
 * both clients as a diagonal SEALED stamp) → ANY change by either side
 * breaks BOTH seals (flash + deny tone; the classic last-second-switch
 * counter) → both sealed arms the dual OK → both COUNTERSIGN and the swap
 * executes atomically. DECLINE (or ✕/Esc, or walking away) clears the
 * table with nothing moved.
 *
 * World-opened (radial TRADE on a player pawn / `/trade`), transient, never
 * boot-restored. The partner's window auto-opens when the session VM
 * appears (`pollTradeLifecycle` in lifecycle.ts — wired by the composition
 * root, DOM-free for the boot graph and node tests).
 */

const STATUS_FLASH_MS = 2600;
const STALE_RECEIPT_MS = 10_000;
/** "TABLE REQUESTED" grace window after an open command with no VM yet. */
const OPEN_PENDING_MS = 4_000;
/** Inventory-window drag mimes (cross-module literals — toolbar precedent). */
const DRAG_STACK_MIME = "text/x-sc3d-inventory-stack";
const DRAG_ITEM_MIME = "text/x-sc3d-item";

export interface TradeWindowDeps {
  commands: TradeCommandPort;
  closeWindow: (id: string) => void;
  sfx?: SfxPlayer;
}

export function createTradeWindowDefinition(deps: TradeWindowDeps): WindowDefinition {
  return {
    id: TRADE_WINDOW_ID,
    title: TRADE_COPY.windowTitle,
    icon: "trade",
    hotkey: null,
    minWidth: 560,
    minHeight: 470,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.max(560, Math.round(viewport.w * 0.42));
      const h = Math.max(470, Math.round(viewport.h * 0.62));
      // Left-of-center: the inventory window defaults centered and this
      // window's whole point is dragging stacks across from it.
      const x = Math.max(0, Math.min(Math.round(viewport.w * 0.07), viewport.w - w));
      const y = Math.round(Math.max(0, (viewport.h - h) / 2 - 24));
      return { x, y, w, h };
    },
    mount: (contentRoot, ctx) => mountTradeContent(contentRoot, ctx, deps),
  };
}

function mountTradeContent(
  contentRoot: HTMLElement,
  ctx: WindowContext,
  deps: TradeWindowDeps,
): WindowContentHandle {
  const { state } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root scp-trade";
  root.innerHTML = `
    <div class="inv-canvas-layer" data-ref="canvasLayer" aria-hidden="true"></div>
    <div class="scp-trade-chrome">
      <div class="scp-trade-table">
        <section class="scp-trade-col" data-side="mine" data-ref="colMine" aria-label="Your offer">
          <header class="scp-trade-col-head">
            <span class="scp-trade-col-title" data-ref="mineTitle"></span>
            <span class="scp-trade-stagetag" data-ref="stageTag"></span>
          </header>
          <div class="scp-trade-grid" data-ref="mineGrid" role="grid"></div>
          <div class="scp-trade-coin" title="${TRADE_COPY.coin.editHint}">
            <span class="scp-trade-coin-label">${TRADE_COPY.coin.label}</span>
            <input class="scp-trade-coin-input" data-ref="coinInput" type="text" inputmode="numeric" maxlength="9" aria-label="Credits offered" />
            <span class="scp-trade-coin-held" data-ref="coinHeld"></span>
          </div>
          <span class="scp-trade-seal" data-ref="mineSeal" hidden></span>
        </section>
        <section class="scp-trade-col" data-side="theirs" data-ref="colTheirs" aria-label="Partner offer">
          <header class="scp-trade-col-head">
            <span class="scp-trade-col-title" data-ref="theirsTitle"></span>
          </header>
          <div class="scp-trade-grid" data-ref="theirsGrid" role="grid"></div>
          <div class="scp-trade-coin">
            <span class="scp-trade-coin-label">${TRADE_COPY.coin.label}</span>
            <span class="scp-trade-coin-value" data-ref="theirsCoin">0</span>
          </div>
          <span class="scp-trade-seal" data-ref="theirsSeal" hidden></span>
        </section>
      </div>
      <div class="scp-trade-preview">
        <div class="scp-trade-well" data-ref="well" aria-hidden="true"></div>
        <div class="scp-trade-info" data-ref="info" hidden>
          <strong class="scp-trade-info-name" data-ref="pvName"></strong>
          <div class="scp-trade-info-meta">
            <span data-ref="pvQty"></span>
            <span data-ref="pvVariant" hidden></span>
          </div>
          <p class="scp-trade-info-desc" data-ref="pvDesc"></p>
          <div class="scp-trade-info-stats" data-ref="pvStats" hidden></div>
        </div>
        <div class="scp-trade-info scp-trade-info--idle" data-ref="infoIdle">
          <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.examine}</span>
          <span>${TRADE_COPY.preview.empty}</span>
          <small>${TRADE_COPY.preview.emptyHint}</small>
        </div>
      </div>
      <footer class="scp-trade-ctas">
        <button type="button" class="scp-trade-btn scp-trade-btn--accent" data-ref="acceptBtn" title="${TRADE_COPY.cta.acceptHint}">${TRADE_COPY.cta.accept}</button>
        <button type="button" class="scp-trade-btn scp-trade-btn--accent" data-ref="confirmBtn" title="${TRADE_COPY.cta.confirmHint}" hidden>${TRADE_COPY.cta.confirm}</button>
        <span class="scp-trade-cta-note" data-ref="ctaNote"></span>
        <button type="button" class="scp-trade-btn scp-trade-btn--danger" data-ref="declineBtn" title="${TRADE_COPY.cta.declineHint}">${TRADE_COPY.cta.decline}</button>
      </footer>
      <div class="scp-trade-banner" data-ref="banner" hidden>
        <span class="scp-trade-banner-stamp" data-ref="bannerStamp"></span>
        <span class="scp-trade-banner-line" data-ref="bannerLine"></span>
      </div>
      <div class="scp-empty" data-ref="emptyState" hidden>
        <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.trade}</span>
        <span data-ref="emptyTitle">${TRADE_COPY.empty}</span>
        <small data-ref="emptyHint">${TRADE_COPY.emptyHint}</small>
      </div>
      <footer class="scp-status-foot">
        <span class="scp-status-line" data-ref="status"></span>
        <span class="scp-trade-session-tag" data-ref="sessionTag"></span>
      </footer>
    </div>
  `;
  contentRoot.appendChild(root);

  const canvasLayer = ref(root, "canvasLayer");
  const chromeEl = root.querySelector<HTMLElement>(".scp-trade-chrome")!;
  const colMine = ref(root, "colMine");
  const colTheirs = ref(root, "colTheirs");
  const mineTitleEl = ref(root, "mineTitle");
  const theirsTitleEl = ref(root, "theirsTitle");
  const stageTagEl = ref(root, "stageTag");
  const mineGrid = ref(root, "mineGrid");
  const theirsGrid = ref(root, "theirsGrid");
  const coinInput = ref(root, "coinInput") as HTMLInputElement;
  const coinHeldEl = ref(root, "coinHeld");
  const theirsCoinEl = ref(root, "theirsCoin");
  const mineSealEl = ref(root, "mineSeal");
  const theirsSealEl = ref(root, "theirsSeal");
  const well = ref(root, "well");
  const infoEl = ref(root, "info");
  const infoIdleEl = ref(root, "infoIdle");
  const pvNameEl = ref(root, "pvName");
  const pvQtyEl = ref(root, "pvQty");
  const pvVariantEl = ref(root, "pvVariant");
  const pvDescEl = ref(root, "pvDesc");
  const pvStatsEl = ref(root, "pvStats");
  const acceptBtn = ref(root, "acceptBtn") as HTMLButtonElement;
  const confirmBtn = ref(root, "confirmBtn") as HTMLButtonElement;
  const ctaNoteEl = ref(root, "ctaNote");
  const declineBtn = ref(root, "declineBtn") as HTMLButtonElement;
  const bannerEl = ref(root, "banner");
  const bannerStampEl = ref(root, "bannerStamp");
  const bannerLineEl = ref(root, "bannerLine");
  const emptyStateEl = ref(root, "emptyState");
  const emptyHintEl = ref(root, "emptyHint");
  const statusEl = ref(root, "status");
  const sessionTagEl = ref(root, "sessionTag");

  // ── Local UI state ───────────────────────────────────────────────────────
  let disposed = false;
  let appliedVersion = -1;
  let uiDirty = true;
  let selection: TradeSelection | null = null;
  let statusFlashTimer = 0;
  /** Seal-break observation: previous frame's lock fingerprint. */
  let prevProposalId = -1;
  let prevAnyLocked = false;
  let prevStage: TradeSessionVM["stage"] | null = null;
  /** Rects must be re-published after any DOM rebuild / resize. */
  let rectsDirty = true;
  /** Wallet hint refresh: last scalar credit balance observed. */
  let lastHeldCoin = -1;

  const receiptWatcher = createTradeReceiptWatcher(state);
  const receiptScratch: TradeReceipt[] = [];

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
      flash(`${TRADE_COPY.deny} · NO LINK`, false);
    }
    return queued;
  };

  const heldCoin = (): number => {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    return Math.max(0, Math.trunc(state.serverAuthority.actors[actorId]?.credits ?? 0));
  };

  // ── 3D: one turntable renderer, cells + preview well ────────────────────
  const modelRenderer = InventoryModelRenderer.create(canvasLayer, {
    state,
    paperDoll: false,
    slotDragHost: well,
  });
  const doll: PaperDollVM = { body: "male", equipmentIds: [], weaponId: null };
  const previewVm: InventoryViewModel = { open: true, items: [], selectedKey: null, hoveredKey: null, doll };
  const slotsMap = new Map<string, DOMRectReadOnly>();
  const rects: InventoryLayoutRects = { slots: slotsMap, doll: null, gridClip: null };
  let publishedCanvasW = 0;
  let publishedCanvasH = 0;

  /** Synth VM cache — one InventoryItemVM per cell key, keyed on qty too. */
  const synthCache = new Map<string, { qty: number; vm: InventoryItemVM }>();

  const synthesizeItem = (cell: TradeCellModel, key: string): InventoryItemVM => {
    const cached = synthCache.get(key);
    if (cached && cached.qty === cell.quantity && cached.vm.label === cell.name) return cached.vm;
    const row: InventoryRow = {
      container: "trade-line",
      item: cell.name,
      itemId: cell.itemId,
      variantId: cell.variantId,
      quantity: cell.quantity,
      reserved: 0,
      available: cell.quantity,
    };
    const meta = displayMetadataForRow(row);
    const spawn = meta.category === "resource"
      ? state.serverAuthority.resourceSpawns.find(
        (candidate) => String(candidate.variantId) === String(cell.variantId),
      ) ?? null
      : null;
    const resource = meta.category === "resource"
      ? resourceInfoForRow(row, { category: meta.category, fallbackName: cell.name, spawn })
      : null;
    const vm: InventoryItemVM = {
      key,
      itemId: cell.itemId,
      // The wire line's name IS the table's display truth (both clients read
      // the same stack label); taxonomy/meta only backfill an empty name.
      label: cell.name || resource?.displayName || meta.label,
      description: resource?.taxonomySubtitle ?? meta.description,
      category: meta.category,
      count: cell.quantity,
      equipped: false,
      glb: modelPathForItemId(cell.itemId),
      local: false,
      equipmentId: equipmentIdForInventoryRow(row),
      resource,
      row,
    };
    synthCache.set(key, { qty: cell.quantity, vm });
    return vm;
  };

  const publishRects = (view: TradeViewModel): void => {
    const canvas = modelRenderer.canvas;
    const layerRect = canvasLayer.getBoundingClientRect();
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
    slotsMap.clear();
    const inset = 3;
    for (const grid of [mineGrid, theirsGrid]) {
      for (const cellEl of grid.querySelectorAll<HTMLElement>("[data-key]")) {
        const key = cellEl.dataset.key;
        if (!key) continue;
        const rect = cellEl.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        slotsMap.set(key, new DOMRect(
          (rect.left - layerRect.left + inset) * scaleX,
          (rect.top - layerRect.top + inset) * scaleY,
          Math.max(1, (rect.width - inset * 2) * scaleX),
          Math.max(1, (rect.height - inset * 2) * scaleY),
        ));
      }
    }
    if (view.previewCell) {
      const wellRect = well.getBoundingClientRect();
      const wellInset = 6;
      slotsMap.set(previewKeyOf(view.previewCell), new DOMRect(
        (wellRect.left - layerRect.left + wellInset) * scaleX,
        (wellRect.top - layerRect.top + wellInset) * scaleY,
        Math.max(1, (wellRect.width - wellInset * 2) * scaleX),
        Math.max(1, (wellRect.height - wellInset * 2) * scaleY),
      ));
    }
    rects.doll = null;
    modelRenderer.setLayoutRects(rects);
    publishedCanvasW = canvas.width;
    publishedCanvasH = canvas.height;
    rectsDirty = false;
  };

  const renderModels = (view: TradeViewModel, dtSeconds: number, timeMs: number): void => {
    if (!view.open) {
      previewVm.open = false;
      modelRenderer.render(previewVm, dtSeconds, timeMs);
      return;
    }
    const items: InventoryItemVM[] = [];
    for (const cell of [...view.mine.cells, ...view.theirs.cells]) {
      items.push(synthesizeItem(cell, cell.key));
    }
    if (view.previewCell) {
      items.push(synthesizeItem(view.previewCell, previewKeyOf(view.previewCell)));
    }
    const canvas = modelRenderer.canvas;
    if (rectsDirty || canvas.width !== publishedCanvasW || canvas.height !== publishedCanvasH) {
      publishRects(view);
    }
    previewVm.items = items;
    previewVm.open = true;
    modelRenderer.render(previewVm, dtSeconds, timeMs);
  };

  // ── Command helpers ──────────────────────────────────────────────────────
  const liveProposalId = (): number | null => {
    const session = tradeSession();
    return session && !isTerminalTradeStage(session.stage) ? session.proposalId : null;
  };

  const commitCoin = (): void => {
    const proposalId = liveProposalId();
    const session = tradeSession();
    if (proposalId === null || !session) return;
    const amount = clampTradeCoin(Number(coinInput.value.replace(/[^0-9]/gu, "")), heldCoin());
    coinInput.value = String(amount);
    if (amount === session.mine.coin) return;
    if (queueFeedback(deps.commands.setCoin(proposalId, amount))) {
      flash(`${TRADE_COPY.coin.label} · ${amount.toLocaleString("en-US")} ON THE TABLE`, true);
    }
  };

  // ── Drag-drop from the inventory window (MY grid only) ──────────────────
  const resolveDropItem = (dt: DataTransfer): InventoryItemVM | null => {
    const stackKey = dt.getData(DRAG_STACK_MIME);
    if (stackKey) return resolveInventoryItem(state, stackKey);
    const catalogId = dt.getData(DRAG_ITEM_MIME);
    if (catalogId) return resolveInventoryItemByCatalogId(state, catalogId);
    return null;
  };

  mineGrid.addEventListener("dragover", (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    if (!types || (!types.includes(DRAG_STACK_MIME) && !types.includes(DRAG_ITEM_MIME))) return;
    if (liveProposalId() === null) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
    mineGrid.toggleAttribute("data-drop", true);
  });
  mineGrid.addEventListener("dragleave", () => {
    mineGrid.toggleAttribute("data-drop", false);
  });
  mineGrid.addEventListener("drop", (event: DragEvent) => {
    mineGrid.toggleAttribute("data-drop", false);
    if (!event.dataTransfer) return;
    const proposalId = liveProposalId();
    if (proposalId === null) return;
    event.preventDefault();
    const item = resolveDropItem(event.dataTransfer);
    if (!item) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flash(`${TRADE_COPY.deny} · Not in your pack.`, false);
      return;
    }
    if (item.category === "currency") {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flash(`${TRADE_COPY.deny} · USE THE COIN FIELD`, false);
      return;
    }
    if (item.local) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flash(`${TRADE_COPY.deny} · That's wardrobe kit, not field property.`, false);
      return;
    }
    const quantity = Math.max(1, item.row.available);
    if (queueFeedback(deps.commands.addItem(proposalId, item.itemId, item.row.variantId, quantity))) {
      flash(`${item.label.toUpperCase()} · ON THE TABLE`, true);
    }
  });

  // ── Grid interactions (selection + withdraw) ─────────────────────────────
  const onGridClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    const cellEl = target?.closest<HTMLElement>(".scp-trade-cell[data-key]");
    if (!cellEl) return;
    const side = cellEl.dataset.side === "theirs" ? "theirs" : "mine";
    const itemId = Number(cellEl.dataset.itemId ?? "0");
    const variantId = Number(cellEl.dataset.variantId ?? "0");
    if (target?.closest("[data-remove]")) {
      const proposalId = liveProposalId();
      const quantity = Number(cellEl.dataset.quantity ?? "0");
      if (proposalId !== null && side === "mine") {
        if (queueFeedback(deps.commands.removeItem(proposalId, itemId, variantId, quantity))) {
          flash("WITHDRAWN FROM THE TABLE", true);
        }
      }
      return;
    }
    const same = selection && selection.side === side && selection.itemId === itemId && selection.variantId === variantId;
    selection = same ? null : { side, itemId, variantId };
    deps.sfx?.play("ui_button_tick");
    uiDirty = true;
  };
  mineGrid.addEventListener("click", onGridClick);
  theirsGrid.addEventListener("click", onGridClick);

  // ── Coin field ───────────────────────────────────────────────────────────
  coinInput.addEventListener("keydown", (event) => {
    if (event.code === "Enter") {
      event.preventDefault();
      commitCoin();
      coinInput.blur();
      return;
    }
    if (event.code !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    const session = tradeSession();
    coinInput.value = String(session?.mine.coin ?? 0);
    coinInput.blur();
  });
  coinInput.addEventListener("blur", commitCoin);

  // ── CTAs ─────────────────────────────────────────────────────────────────
  acceptBtn.addEventListener("click", () => {
    const proposalId = liveProposalId();
    if (proposalId === null || acceptBtn.disabled) return;
    queueFeedback(deps.commands.accept(proposalId));
  });
  confirmBtn.addEventListener("click", () => {
    const proposalId = liveProposalId();
    if (proposalId === null || confirmBtn.disabled) return;
    queueFeedback(deps.commands.confirm(proposalId));
  });
  declineBtn.addEventListener("click", () => {
    const session = tradeSession();
    if (!session) {
      deps.closeWindow(TRADE_WINDOW_ID);
      return;
    }
    if (isTerminalTradeStage(session.stage)) {
      acknowledgeTradeClose();
      deps.closeWindow(TRADE_WINDOW_ID);
      return;
    }
    // Live decline: the terminal VM (one tick) paints the banner; the
    // window stays up so both players read the same closing state.
    queueFeedback(deps.commands.decline(session.proposalId));
  });

  // ── Receipts → player language ───────────────────────────────────────────
  const handleReceipts = (): void => {
    receiptScratch.length = 0;
    receiptWatcher.poll(receiptScratch);
    for (const receipt of receiptScratch) {
      if (receipt.sentAtMs !== null && performance.now() - receipt.sentAtMs > STALE_RECEIPT_MS) continue;
      if (!receipt.accepted) {
        deps.sfx?.play(successorAudioIds.uiDeny);
        flash(`${TRADE_COPY.deny} · ${tradeReasonLine(receipt.reasonCode)}`, false);
        continue;
      }
      if (receipt.kind === "ProposeTrade") flash("TABLE OPENED", true);
      else if (receipt.kind === "AcceptTrade") flash(`${TRADE_COPY.seal.locked} · AWAITING PARTNER`, true);
      else if (receipt.kind === "ConfirmTrade") flash(`${TRADE_COPY.seal.confirmed}`, true);
    }
  };

  // ── Renderers (rebuild-on-key) ───────────────────────────────────────────
  const renderGrid = (grid: HTMLElement, column: TradeColumnModel): void => {
    grid.textContent = "";
    for (const cell of column.cells) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "scp-trade-cell";
      el.dataset.key = cell.key;
      el.dataset.side = cell.side;
      el.dataset.itemId = String(cell.itemId);
      el.dataset.variantId = String(cell.variantId);
      el.dataset.quantity = String(cell.quantity);
      el.toggleAttribute("data-selected", cell.selected);
      el.title = cell.quantity > 1 ? `${cell.name} \u00d7${cell.quantity}` : cell.name;
      if (cell.countText) {
        const count = document.createElement("b");
        count.className = "scp-trade-cell-count";
        count.textContent = cell.countText;
        el.appendChild(count);
      }
      if (cell.removable) {
        const remove = document.createElement("span");
        remove.className = "scp-trade-cell-remove";
        remove.setAttribute("data-remove", "");
        remove.setAttribute("role", "button");
        remove.setAttribute("aria-label", TRADE_COPY.grid.remove);
        remove.title = TRADE_COPY.grid.remove;
        remove.innerHTML = UI_ICONS.close;
        el.appendChild(remove);
      }
      grid.appendChild(el);
    }
    for (let i = 0; i < column.emptyCount; i += 1) {
      const empty = document.createElement("div");
      empty.className = "scp-trade-cell scp-trade-cell--empty";
      if (column.side === "mine") empty.title = TRADE_COPY.grid.dropHint;
      grid.appendChild(empty);
    }
  };

  const renderPreviewInfo = (view: TradeViewModel): void => {
    const cell = view.previewCell;
    infoEl.hidden = cell === null;
    infoIdleEl.hidden = cell !== null;
    if (!cell) return;
    const vm = synthesizeItem(cell, previewKeyOf(cell));
    pvNameEl.textContent = vm.label;
    pvQtyEl.textContent = TRADE_COPY.preview.qty(cell.quantity);
    const variantText = vm.resource?.variantCode ? `VAR ${vm.resource.variantCode}` : "";
    pvVariantEl.textContent = variantText;
    pvVariantEl.hidden = variantText === "";
    pvDescEl.textContent = vm.description;
    renderResourceStatRows(pvStatsEl, vm.resource?.stats ?? null);
  };

  let renderKey = "";
  /** Last composed view — renderModels reuses it between DOM rebuilds. */
  let lastView: TradeViewModel = composeTradeView(null, { selection: null, heldCoin: 0 });
  const renderAll = (held: number): void => {
    const session = tradeSession();
    const view = composeTradeView(session, { selection, heldCoin: held });
    selection = view.selection;
    lastView = view;

    const key = [
      tradeStoreVersion(),
      selection ? `${selection.side}:${selection.itemId}:${selection.variantId}` : "-",
      view.open ? "o" : "c",
      view.mine.heldLine ?? "",
    ].join("|");
    if (key === renderKey) return;
    renderKey = key;
    rectsDirty = true;

    emptyStateEl.hidden = view.open;
    chromeEl.toggleAttribute("data-empty", !view.open);
    if (!view.open) {
      const requestedAt = tradeOpenRequestedAt();
      const pending = requestedAt > 0 && performance.now() - requestedAt < OPEN_PENDING_MS;
      emptyHintEl.textContent = pending ? TRADE_COPY.emptyRequested : TRADE_COPY.emptyHint;
      sessionTagEl.textContent = "";
      stageTagEl.textContent = "";
      bannerEl.hidden = true;
      acceptBtn.hidden = true;
      confirmBtn.hidden = true;
      ctaNoteEl.textContent = "";
      declineBtn.textContent = TRADE_COPY.cta.close;
      renderPreviewInfo(view);
      return;
    }

    // Header + columns
    mineTitleEl.textContent = view.mine.title;
    theirsTitleEl.textContent = view.theirs.title;
    stageTagEl.textContent = view.stageLine;
    renderGrid(mineGrid, view.mine);
    renderGrid(theirsGrid, view.theirs);

    // Coin rows — never fight the player's caret.
    if (document.activeElement !== coinInput) coinInput.value = String(view.mine.coinValue);
    coinInput.disabled = !view.mine.coinEditable;
    coinHeldEl.textContent = view.mine.heldLine ?? "";
    theirsCoinEl.textContent = view.theirs.coinText;

    // Seals — the visible lock state on both clients.
    mineSealEl.hidden = view.mine.sealText === null;
    mineSealEl.textContent = view.mine.sealText ?? "";
    theirsSealEl.hidden = view.theirs.sealText === null;
    theirsSealEl.textContent = view.theirs.sealText ?? "";
    colMine.toggleAttribute("data-locked", view.mine.locked);
    colTheirs.toggleAttribute("data-locked", view.theirs.locked);

    // CTAs
    acceptBtn.hidden = !view.ctas.accept.visible;
    acceptBtn.disabled = !view.ctas.accept.enabled;
    confirmBtn.hidden = !view.ctas.confirm.visible;
    confirmBtn.disabled = !view.ctas.confirm.enabled;
    ctaNoteEl.textContent = view.ctas.accept.stateLine ?? view.ctas.confirm.stateLine ?? "";
    declineBtn.textContent = view.ctas.decline.label;

    // Terminal banner
    bannerEl.hidden = view.banner.kind === "none";
    bannerEl.dataset.kind = view.banner.kind;
    bannerStampEl.textContent = view.banner.title;
    bannerLineEl.textContent = view.banner.line;

    renderPreviewInfo(view);

    sessionTagEl.textContent = `TABLE #${session!.proposalId} · ${view.partnerName.toUpperCase()}`;
  };

  return {
    update(dtSeconds: number, timeMs: number): void {
      syncTradeChannelFromAuthority(state);
      handleReceipts();

      const session = tradeSession();

      // Transition observation — server truth narrated honestly.
      if (session) {
        const anyLocked = session.mine.locked || session.theirs.locked;
        if (session.proposalId === prevProposalId) {
          if (prevAnyLocked && !anyLocked && session.stage === "negotiating") {
            deps.sfx?.play(successorAudioIds.uiDeny);
            flash(TRADE_COPY.seal.broken, false);
          }
          if (session.stage === "executed" && prevStage !== "executed") {
            deps.sfx?.play(successorAudioIds.itemTransfer);
          }
        } else {
          // Fresh table: window-local staging dies with the old one.
          selection = null;
          clearTradeOpenRequested();
        }
        prevProposalId = session.proposalId;
        prevAnyLocked = anyLocked;
        prevStage = session.stage;
      } else {
        prevProposalId = -1;
        prevAnyLocked = false;
        prevStage = null;
      }

      const held = heldCoin();
      if (held !== lastHeldCoin) {
        lastHeldCoin = held;
        uiDirty = true;
      }
      const version = tradeStoreVersion();
      if (version !== appliedVersion || uiDirty) {
        appliedVersion = version;
        uiDirty = false;
        renderAll(held);
      }
      renderModels(lastView, dtSeconds, timeMs);
    },
    onResized(): void {
      rectsDirty = true;
      renderKey = "";
      uiDirty = true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(statusFlashTimer);
      modelRenderer.dispose();
      root.remove();
    },
  };
}

function previewKeyOf(cell: TradeCellModel): string {
  return `trade:preview:${cell.itemId}:${cell.variantId}`;
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`trade window: missing data-ref="${name}"`);
  return el;
}
