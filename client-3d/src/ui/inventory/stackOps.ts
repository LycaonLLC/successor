import {
  authorityIssuedAtServerTick,
  enqueueAuthorityDiscardStackCommand,
  enqueueAuthorityMergeStacksCommand,
  enqueueAuthoritySplitStackCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { createRejectWatcher } from "../windows/defs/commandReceipts";
import { isLocalInventoryContainer } from "./data";
import { getDefaultSplitSnap, SPLIT_SNAP_STEPS, type SplitSnapStep } from "./splitPrefs";
import type { InventoryItemVM } from "./types";

/**
 * Stack operations UI — SPLIT dialog, drag-to-MERGE and two-step DISCARD,
 * mounted into the inventory window's root (owner spec, 2026-07-03):
 *
 *  - SPLIT: radial action → in-window dialog with a SNAPPING slider
 *    (steps 1/5/10/100/1K/10K; default step from OPTIONS via splitPrefs),
 *    live readout, CONFIRM enqueues `SplitStack`.
 *  - MERGE: pointer-drag a stack onto a same-item+variant stack in the
 *    same container → `MergeStacks` (server merges to the 100k cap and
 *    leaves the remainder in the source — 90k+20k → 100k+10k).
 *  - DISCARD: two-step in-window confirmation — the first activation ARMS
 *    (~2.6s window, names the exact item and quantity), the second enqueues
 *    `DiscardStack` (deletes the entire exact carried stack). Timeout
 *    disarms. Only owned, server-backed stacks are eligible.
 *
 * The server is the only authority on outcomes; this module only issues
 * commands and surfaces accepted/DENIED receipts (scoped watchers).
 */

export interface StackOpsDeps {
  root: HTMLElement;
  grid: HTMLElement;
  state: PlayState;
  slice: SliceSnapshot;
  findItem: (key: string) => InventoryItemVM | null;
  flashStatus: (message: string) => void;
}

export interface StackOpsHandle {
  /** Open the split dialog for a splittable stack (no-op when not splittable). */
  openSplit(key: string): void;
  /** True when the stack may advertise DISCARD (owned, exact, server-backed). */
  discardEligible(item: InventoryItemVM | null): boolean;
  /** Two-step discard: first call arms, second call within the window enqueues. */
  activateDiscard(key: string): void;
  /** Key of the armed stack, or null — poll() disarms on timeout. */
  armedDiscardKey(): string | null;
  /** Receipt feedback for SplitStack/MergeStacks/DiscardStack (call each frame). */
  poll(): string | null;
  dispose(): void;
}

const DRAG_THRESHOLD_PX = 6;
/** Native drag tag for carried stacks: the SLOT KEY, resolved live by drop
 * targets (trade, bank). Exported so the shell emits it in its own dragstart
 * instead of leaning on this module's listener registration order. */
export const DRAG_STACK_KEY = "text/x-sc3d-inventory-stack";
/** Confirm window for the two-step DISCARD (arm → confirm). */
export const DISCARD_ARM_MS = 2600;


export type StackMergeValidity =
  | "valid"
  | "missing-target"
  | "missing-stack"
  | "same-stack"
  | "container-mismatch"
  | "item-mismatch"
  | "variant-mismatch";

export function stackMergeValidity(source: InventoryItemVM | null, target: InventoryItemVM | null): StackMergeValidity {
  if (!source || !target) return "missing-target";
  if (source.key === target.key) return "same-stack";
  const sourceStackId = source.row.stackId;
  const targetStackId = target.row.stackId;
  if (sourceStackId === undefined || targetStackId === undefined) return "missing-stack";
  if (String(sourceStackId) === String(targetStackId)) return "same-stack";
  if (source.row.container !== target.row.container) return "container-mismatch";
  if (source.itemId !== target.itemId) return "item-mismatch";
  if (String(source.row.variantId) !== String(target.row.variantId)) return "variant-mismatch";
  return "valid";
}

function stackMergeDeniedMessage(validity: StackMergeValidity): string {
  switch (validity) {
    case "variant-mismatch": return "DENIED · VARIANT";
    case "item-mismatch": return "DENIED · ITEM";
    case "container-mismatch": return "DENIED · CONTAINER";
    case "missing-stack": return "DENIED · STACK";
    case "same-stack": return "DENIED · SAME STACK";
    default: return "DENIED";
  }
}

export type StackDiscardEligibility =
  | "valid"
  | "missing-item"
  | "missing-stack"
  | "synthetic-gear"
  | "not-owned"
  | "equipped"
  | "reserved";

/**
 * DISCARD eligibility — pure so tests can pin the boundary: synthetic local
 * gear, rows without server stack identity, non-owned containers, equipped
 * items, and reserved/partly-unavailable stacks never advertise a
 * destructive verb (the backend rejects them; the UI stays honest first).
 */
export function stackDiscardEligibility(
  item: InventoryItemVM | null,
  isLocalContainer: (container: string) => boolean,
): StackDiscardEligibility {
  if (!item) return "missing-item";
  if (item.local) return "synthetic-gear";
  if (item.row.stackId === undefined) return "missing-stack";
  if (!isLocalContainer(item.row.container)) return "not-owned";
  if (item.equipped) return "equipped";
  if (item.row.reserved > 0 || item.row.available !== item.row.quantity) return "reserved";
  return "valid";
}
export function installStackOps(deps: StackOpsDeps): StackOpsHandle {
  const { root, grid, state, slice, findItem, flashStatus } = deps;
  const rejectWatcher = createRejectWatcher(state, ["SplitStack", "MergeStacks"]);

  // ── SPLIT dialog ─────────────────────────────────────────────────────────
  const dialog = document.createElement("div");
  dialog.className = "inv-splitdlg";
  dialog.hidden = true;
  dialog.innerHTML = `
    <div class="inv-splitdlg-card" role="dialog" aria-label="Split stack">
      <div class="inv-splitdlg-title" data-ref="title">SPLIT</div>
      <div class="inv-splitdlg-readout"><span data-ref="value">0</span><span class="inv-splitdlg-total" data-ref="total"></span></div>
      <input class="inv-splitdlg-slider" data-ref="slider" type="range" aria-label="Split amount" />
      <div class="inv-splitdlg-snaps" data-ref="snaps" role="group" aria-label="Snap step"></div>
      <div class="inv-splitdlg-actions">
        <button type="button" class="dws-btn" data-ref="confirm">SPLIT</button>
        <button type="button" class="dws-btn" data-ref="cancel">CANCEL</button>
      </div>
    </div>
  `;
  root.appendChild(dialog);
  const titleEl = mustRef(dialog, "title");
  const valueEl = mustRef(dialog, "value");
  const totalEl = mustRef(dialog, "total");
  const slider = mustRef(dialog, "slider") as HTMLInputElement;
  const snapsEl = mustRef(dialog, "snaps");
  const confirmBtn = mustRef(dialog, "confirm") as HTMLButtonElement;
  const cancelBtn = mustRef(dialog, "cancel") as HTMLButtonElement;

  let splitKey: string | null = null;
  let snap: SplitSnapStep = getDefaultSplitSnap();

  const snapButtons = new Map<number, HTMLButtonElement>();
  for (const step of SPLIT_SNAP_STEPS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scp-snapseg-btn";
    button.textContent = step >= 1000 ? `${step / 1000}K` : String(step);
    button.addEventListener("click", () => {
      snap = step;
      applySnap();
    });
    snapButtons.set(step, button);
    snapsEl.appendChild(button);
  }

  const currentItem = (): InventoryItemVM | null => (splitKey ? findItem(splitKey) : null);

  const clampToSnap = (raw: number, max: number): number => {
    const snapped = Math.round(raw / snap) * snap;
    return Math.max(1, Math.min(max, snapped || 1));
  };

  const applySnap = (): void => {
    const item = currentItem();
    if (!item) return;
    const max = item.row.available - 1;
    // Native range stepping anchors at `min` (1, 1+snap, …) which drifts
    // off clean multiples — keep native step at 1 and snap in clampToSnap.
    slider.step = "1";
    slider.value = String(clampToSnap(Number(slider.value), max));
    for (const [step, button] of snapButtons) button.toggleAttribute("data-active", step === snap);
    syncReadout();
  };

  const syncReadout = (): void => {
    const item = currentItem();
    if (!item) return;
    valueEl.textContent = Number(slider.value).toLocaleString("en-US");
    totalEl.textContent = ` / ${item.row.available.toLocaleString("en-US")}`;
  };

  const closeSplit = (): void => {
    splitKey = null;
    dialog.hidden = true;
  };

  const openSplit = (key: string): void => {
    const item = findItem(key);
    const stackId = item?.row.stackId;
    if (!item || stackId === undefined || item.row.available <= 1) return;
    splitKey = key;
    snap = getDefaultSplitSnap();
    const max = item.row.available - 1;
    titleEl.textContent = `SPLIT · ${item.label.toUpperCase()}`;
    slider.min = "1";
    slider.max = String(max);
    slider.value = String(clampToSnap(Math.floor(item.row.available / 2), max));
    dialog.hidden = false;
    applySnap();
    slider.focus();
  };

  slider.addEventListener("input", () => {
    const item = currentItem();
    if (!item) return;
    slider.value = String(clampToSnap(Number(slider.value), item.row.available - 1));
    syncReadout();
  });
  confirmBtn.addEventListener("click", () => {
    const item = currentItem();
    const stackId = item?.row.stackId;
    if (!item || stackId === undefined) {
      closeSplit();
      flashStatus("STACK GONE");
      return;
    }
    const quantity = clampToSnap(Number(slider.value), item.row.available - 1);
    const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const queued = enqueueAuthoritySplitStackCommand(
      state.authorityCommands,
      item.row.container,
      String(stackId),
      item.itemId,
      item.row.variantId,
      quantity,
      tick,
    );
    flashStatus(queued ? `SPLITTING ${quantity.toLocaleString("en-US")}` : "DENIED");
    closeSplit();
  });
  cancelBtn.addEventListener("click", closeSplit);
  dialog.addEventListener("pointerdown", (event) => {
    if (event.target === dialog) closeSplit();
  });
  dialog.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSplit();
    }
  });

  // ── Drag-to-merge ────────────────────────────────────────────────────────
  const ghost = document.createElement("div");
  ghost.className = "inv-drag-ghost";
  ghost.hidden = true;
  root.appendChild(ghost);

  let dragKey: string | null = null;
  let dragArmed = false;
  let dragActive = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragTargetSlot: HTMLButtonElement | null = null;
  let nativeDragActive = false;
  let nativeStackDragKey: string | null = null;

  const slotAt = (clientX: number, clientY: number): HTMLButtonElement | null => {
    const el = document.elementFromPoint(clientX, clientY);
    return el instanceof Element ? el.closest<HTMLButtonElement>(".inv-slot") : null;
  };

  const mergeTargetFor = (sourceKey: string, slot: HTMLButtonElement | null): InventoryItemVM | null => {
    const targetKey = slot?.dataset.key;
    if (!targetKey) return null;
    const source = findItem(sourceKey);
    const target = findItem(targetKey);
    return stackMergeValidity(source, target) === "valid" ? target : null;
  };

  const clearDropHighlight = (): void => {
    dragTargetSlot?.removeAttribute("data-drop");
    dragTargetSlot = null;
  };

  const endDrag = (): void => {
    dragKey = null;
    dragArmed = false;
    dragActive = false;
    ghost.hidden = true;
    clearDropHighlight();
  };

  const mergeStacks = (sourceKey: string, slot: HTMLButtonElement | null): void => {
    const source = findItem(sourceKey);
    const targetKey = slot?.dataset.key;
    const target = targetKey ? findItem(targetKey) : null;
    const validity = stackMergeValidity(source, target);
    if (validity !== "valid") {
      if (target && validity !== "same-stack") flashStatus(stackMergeDeniedMessage(validity));
      return;
    }
    const sourceStackId = source?.row.stackId;
    const targetStackId = target?.row.stackId;
    if (!source || !target || sourceStackId === undefined || targetStackId === undefined) return;
    const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const queued = enqueueAuthorityMergeStacksCommand(
      state.authorityCommands,
      source.row.container,
      String(sourceStackId),
      String(targetStackId),
      tick,
    );
    flashStatus(queued ? `MERGING ${source.label.toUpperCase()}` : "DENIED");
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (nativeDragActive) return;
    if (event.button !== 0) return;
    const slot = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".inv-slot") : null;
    const key = slot?.dataset.key;
    if (!key) return;
    const item = findItem(key);
    if (!item || item.row.stackId === undefined) return;
    dragKey = key;
    dragArmed = true;
    dragActive = false;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (nativeDragActive) {
      if (dragArmed) endDrag();
      return;
    }
    if (!dragArmed || dragKey === null) return;
    if (!dragActive) {
      if (Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY) < DRAG_THRESHOLD_PX) return;
      const item = findItem(dragKey);
      if (!item) {
        endDrag();
        return;
      }
      dragActive = true;
      ghost.textContent = `${item.label.toUpperCase()}${item.resource?.variantCode ? ` · ${item.resource.variantCode}` : ""} · ${item.row.available.toLocaleString("en-US")}`;
      ghost.hidden = false;
    }
    ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
    const slot = slotAt(event.clientX, event.clientY);
    const target = mergeTargetFor(dragKey, slot);
    if (dragTargetSlot !== slot) clearDropHighlight();
    if (target && slot) {
      dragTargetSlot = slot;
      slot.toggleAttribute("data-drop", true);
    }
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!dragArmed || dragKey === null) return;
    const sourceKey = dragKey;
    const wasActive = dragActive;
    const slot = slotAt(event.clientX, event.clientY);
    endDrag();
    if (!wasActive) return;
    mergeStacks(sourceKey, slot);
  };
  const onPointerCancel = (): void => {
    if (dragArmed) endDrag();
  };

  const onNativeDragStart = (event: DragEvent): void => {
    const slot = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".inv-slot") : null;
    const key = slot?.dataset.key;
    if (!key) return;
    nativeDragActive = true;
    nativeStackDragKey = null;
    endDrag();
    const item = findItem(key);
    if (!item || item.row.stackId === undefined || !event.dataTransfer) return;
    nativeStackDragKey = key;
    event.dataTransfer.setData(DRAG_STACK_KEY, key);
  };
  const onNativeDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes(DRAG_STACK_KEY)) return;
    const sourceKey = nativeStackDragKey ?? event.dataTransfer.getData(DRAG_STACK_KEY);
    if (!sourceKey) return;
    const slot = slotAt(event.clientX, event.clientY);
    const targetKey = slot?.dataset.key;
    const source = findItem(sourceKey);
    const target = targetKey ? findItem(targetKey) : null;
    const validity = stackMergeValidity(source, target);
    if (dragTargetSlot !== slot) clearDropHighlight();
    if (!slot || !target || validity === "missing-target" || validity === "same-stack") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = validity === "valid" ? "copy" : "none";
    if (validity !== "valid") return;
    dragTargetSlot = slot;
    slot.toggleAttribute("data-drop", true);
  };
  const onNativeDrop = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes(DRAG_STACK_KEY)) return;
    const sourceKey = nativeStackDragKey ?? event.dataTransfer.getData(DRAG_STACK_KEY);
    const slot = slotAt(event.clientX, event.clientY);
    const targetKey = slot?.dataset.key;
    const source = sourceKey ? findItem(sourceKey) : null;
    const target = targetKey ? findItem(targetKey) : null;
    const validity = stackMergeValidity(source, target);
    nativeDragActive = false;
    nativeStackDragKey = null;
    clearDropHighlight();
    if (!sourceKey || !target) return;
    event.preventDefault();
    if (validity !== "valid") {
      if (validity !== "same-stack") flashStatus(stackMergeDeniedMessage(validity));
      return;
    }
    mergeStacks(sourceKey, slot);
  };
  const onNativeDragEnd = (): void => {
    nativeDragActive = false;
    nativeStackDragKey = null;
    clearDropHighlight();
  };

  // ── Two-step DISCARD (arm → confirm within DISCARD_ARM_MS) ──────────────
  let discardArmedKey: string | null = null;
  let discardArmedAt = 0;

  const discardEligible = (item: InventoryItemVM | null): boolean => (
    stackDiscardEligibility(item, (container) => isLocalInventoryContainer(state, container)) === "valid"
  );

  const activateDiscard = (key: string): void => {
    const item = findItem(key);
    if (!discardEligible(item) || !item) {
      discardArmedKey = null;
      flashStatus("DENIED · NOT DISCARDABLE");
      return;
    }
    const quantity = Math.max(0, item.row.quantity).toLocaleString("en-US");
    const now = performance.now();
    if (discardArmedKey !== key || now - discardArmedAt > DISCARD_ARM_MS) {
      discardArmedKey = key;
      discardArmedAt = now;
      flashStatus(`DISCARD ${quantity} × ${item.label.toUpperCase()}? CONFIRM TO DELETE THE STACK`);
      return;
    }
    discardArmedKey = null;
    const queued = enqueueAuthorityDiscardStackCommand(
      state.authorityCommands,
      item.row.container,
      String(item.row.stackId),
      item.itemId,
      item.row.variantId,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    flashStatus(queued ? `DISCARDING ${quantity} × ${item.label.toUpperCase()}` : "DENIED");
  };

  // DiscardStack receipts speak on BOTH outcomes (a deletion deserves an
  // explicit answer); its own high-water mark so the Split/Merge reject
  // watcher stays untouched.
  let discardReceiptCommandId = state.serverAuthority.lastReceipt?.commandId ?? -1;
  const pollDiscardReceipt = (): string | null => {
    const receipt = state.serverAuthority.lastReceipt;
    if (!receipt || receipt.commandId === discardReceiptCommandId) return null;
    discardReceiptCommandId = receipt.commandId;
    const sent = state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === receipt.commandId);
    if (!sent || (sent.kind as string) !== "DiscardStack") return null;
    if (receipt.accepted) return "STACK DISCARDED";
    return `DENIED · ${(receipt.reasonCode ?? "unspecified").replaceAll("_", " ").toUpperCase()}`;
  };

  grid.addEventListener("pointerdown", onPointerDown);
  grid.addEventListener("dragstart", onNativeDragStart);
  grid.addEventListener("dragover", onNativeDragOver);
  grid.addEventListener("drop", onNativeDrop);
  grid.addEventListener("dragend", onNativeDragEnd);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);

  return {
    openSplit,
    discardEligible,
    activateDiscard,
    armedDiscardKey: () => {
      if (discardArmedKey !== null && performance.now() - discardArmedAt > DISCARD_ARM_MS) {
        discardArmedKey = null;
      }
      return discardArmedKey;
    },
    poll: () => {
      if (discardArmedKey !== null && performance.now() - discardArmedAt > DISCARD_ARM_MS) {
        discardArmedKey = null;
      }
      return pollDiscardReceipt() ?? rejectWatcher.poll();
    },
    dispose(): void {
      grid.removeEventListener("pointerdown", onPointerDown);
      grid.removeEventListener("dragstart", onNativeDragStart);
      grid.removeEventListener("dragover", onNativeDragOver);
      grid.removeEventListener("drop", onNativeDrop);
      grid.removeEventListener("dragend", onNativeDragEnd);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      dialog.remove();
      ghost.remove();
    },
  };
}

function mustRef(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`stack ops: missing data-ref="${name}"`);
  return el;
}
