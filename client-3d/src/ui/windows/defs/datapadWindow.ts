import {
  authorityIssuedAtServerTick,
  enqueueAuthorityRetrieveFromExchangeCommand,
  enqueueAuthorityStoreToExchangeCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import {
  collectInventoryItems,
  createCollectedItemsScratch,
  dispatchInventoryAction,
  isDatapadRow,
} from "../../inventory/data";
import { createDraftsPane } from "../../crafting/draftsPane";
import {
  consumeFactorySchematicsOpenRequest,
  resolveFactorySession,
  setFactorySchematicsOpenListener,
} from "../../crafting/factoryLink";
import { DRAFTED_SCHEMATIC_ITEM_ID } from "../../crafting/types";
import { InventoryModelRenderer } from "../../inventory/modelRenderer";
import { CATEGORY_LABEL } from "../../inventory/shell";
import type {
  InventoryItemVM,
  InventoryLayoutRects,
  InventoryViewModel,
  PaperDollVM,
} from "../../inventory/types";
import { UI_ICONS } from "../../icons";
import { createDatapadMapPane } from "./datapadMap";
import { createWaypointsPane } from "./waypointsPane";
import type { ContextRadial } from "../contextRadial";
import { createRejectWatcher } from "./commandReceipts";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * DATAPAD — the field data terminal. Four surfaces behind a tab strip:
 *
 * MAP (default): the planetary orbital survey — live satellite bake of the
 * actual area terrain, structure markers, player blip, and the
 * server-authoritative storm systems with severity/radius/ETA telemetry
 * (see datapadMap.ts).
 *
 * WAYPOINTS: the client-side navigation marks for this boot character,
 * grouped by travel-catalog planet and live-wired to the map, radar and
 * world beam renderers.
 *
 * DATA: the REAL non-physical rows that exist today: exchange-stored stacks
 * (`district-exchange` container) and mission chits (itemId 4001), rendered
 * as an inventory-style slot grid (same tile vocabulary, own turntable
 * renderer, no paper doll). Radial: EXAMINE everywhere; RETRIEVE on
 * exchange rows, STORE on held mission chits — the only two exchange
 * commands the BE exposes. Drafted-schematic handles (5003) are excluded —
 * they render richly on their own tab.
 *
 * SCHEMATICS: the FACTORY DRAFTS shelf (crafting/draftsPane) — frozen
 * patterns minted by the CRAFT window's DRAFT SCHEMATIC exit, with
 * remaining uses, locked materials and the frozen result.
 */
export interface DatapadWindowDeps {
  radial: ContextRadial;
  /** Shared page SfxPlayer for transfer/deny affordances. */
  sfx?: SfxPlayer;
}

const STATUS_FLASH_MS = 1400;

export function createDatapadWindowDefinition(deps: DatapadWindowDeps): WindowDefinition {
  return {
    id: "datapad",
    title: "DATAPAD",
    icon: "datapad",
    hotkey: "KeyP",
    minWidth: 420,
    minHeight: 400,
    // r3: MAP tab landed (r2 bounds bump) + §1.30 cascade — a touch further
    // right so the strip's right reach clears the options/fxlab bodies.
    boundsRevision: 3,
    defaultBounds: (viewport) => {
      const w = Math.max(420, Math.round(viewport.w * 0.4));
      const h = Math.max(400, Math.round(viewport.h * 0.62));
      return { x: Math.min(viewport.w - w - 12, Math.round(viewport.w * 0.54)), y: Math.round(viewport.h * 0.14), w, h };
    },
    mount: (contentRoot, ctx) => mountDatapadContent(contentRoot, ctx, deps),
  };
}

interface SlotNodes {
  slot: HTMLButtonElement;
  well: HTMLElement;
  chip: HTMLElement;
  count: HTMLElement;
  title: HTMLElement;
}

interface SlotApplied {
  category: string;
  count: string;
  title: string;
}

function mountDatapadContent(
  contentRoot: HTMLElement,
  ctx: WindowContext,
  deps: DatapadWindowDeps,
): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root scp-datapad";
  root.innerHTML = `
    <nav class="scp-tabs" data-ref="tabs" role="tablist">
      <button type="button" class="scp-tab" data-tab="map" role="tab">MAP</button>
      <button type="button" class="scp-tab" data-tab="waypoints" role="tab">WAYPOINTS</button>
      <button type="button" class="scp-tab" data-tab="data" role="tab">DATA</button>
      <button type="button" class="scp-tab" data-tab="schematics" role="tab">SCHEMATICS</button>
    </nav>
    <div class="scp-datapad-surface" data-ref="mapHost"></div>
    <div class="scp-datapad-surface" data-ref="waypointsHost" hidden></div>
    <div class="scp-datapad-surface" data-ref="dataHost" hidden>
      <div class="inv-canvas-layer" data-ref="canvasLayer" aria-hidden="true"></div>
      <div class="scp-datapad-chrome">
        <div class="inv-grid scp-datapad-grid" data-ref="grid" role="grid" tabindex="-1"></div>
        <div class="scp-empty" data-ref="empty" hidden
          title="Exchange storage and mission chits live here.">
          <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.datapad}</span>
          <span>No data items</span>
        </div>
        <footer class="scp-status-foot">
          <span class="scp-status-line" data-ref="status"></span>
        </footer>
      </div>
    </div>
    <div class="scp-datapad-surface" data-ref="schematicsHost" hidden></div>
  `;
  contentRoot.appendChild(root);

  const tabsEl = ref(root, "tabs");
  const mapHost = ref(root, "mapHost");
  const waypointsHost = ref(root, "waypointsHost");
  const dataHost = ref(root, "dataHost");
  const schematicsHost = ref(root, "schematicsHost");
  const canvasLayer = ref(root, "canvasLayer");
  const grid = ref(root, "grid");
  const emptyEl = ref(root, "empty");
  const statusEl = ref(root, "status");

  // ── MAP surface (default): the planetary orbital survey ─────────────────
  const mapPane = createDatapadMapPane(ctx, { radial: deps.radial });
  mapHost.appendChild(mapPane.root);
  const waypointsPane = createWaypointsPane(ctx, { radial: deps.radial });
  waypointsHost.appendChild(waypointsPane.root);
  const draftsPane = createDraftsPane({ state, slice });
  schematicsHost.appendChild(draftsPane.root);
  type DatapadTab = "map" | "waypoints" | "data" | "schematics";
  let activeTab: DatapadTab = "map";
  const applyTab = (tab: DatapadTab): void => {
    activeTab = tab;
    mapHost.hidden = tab !== "map";
    waypointsHost.hidden = tab !== "waypoints";
    dataHost.hidden = tab !== "data";
    schematicsHost.hidden = tab !== "schematics";
    for (const button of tabsEl.querySelectorAll<HTMLButtonElement>(".scp-tab")) {
      button.setAttribute("aria-selected", button.dataset.tab === tab ? "true" : "false");
    }
    if (tab === "map") mapPane.onResized();
    if (tab === "waypoints") waypointsPane.onResized();
    if (tab === "schematics") draftsPane.update();
  };
  tabsEl.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".scp-tab") : null;
    const tab = button?.dataset.tab;
    if (tab === "map" || tab === "waypoints" || tab === "data" || tab === "schematics") applyTab(tab);
  });
  const openSchematicsTab = (): void => {
    applyTab("schematics");
  };
  setFactorySchematicsOpenListener(openSchematicsTab);
  if (consumeFactorySchematicsOpenRequest() || resolveFactorySession(state, slice).inReach) {
    applyTab("schematics");
  } else {
    applyTab("map");
  }

  const modelRenderer = InventoryModelRenderer.create(canvasLayer, { state, paperDoll: false });
  const scratch = createCollectedItemsScratch();
  const doll: PaperDollVM = { body: "male", equipmentIds: [], weaponId: null };
  const vm: InventoryViewModel = { open: true, items: [], selectedKey: null, hoveredKey: null, doll };

  const slotNodes = new Map<string, SlotNodes>();
  const applied = new Map<string, SlotApplied>();
  const publishedKeys = new Set<string>();
  const slotsMap = new Map<string, DOMRectReadOnly>();
  const rects: InventoryLayoutRects = { slots: slotsMap, doll: null, gridClip: null };

  let disposed = false;
  let statusFlashTimer = 0;
  // Only exchange commands may flash here (never fire/skills rejections).
  const rejectWatcher = createRejectWatcher(state, ["StoreToExchange", "RetrieveFromExchange"]);

  const flashStatus = (message: string): void => {
    window.clearTimeout(statusFlashTimer);
    statusEl.textContent = message;
    statusEl.toggleAttribute("data-flash", true);
    statusFlashTimer = window.setTimeout(() => {
      statusEl.toggleAttribute("data-flash", false);
    }, STATUS_FLASH_MS);
  };

  // ── Rect publishing (same device-pixel contract as the inventory grid) ──
  let publishScheduled = false;
  const schedulePublish = (): void => {
    if (publishScheduled || disposed) return;
    publishScheduled = true;
    requestAnimationFrame(() => {
      publishScheduled = false;
      publishRects();
    });
  };
  const deviceRectOf = (el: HTMLElement): DOMRect => {
    const canvas = modelRenderer.canvas;
    const refEl = canvas.width > 0 ? canvas : canvasLayer;
    const refRect = refEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let scaleX: number;
    let scaleY: number;
    if (canvas.width > 0 && refRect.width > 0) {
      scaleX = canvas.width / refRect.width;
      scaleY = canvas.height / refRect.height;
    } else {
      const dpr = window.devicePixelRatio || 1;
      scaleX = dpr;
      scaleY = dpr;
    }
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
    for (const [key, nodes] of slotNodes) {
      slotsMap.set(key, deviceRectOf(nodes.well));
    }
    rects.doll = null;
    modelRenderer.setLayoutRects(rects);
  };
  const itemSetChanged = (items: readonly InventoryItemVM[]): boolean => {
    if (items.length !== publishedKeys.size) return true;
    for (const item of items) {
      if (!publishedKeys.has(item.key)) return true;
    }
    return false;
  };

  // ── Slot DOM ─────────────────────────────────────────────────────────────
  const createSlot = (item: InventoryItemVM): void => {
    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "inv-slot";
    slot.dataset.key = item.key;
    slot.setAttribute("role", "gridcell");
    slot.innerHTML = `
      <span class="inv-slot-well" data-ref="well" aria-hidden="true"></span>
      <span class="inv-chip" data-ref="chip"></span>
      <span class="inv-slot-title" data-ref="title" aria-hidden="true"></span>
      <span class="inv-count" data-ref="count" aria-hidden="true"></span>
    `;
    grid.append(slot);
    slotNodes.set(item.key, {
      slot,
      well: inner(slot, "well"),
      chip: inner(slot, "chip"),
      count: inner(slot, "count"),
      title: inner(slot, "title"),
    });
    applied.set(item.key, { category: "", count: "\u0000", title: "\u0000" });
  };
  const reconcileSlots = (items: readonly InventoryItemVM[]): void => {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(item.key);
      if (!slotNodes.has(item.key)) createSlot(item);
    }
    for (const key of [...slotNodes.keys()]) {
      if (!seen.has(key)) {
        slotNodes.get(key)?.slot.remove();
        slotNodes.delete(key);
        applied.delete(key);
        publishedKeys.delete(key);
      }
    }
    publishedKeys.clear();
    for (const item of items) publishedKeys.add(item.key);
  };
  const diffSlots = (items: readonly InventoryItemVM[]): void => {
    for (const item of items) {
      const nodes = slotNodes.get(item.key);
      const a = applied.get(item.key);
      if (!nodes || !a) continue;
      const catText = CATEGORY_LABEL[item.category];
      if (a.category !== catText) {
        a.category = catText;
        nodes.chip.textContent = catText;
        nodes.slot.dataset.cat = item.category;
      }
      const countText = item.count > 1 ? `${item.count}` : "";
      if (a.count !== countText) {
        a.count = countText;
        nodes.count.textContent = countText;
        nodes.count.hidden = countText === "";
      }
      if (a.title !== item.label) {
        a.title = item.label;
        nodes.title.textContent = item.label;
      }
    }
  };

  // ── Radial: EXAMINE + RETRIEVE (exchange) / STORE (held chit) ───────────
  const findItem = (key: string): InventoryItemVM | null => {
    for (const item of vm.items) {
      if (item.key === key) return item;
    }
    return null;
  };
  grid.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();
    const slot = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".inv-slot") : null;
    const key = slot?.dataset.key;
    if (!key) {
      deps.radial.close();
      return;
    }
    const item = findItem(key);
    if (!item) return;
    const exchange = item.row.container === "district-exchange";
    deps.radial.openFor(event.clientX, event.clientY, [
      { id: "examine", label: "EXAMINE", enabled: true, note: null },
      exchange
        ? { id: "retrieve", label: "RETRIEVE", enabled: true, note: null }
        : { id: "store", label: "STORE", enabled: true, note: null },
    ], {
      onAction: (actionId) => {
        const current = findItem(key);
        if (!current) {
          deps.sfx?.play(successorAudioIds.uiDeny);
          flashStatus("ITEM GONE");
          return;
        }
        if (actionId === "examine") {
          dispatchInventoryAction(state, slice, current, "examine");
          return;
        }
        const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
        const queued = actionId === "retrieve"
          ? enqueueAuthorityRetrieveFromExchangeCommand(state.authorityCommands, current.itemId, current.row.variantId, 1, tick)
          : enqueueAuthorityStoreToExchangeCommand(state.authorityCommands, current.itemId, current.row.variantId, 1, tick);
        deps.sfx?.play(queued ? successorAudioIds.itemTransfer : successorAudioIds.uiDeny);
        flashStatus(queued
          ? `${current.label.toUpperCase()} · ${actionId === "retrieve" ? "RETRIEVING 1" : "STORING 1"}`
          : "DENIED");
      },
      onDisabled: (note) => {
        deps.sfx?.play(successorAudioIds.uiDeny);
        flashStatus(note || "DENIED");
      },
    });
  });

  return {
    update(dtSeconds: number, timeMs: number): void {
      resolveFactorySession(state, slice);
      if (consumeFactorySchematicsOpenRequest()) {
        applyTab("schematics");
      }
      if (activeTab === "map") {
        mapPane.update(timeMs);
      } else if (activeTab === "waypoints") {
        waypointsPane.update(dtSeconds, timeMs);
      } else if (activeTab === "schematics") {
        draftsPane.update();
      } else {
        // Draft handles (5003) live on the SCHEMATICS tab — richer than a tile.
        const items = collectInventoryItems(
          state,
          (row) => isDatapadRow(row) && row.itemId !== DRAFTED_SCHEMATIC_ITEM_ID,
          scratch,
        );
        vm.items = items;
        if (itemSetChanged(items)) {
          reconcileSlots(items);
          publishRects();
        }
        diffSlots(items);
        const empty = items.length === 0;
        if (emptyEl.hidden !== !empty) emptyEl.hidden = !empty;
        modelRenderer.render(vm, dtSeconds, timeMs);
      }
      // Surface NEW rejected exchange acks with the server's reason —
      // scoped to THIS window's command kinds only (any tab).
      const denied = rejectWatcher.poll();
      if (denied) flashStatus(denied);
    },
    onResized(): void {
      schedulePublish();
      mapPane.onResized();
      waypointsPane.onResized();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      setFactorySchematicsOpenListener(null);
      window.clearTimeout(statusFlashTimer);
      modelRenderer.dispose();
      mapPane.dispose();
      waypointsPane.dispose();
      draftsPane.dispose();
      root.remove();
    },
  };
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`datapad window: missing data-ref="${name}"`);
  return el;
}

function inner(slot: HTMLElement, name: string): HTMLElement {
  const el = slot.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`datapad window: missing slot data-ref="${name}"`);
  return el;
}
