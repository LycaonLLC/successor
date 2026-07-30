import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import { labelForInputCode } from "@successor/client/src/slice-core/settingsSystem";
import { UI_ICONS, type UiIconId } from "../icons";
import {
  defaultInventoryActionFor,
  dispatchInventoryAction,
  resolveInventoryItemByCatalogId,
  type InventoryActionResult,
} from "../inventory/data";
import type { InventoryCategory, InventoryItemVM } from "../inventory/types";
import {
  TOOLBAR_DEFAULT_BINDS,
  isToolbarActionId,
  toolbarActionById,
  type ToolbarActionContext,
} from "./toolbarActions";
import {
  assignSlot,
  clearSlot,
  loadToolbarDoc,
  moveOrSwapSlot,
  type ToolbarDoc,
  type ToolbarSlotRef,
} from "./toolbarStore";
/**
 * TOOLBAR — 12 square, icon-only slots, bottom-center, grouped in fours
 * (owner spec 2026-07-04: established sandbox-style action bar; blank by default; assignments
 * come from the Action Browser via drag-and-drop).
 *
 * Slot rendering: a square (~46px) with the action's stroke glyph centered and
 * the hotkey badge in the top-left corner. No text inside the slot — the name
 * lives in the title/tooltip. Empty slots are subtle empty squares.
 *
 * Drag-and-drop (always-free cursor):
 *   browser row → slot    : assign that action to the slot.
 *   inventory tile → slot : assign that item catalog ref to the slot.
 *   slot → slot           : move (empty target) or swap (occupied target).
 *   slot → off the bar    : clear the source slot (dragend, no drop handled).
 * Right-clicking a filled slot also clears it. Hotkeys execute against the
 * same slots without any pre-open step.
 *
 * Layout prefs persist globally (device muscle memory, not character data)
 * under one localStorage doc (schema 3; legacy v1/v2 promoted + Aim-stripped).
 * Binds are rebindable from OPTIONS via `rebindSlot` (pending-capture).
 */
export interface ToolbarController {
  /** Execute slot by index (hotkey path). True when the code was consumed. */
  pressCode: (code: string) => boolean;
  /** Options window: begin capture for slot; resolves with the new code label. */
  rebindSlot: (slot: number, onDone: (codeLabel: string | null) => void) => void;
  bindForSlot: (slot: number) => string;
  actionIdForSlot: (slot: number) => string | null;
  /** True when the slot holds ANY ref (action OR item) — occupancy, not kind. */
  slotOccupied: (slot: number) => boolean;
  setSlotAction: (slot: number, actionId: string | null) => void;
  dispose: () => void;
}

export const TOOLBAR_SLOT_COUNT = 12;
const STORAGE_KEY_V3 = "successor3d.toolbar.v3";
const STORAGE_KEY_V2 = "successor3d.toolbar.v2";
const STORAGE_KEY_LEGACY = "successor3d.toolbar.v1";
const FLASH_MS = 1600;
const PULSE_MS = 220;
const DRAG_ACTION = "text/x-sc3d-action";
const DRAG_ITEM = "text/x-sc3d-item";
const DRAG_SOURCE_SLOT = "text/x-sc3d-source-slot";

const ITEM_ICON_BY_CATEGORY: Record<InventoryCategory, UiIconId> = {
  ammo: "item-ammo",
  medical: "item-medical",
  resource: "item-resource",
  tool: "item-tool",
  gear: "item-gear",
  currency: "item-currency",
  item: "item-item",
  weapon: "item-weapon",
};

export function mountToolbar(
  shell: HTMLElement,
  state: PlayState,
  slice: SliceSnapshot,
  sfx: SfxPlayer,
  hooks: { openWindow: (id: string) => void },
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = window.localStorage,
): ToolbarController {
  const doc: ToolbarDoc = loadToolbarDoc(
    storage.getItem(STORAGE_KEY_V3),
    storage.getItem(STORAGE_KEY_V2),
    storage.getItem(STORAGE_KEY_LEGACY),
    { slotCount: TOOLBAR_SLOT_COUNT, defaultBinds: TOOLBAR_DEFAULT_BINDS },
    isToolbarActionId,
  );

  const save = (): void => {
    try {
      storage.setItem(STORAGE_KEY_V3, JSON.stringify({ schema: 3, ...doc }));
      // Promote away from older keys once schema 3 is written.
      storage.removeItem(STORAGE_KEY_V2);
      storage.removeItem(STORAGE_KEY_LEGACY);
    } catch {
      // Storage quota/denied never breaks gameplay.
    }
  };

  const bar = document.createElement("nav");
  bar.className = "sc3d-toolbar";
  bar.setAttribute("aria-label", "Action toolbar");
  shell.appendChild(bar);

  const flashLine = document.createElement("div");
  flashLine.className = "sc3d-toolbar-flash";
  flashLine.hidden = true;
  shell.appendChild(flashLine);

  let flashTimer = 0;
  const flash = (message: string, ok: boolean): void => {
    flashLine.textContent = message;
    flashLine.hidden = false;
    flashLine.toggleAttribute("data-bad", !ok);
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashLine.hidden = true;
    }, FLASH_MS);
  };

  const actionContext = (): ToolbarActionContext => ({
    state,
    slice,
    sfx,
    openWindow: hooks.openWindow,
  });

  const pulse = (slot: number, ok: boolean): void => {
    const chip = bar.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    if (!chip) return;
    const cls = ok ? "sc3d-toolbar-slot--pulse" : "sc3d-toolbar-slot--deny";
    chip.classList.remove("sc3d-toolbar-slot--pulse", "sc3d-toolbar-slot--deny");
    void chip.offsetWidth;
    chip.classList.add(cls);
    window.setTimeout(() => chip.classList.remove(cls), PULSE_MS);
  };

  const inventoryReceipt = (result: InventoryActionResult, item: InventoryItemVM): string => {
    if (result === "equipped") return `${item.label} · EQUIPPED`;
    if (result === "unequipped") return `${item.label} · UNEQUIPPED`;
    if (result === "used") return `${item.label} · USED`;
    if (result === "placed") return `${item.label} · DEPLOYED`;
    if (result === "opened") return `${item.label} · OPENED`;
    if (result === "examined") return `${item.label} · EXAMINED`;
    if (result === "redeemed") return `${item.label} · REDEEMED`;
    return `${item.label} · DENIED`;
  };

  const executeItemSlot = (slot: number, itemId: string): void => {
    const item = resolveInventoryItemByCatalogId(state, itemId);
    if (!item) {
      sfx.play(successorAudioIds.uiDeny);
      flash("ITEM UNAVAILABLE", false);
      pulse(slot, false);
      refreshSlot(slot);
      return;
    }
    const actionId = defaultInventoryActionFor(item, state);
    if (!actionId) {
      sfx.play(successorAudioIds.uiDeny);
      flash(`${item.label} · NO DEFAULT`, false);
      pulse(slot, false);
      return;
    }
    const result = dispatchInventoryAction(state, slice, item, actionId);
    const ok = result !== "unsupported";
    sfx.play(ok ? "ui_button_tick" : successorAudioIds.uiDeny);
    flash(inventoryReceipt(result, item), ok);
    pulse(slot, ok);
    refreshSlot(slot);
  };

  const executeSlot = (slot: number): void => {
    const ref = doc.slots[slot] ?? null;
    if (!ref) {
      sfx.play(successorAudioIds.uiDeny);
      pulse(slot, false);
      return;
    }
    if (ref.kind === "item") {
      executeItemSlot(slot, ref.itemId);
      return;
    }
    const action = toolbarActionById(ref.id);
    if (!action) {
      sfx.play(successorAudioIds.uiDeny);
      pulse(slot, false);
      return;
    }
    const result = action.execute(actionContext());
    sfx.play(result.ok ? "ui_button_tick" : successorAudioIds.uiDeny);
    flash(result.receipt, result.ok);
    pulse(slot, result.ok);
  };

  // ── Rendering ─────────────────────────────────────────────────────────────
  const slotElement = (slot: number): HTMLElement | null =>
    bar.querySelector<HTMLElement>(`[data-slot="${slot}"]`);

  const renderSlotInner = (slot: number, el: HTMLElement): void => {
    const ref = doc.slots[slot] ?? null;
    const bind = labelForInputCode(doc.binds[slot] ?? "");
    el.toggleAttribute("data-item", ref?.kind === "item");
    el.toggleAttribute("data-missing", false);
    if (!ref) {
      el.toggleAttribute("data-empty", true);
      el.draggable = false;
      el.title = `Empty slot ${slot + 1} — drag an action here from the Action Browser or an item from Inventory`;
      el.innerHTML = `<span class="sc3d-toolbar-bind">${bind}</span>`;
      return;
    }
    el.draggable = true;
    if (ref.kind === "item") {
      const item = resolveInventoryItemByCatalogId(state, ref.itemId);
      const present = Boolean(item && item.count > 0);
      const category = item?.category ?? "item";
      const countText = item && item.count > 1 ? item.count.toLocaleString("en-US") : "";
      const label = item?.label ?? "Missing item";
      el.toggleAttribute("data-empty", !present);
      el.toggleAttribute("data-missing", !present);
      el.title = present
        ? `${label} · ${bind} — drag to move, right-click to clear`
        : `${label} unavailable · ${bind} — drag to move, right-click to clear`;
      el.innerHTML =
        `<span class="sc3d-toolbar-bind">${bind}</span>` +
        `<span class="sc3d-toolbar-icon sc3d-toolbar-icon--item">${UI_ICONS[ITEM_ICON_BY_CATEGORY[category]]}</span>` +
        (countText ? `<span class="sc3d-toolbar-qty">${countText}</span>` : "");
      return;
    }
    const action = toolbarActionById(ref.id);
    el.toggleAttribute("data-empty", !action);
    el.draggable = !!action;
    el.title = action
      ? `${action.label} · ${bind} — drag to move, right-click to clear`
      : `Missing action · ${bind} — right-click to clear`;
    el.innerHTML =
      `<span class="sc3d-toolbar-bind">${bind}</span>` +
      (action ? `<span class="sc3d-toolbar-icon">${UI_ICONS[action.icon]}</span>` : "");
  };

  const refreshSlot = (slot: number): void => {
    const el = slotElement(slot);
    if (el) renderSlotInner(slot, el);
  };

  const refreshItemSlots = (): void => {
    for (let slot = 0; slot < TOOLBAR_SLOT_COUNT; slot++) {
      if (doc.slots[slot]?.kind === "item") refreshSlot(slot);
    }
  };

  const render = (): void => {
    const groups: string[] = [];
    for (let group = 0; group < 3; group++) {
      const slots: string[] = [];
      for (let i = group * 4; i < group * 4 + 4; i++) {
        slots.push(`<button type="button" class="sc3d-toolbar-slot" data-slot="${i}"></button>`);
      }
      groups.push(`<div class="sc3d-toolbar-group">${slots.join("")}</div>`);
    }
    bar.innerHTML = groups.join("");
    for (let slot = 0; slot < TOOLBAR_SLOT_COUNT; slot++) {
      const el = slotElement(slot);
      if (el) renderSlotInner(slot, el);
    }
  };
  render();
  const liveRefreshTimer = window.setInterval(refreshItemSlots, 300);

  // ── Drag-and-drop (delegated on the bar) ──────────────────────────────────
  // dragSourceSlot ≥ 0 means the current drag originated from a toolbar slot
  // (and may need clearing if it lands off-bar). dropHandled records whether a
  // drop landed somewhere meaningful (a slot or the bar body) — used by dragend
  // to decide the off-bar clear. dropHoverSlot drives the drop-target highlight.
  let dragSourceSlot = -1;
  let dropHandled = false;
  let dropHoverSlot = -1;

  const setDropHover = (slot: number): void => {
    if (slot === dropHoverSlot) return;
    if (dropHoverSlot >= 0) slotElement(dropHoverSlot)?.removeAttribute("data-drop-target");
    dropHoverSlot = slot;
    if (slot >= 0) slotElement(slot)?.setAttribute("data-drop-target", "");
  };

  const applySlotChange = (next: ToolbarSlotRef[]): void => {
    doc.slots = next;
    save();
  };

  const onDragStart = (event: DragEvent): void => {
    const slotEl = (event.target as Element | null)?.closest<HTMLElement>("[data-slot]");
    if (!slotEl || !event.dataTransfer) return; // browser-row drags carry their own payload already
    const slot = Number(slotEl.dataset.slot);
    if (!Number.isInteger(slot)) return;
    const ref = doc.slots[slot] ?? null;
    if (!ref) return;
    if (ref.kind === "action") {
      if (!toolbarActionById(ref.id)) return;
      event.dataTransfer.setData(DRAG_ACTION, ref.id);
    } else {
      event.dataTransfer.setData(DRAG_ITEM, ref.itemId);
    }
    event.dataTransfer.setData(DRAG_SOURCE_SLOT, String(slot));
    event.dataTransfer.effectAllowed = "move";
    dragSourceSlot = slot;
    dropHandled = false;
    setDropHover(-1);
  };

  const onDragOver = (event: DragEvent): void => {
    // Only react to our own drags; let everything else through untouched.
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    const types = dataTransfer.types;
    if (!types.includes(DRAG_ACTION) && !types.includes(DRAG_ITEM) && !types.includes(DRAG_SOURCE_SLOT)) return;
    // dropEffect MUST stay within the source's effectAllowed or Chromium
    // cancels the operation at release (dragover fires, drop never does):
    // browser/inventory rows allow "copy" (assign), slot drags allow "move" (rearrange).
    const fromSlot = types.includes(DRAG_SOURCE_SLOT);
    const slotEl = (event.target as Element | null)?.closest<HTMLElement>("[data-slot]");
    if (slotEl) {
      event.preventDefault();
      dataTransfer.dropEffect = fromSlot ? "move" : "copy";
      setDropHover(Number(slotEl.dataset.slot));
    } else {
      // Over the bar body (gaps) — a forgiving no-op drop zone so a slightly
      // mis-aimed release on the bar does NOT clear the dragged slot.
      event.preventDefault();
      dataTransfer.dropEffect = fromSlot ? "move" : "copy";
      setDropHover(-1);
    }
  };

  const onDrop = (event: DragEvent): void => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    const types = dataTransfer.types;
    if (!types.includes(DRAG_ACTION) && !types.includes(DRAG_ITEM) && !types.includes(DRAG_SOURCE_SLOT)) return;
    event.preventDefault();
    dropHandled = true;
    const slotEl = (event.target as Element | null)?.closest<HTMLElement>("[data-slot]");
    if (!slotEl) {
      setDropHover(-1);
      return; // landed on the bar body — intentional no-op
    }
    const to = Number(slotEl.dataset.slot);
    if (!Number.isInteger(to) || to < 0 || to >= TOOLBAR_SLOT_COUNT) {
      setDropHover(-1);
      return;
    }
    const rawSource = dataTransfer.getData(DRAG_SOURCE_SLOT);
    const from = rawSource === "" ? -1 : Number(rawSource);
    if (Number.isInteger(from) && from >= 0) {
      // slot → slot: move (empty target) or swap (occupied target).
      applySlotChange(moveOrSwapSlot(doc.slots, from, to));
      refreshSlot(from);
    } else {
      const itemId = dataTransfer.getData(DRAG_ITEM);
      const actionId = dataTransfer.getData(DRAG_ACTION);
      if (itemId) {
        // inventory → slot: assign the stable item catalog/type ref.
        applySlotChange(assignSlot(doc.slots, to, { kind: "item", itemId }));
      } else if (actionId && isToolbarActionId(actionId)) {
        // browser → slot: assign.
        applySlotChange(assignSlot(doc.slots, to, { kind: "action", id: actionId }));
      }
    }
    refreshSlot(to);
    sfx.play("ui_button_tick");
    setDropHover(-1);
  };

  const onDragEnd = (): void => {
    if (dragSourceSlot >= 0 && !dropHandled) {
      // Released off the bar entirely — pull the ref off the slot.
      applySlotChange(clearSlot(doc.slots, dragSourceSlot));
      refreshSlot(dragSourceSlot);
      sfx.play("ui_button_tick");
    }
    dragSourceSlot = -1;
    dropHandled = false;
    setDropHover(-1);
  };

  const onClick = (event: MouseEvent): void => {
    // Keep toolbar clicks out of the world-canvas input path.
    event.stopPropagation();
    const slotEl = (event.target as Element | null)?.closest<HTMLElement>("[data-slot]");
    if (!slotEl) return;
    const slot = Number(slotEl.dataset.slot);
    if (Number.isInteger(slot)) executeSlot(slot);
  };

  const onContextMenu = (event: Event): void => {
    event.preventDefault();
    const slotEl = (event.target as Element | null)?.closest<HTMLElement>("[data-slot]");
    if (!slotEl) return;
    const slot = Number(slotEl.dataset.slot);
    if (!Number.isInteger(slot) || !doc.slots[slot]) return;
    applySlotChange(clearSlot(doc.slots, slot));
    refreshSlot(slot);
    sfx.play("ui_button_tick");
  };

  bar.addEventListener("dragstart", onDragStart);
  bar.addEventListener("dragover", onDragOver);
  bar.addEventListener("drop", onDrop);
  bar.addEventListener("dragend", onDragEnd);
  bar.addEventListener("click", onClick);
  bar.addEventListener("contextmenu", onContextMenu);

  // ── Rebind capture (OPTIONS drives this) ─────────────────────────────────
  let captureCleanup: (() => void) | null = null;

  const controller: ToolbarController = {
    pressCode(code: string): boolean {
      const slot = doc.binds.indexOf(code);
      if (slot < 0) return false;
      executeSlot(slot);
      return true;
    },
    rebindSlot(slot: number, onDone: (codeLabel: string | null) => void): void {
      captureCleanup?.();
      const onCapture = (event: KeyboardEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        cleanup();
        if (event.code === "Escape") {
          onDone(null);
          return;
        }
        // Steal the code from any slot that already holds it (swap binds).
        const holder = doc.binds.indexOf(event.code);
        if (holder >= 0 && holder !== slot) doc.binds[holder] = doc.binds[slot]!;
        doc.binds[slot] = event.code;
        save();
        refreshSlot(slot);
        if (holder >= 0 && holder !== slot) refreshSlot(holder);
        onDone(labelForInputCode(event.code));
      };
      const cleanup = (): void => {
        window.removeEventListener("keydown", onCapture, true);
        captureCleanup = null;
      };
      captureCleanup = cleanup;
      window.addEventListener("keydown", onCapture, true);
    },
    bindForSlot(slot: number): string {
      return doc.binds[slot] ?? "";
    },
    actionIdForSlot(slot: number): string | null {
      const ref = doc.slots[slot] ?? null;
      return ref?.kind === "action" ? ref.id : null;
    },
    slotOccupied(slot: number): boolean {
      return (doc.slots[slot] ?? null) !== null;
    },
    setSlotAction(slot: number, actionId: string | null): void {
      if (slot < 0 || slot >= doc.slots.length) return;
      doc.slots[slot] = actionId && isToolbarActionId(actionId) ? { kind: "action", id: actionId } : null;
      save();
      refreshSlot(slot);
    },
    dispose(): void {
      captureCleanup?.();
      window.clearTimeout(flashTimer);
      window.clearInterval(liveRefreshTimer);
      bar.remove();
      flashLine.remove();
    },
  };
  return controller;
}
