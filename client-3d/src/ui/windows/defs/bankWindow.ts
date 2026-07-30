import {
  authorityIssuedAtServerTick,
  enqueueAuthorityBankDepositCreditsCommand,
  enqueueAuthorityBankRetrieveItemCommand,
  enqueueAuthorityBankStoreItemCommand,
  enqueueAuthorityBankWithdrawCreditsCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type {
  InventoryRow,
  PlayState,
  ServerAuthorityBankState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import {
  displayMetadataForRow,
  equipmentIdForInventoryRow,
  isLocalInventoryContainer,
  modelPathForItemId,
  resolveInventoryItem,
} from "../../inventory/data";
import { resourceInfoForRow } from "../../inventory/resourceInfo";
import { InventoryModelRenderer } from "../../inventory/modelRenderer";
import { CATEGORY_LABEL } from "../../inventory/shell";
import {
  activeBankTerminal,
  BANK_DRAG_MIME,
  BANK_LINK_LOST_COPY,
  type BankDragPayload,
  nearestBankTerminalInRange,
  resolveBankVaultSession,
  setActiveBankTerminal,
} from "../../inventory/bankLink";
import type {
  InventoryItemVM,
  InventoryLayoutRects,
  InventoryViewModel,
  PaperDollVM,
} from "../../inventory/types";
import { UI_ICONS } from "../../icons";
import { createRejectWatcher } from "./commandReceipts";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * BANK — the vault as a plain container grid (loot grammar, kiosk-windowed).
 *
 * One grid of what the vault holds, same slot vocabulary as the LOOT and
 * INVENTORY windows (model wells, kind chips, count badges). The inventory
 * window stays its own surface; moving stacks is pure gesture:
 *
 *   inventory double-click  → deposit the full stack   (BankStoreItem)
 *   vault double-click      → retrieve the full stack  (BankRetrieveItem)
 *   drag inventory → vault  → deposit                  (BankStoreItem)
 *   drag vault → inventory  → retrieve                 (BankRetrieveItem)
 *
 * Credits ride a compact secondary rail (exact-amount deposit / withdraw).
 * Everything is an honest affordance over the authoritative commands — the
 * client never edits balances; the server re-validates range, ownership,
 * quantity, and slot caps, and rejects flash through the receipt watcher.
 *
 * Vault truth is the owner-scoped `serverAuthority.bank` projection. `null`
 * = not streamed yet, which renders the LINKING state, never a fake empty
 * vault. Walking out of terminal reach shows LINK LOST and locks every
 * transfer gesture (server would reject them anyway).
 */

import { BANK_WINDOW_ID } from "./bankWindowIds";
export { BANK_WINDOW_ID };

const STATUS_FLASH_MS = 2600;
const STATUS_IDLE = "DOUBLE-CLICK RETRIEVES · DRAG A CARRIED STACK IN TO DEPOSIT";
/** Inventory-window stack drag mime (cross-module literal — trade precedent). */
const INVENTORY_STACK_MIME = "text/x-sc3d-inventory-stack";

interface VaultSlot {
  vm: InventoryItemVM;
  /** Wire bank stack id (u64 decimal string) — commands pass it through untouched. */
  stackId: string;
}

export function createBankWindowDefinition(deps: { sfx?: SfxPlayer } = {}): WindowDefinition {
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
    mount: (contentRoot, ctx) => mountBankContent(contentRoot, ctx, deps),
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
  locked: boolean | null;
  aria: string;
}

function mountBankContent(contentRoot: HTMLElement, ctx: WindowContext, deps: { sfx?: SfxPlayer }): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root dwl-root scp-bank";
  root.innerHTML = `
    <div class="inv-canvas-layer" data-ref="canvasLayer" aria-hidden="true"></div>
    <div class="dwl-chrome">
      <header class="dwl-head">
        <div class="dwl-head-row">
          <span class="dwl-name">VAULT</span>
          <span class="dwl-range scp-bank-link" data-ref="link">NO VAULT LINK</span>
        </div>
      </header>
      <div class="scp-bank-credits" role="group" aria-label="Vault credits">
        <div class="scp-bank-plate">
          <span class="scp-bank-plate-glyph" aria-hidden="true">${UI_ICONS["item-currency"]}</span>
          <span class="scp-bank-plate-label" id="scp-bank-wallet-label">WALLET</span>
          <span class="scp-bank-plate-value" data-ref="wallet" aria-labelledby="scp-bank-wallet-label">0</span>
        </div>
        <div class="scp-bank-plate">
          <span class="scp-bank-plate-glyph" aria-hidden="true">${UI_ICONS.bank}</span>
          <span class="scp-bank-plate-label" id="scp-bank-vault-label">VAULT</span>
          <span class="scp-bank-plate-value" data-ref="vaultCredits" aria-labelledby="scp-bank-vault-label">0</span>
        </div>
        <label class="scp-bank-amount-field">AMOUNT
          <input class="scp-bank-input" data-ref="amount" type="number" min="1" step="1" inputmode="numeric" placeholder="0" />
        </label>
        <button type="button" class="scp-bank-credit-btn" data-ref="deposit">DEPOSIT</button>
        <button type="button" class="scp-bank-credit-btn" data-ref="withdraw">WITHDRAW</button>
      </div>
      <div class="scp-bank-vault-body" data-ref="vaultBody">
        <div class="inv-grid dwl-grid" data-ref="grid" role="grid" aria-label="Vault stacks" tabindex="-1"></div>
        <div class="scp-empty scp-bank-empty" data-ref="empty" hidden>
          <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.bank}</span>
          <span data-ref="emptyText">VAULT EMPTY</span>
        </div>
      </div>
      <footer class="scp-status-foot dwl-foot">
        <span class="scp-status-line" data-ref="status">${STATUS_IDLE}</span>
      </footer>
    </div>
  `;
  contentRoot.appendChild(root);

  const canvasLayer = mustRef(root, "canvasLayer");
  const linkEl = mustRef(root, "link");
  const walletEl = mustRef(root, "wallet");
  const vaultCreditsEl = mustRef(root, "vaultCredits");
  const amountEl = mustRef(root, "amount") as HTMLInputElement;
  const depositEl = mustRef(root, "deposit") as HTMLButtonElement;
  const withdrawEl = mustRef(root, "withdraw") as HTMLButtonElement;
  const grid = mustRef(root, "grid");
  const emptyEl = mustRef(root, "empty");
  const emptyTextEl = mustRef(root, "emptyText");
  const statusEl = mustRef(root, "status");

  const modelRenderer = InventoryModelRenderer.create(canvasLayer, { state, paperDoll: false });
  const doll: PaperDollVM = { body: "male", equipmentIds: [], weaponId: null };
  const vm: InventoryViewModel = { open: true, items: [], selectedKey: null, hoveredKey: null, doll };

  const rejectWatcher = createRejectWatcher(state, [
    "BankStoreItem",
    "BankRetrieveItem",
    "BankDepositCredits",
    "BankWithdrawCredits",
  ]);

  // ── Vault VM pool — persistent per wire stack id, mutated in place ──────
  const vaultByKey = new Map<string, VaultSlot>();
  const items: InventoryItemVM[] = [];
  let vaultGeneration = 0;
  const generationBySlot = new Map<string, number>();

  const collectVaultItems = (bank: ServerAuthorityBankState): void => {
    vaultGeneration += 1;
    items.length = 0;
    for (const wire of bank.items) {
      const available = Math.max(0, Math.trunc(wire.available ?? wire.quantity));
      if (available <= 0) continue;
      const key = `vault:${wire.stackId}`;
      let slot = vaultByKey.get(key);
      if (!slot) {
        const row: InventoryRow = {
          container: wire.container,
          item: wire.item,
          itemId: wire.itemId,
          variantId: wire.variantId,
          quantity: wire.quantity,
          reserved: wire.reserved,
          available,
        };
        slot = {
          stackId: wire.stackId,
          vm: {
            key,
            itemId: wire.itemId,
            label: "",
            description: "",
            category: "item",
            count: 0,
            equipped: false,
            glb: "",
            local: false,
            equipmentId: null,
            resource: null,
            row,
          },
        };
        vaultByKey.set(key, slot);
      }
      const row = slot.vm.row;
      row.container = wire.container;
      row.item = wire.item;
      row.itemId = wire.itemId;
      row.variantId = wire.variantId;
      row.quantity = wire.quantity;
      row.reserved = wire.reserved;
      row.available = available;
      row.itemKey = wire.itemKey;
      row.metadata = wire.metadata;
      row.colors = wire.colors;
      const display = displayMetadataForRow(row);
      slot.vm.itemId = wire.itemId;
      slot.vm.label = display.label;
      slot.vm.description = display.description;
      slot.vm.category = display.category;
      slot.vm.count = available;
      slot.vm.glb = modelPathForItemId(wire.itemId);
      slot.vm.equipmentId = equipmentIdForInventoryRow(row);
      slot.vm.resource = resourceInfoForRow(row, { category: display.category, fallbackName: display.label });
      generationBySlot.set(key, vaultGeneration);
      items.push(slot.vm);
    }
    for (const [key, seen] of generationBySlot) {
      if (seen !== vaultGeneration) {
        generationBySlot.delete(key);
        vaultByKey.delete(key);
      }
    }
  };

  // ── Slot DOM (loot grammar: well + kind chip + title + count) ───────────
  const slotNodes = new Map<string, SlotNodes>();
  const applied = new Map<string, SlotApplied>();
  const publishedKeys = new Set<string>();
  const slotsMap = new Map<string, DOMRectReadOnly>();
  const rects: InventoryLayoutRects = { slots: slotsMap, doll: null, gridClip: null };

  let disposed = false;
  let statusFlashTimer = 0;
  let inReach = false;
  let live = false;

  const flashStatus = (message: string): void => {
    window.clearTimeout(statusFlashTimer);
    statusEl.textContent = message;
    statusEl.toggleAttribute("data-flash", true);
    statusFlashTimer = window.setTimeout(() => {
      statusEl.textContent = idleStatus();
      statusEl.toggleAttribute("data-flash", false);
    }, STATUS_FLASH_MS);
  };

  const deny = (message: string): void => {
    deps.sfx?.play(successorAudioIds.uiDeny);
    flashStatus(message);
  };

  const idleStatus = (): string => {
    if (!inReach) return BANK_LINK_LOST_COPY;
    if (!live) return "LINKING VAULT…";
    return STATUS_IDLE;
  };

  /** null when transfers may go; deny copy otherwise. */
  const transferDenialReason = (): string | null => {
    if (!inReach) return BANK_LINK_LOST_COPY;
    if (!live) return "LINKING VAULT…";
    return null;
  };

  const createSlot = (item: InventoryItemVM, stackId: string): void => {
    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "inv-slot";
    slot.dataset.key = item.key;
    slot.dataset.stack = stackId;
    slot.draggable = true;
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
    applied.set(item.key, { category: "", count: "\u0000", title: "\u0000", locked: null, aria: "\u0000" });
  };
  const reconcileSlots = (): void => {
    for (const item of items) {
      if (!slotNodes.has(item.key)) createSlot(item, vaultByKey.get(item.key)!.stackId);
    }
    const seen = new Set<string>();
    for (const item of items) seen.add(item.key);
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
  const diffSlots = (locked: boolean): void => {
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
        // Hover leads with the full noun — the 2-line clamp's escape hatch.
        nodes.slot.title = `${item.label} — ${item.description}`;
      }
      if (a.locked !== locked) {
        a.locked = locked;
        nodes.slot.toggleAttribute("data-locked", locked);
        nodes.slot.draggable = !locked;
      }
      // The visible noun/count spans are aria-hidden (the 3D well repeats
      // them) — the button needs an explicit accessible name: noun first,
      // then quantity, then the action this gridcell performs.
      const ariaText = `${item.label}, ${item.count} in vault — ${locked ? "link lost, transfers disabled" : "press Enter to retrieve the full stack"}`;
      if (a.aria !== ariaText) {
        a.aria = ariaText;
        nodes.slot.setAttribute("aria-label", ariaText);
      }
    }
  };

  // ── Rect publishing (device-pixel contract shared with the inventory) ───
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
    rects.gridClip = deviceRectOf(grid);
    modelRenderer.setLayoutRects(rects);
  };
  const itemSetChanged = (): boolean => {
    if (items.length !== publishedKeys.size) return true;
    for (const item of items) {
      if (!publishedKeys.has(item.key)) return true;
    }
    return false;
  };

  // ── Retrieve (vault double-click / Enter / drag-out) ────────────────────
  const retrieveStack = (key: string): boolean => {
    const slot = vaultByKey.get(key);
    if (!slot) {
      deny("STACK GONE");
      return false;
    }
    const denial = transferDenialReason();
    if (denial) {
      deny(denial);
      return false;
    }
    const queued = enqueueAuthorityBankRetrieveItemCommand(
      state.authorityCommands,
      slot.stackId,
      slot.vm.count,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    if (!queued) {
      deny("DENIED");
      return false;
    }
    deps.sfx?.play(successorAudioIds.itemTransfer);
    flashStatus(`${slot.vm.label.toUpperCase()} · RETRIEVING ${slot.vm.count}`);
    return true;
  };

  const slotFromEvent = (target: EventTarget | null): HTMLButtonElement | null => {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLButtonElement>(".inv-slot");
  };

  grid.addEventListener("dblclick", (event: MouseEvent) => {
    const key = slotFromEvent(event.target)?.dataset.key;
    if (key) retrieveStack(key);
  });
  grid.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
    const key = slotFromEvent(event.target)?.dataset.key;
    if (key) {
      event.preventDefault();
      retrieveStack(key);
    }
  });

  // Drag OUT to the inventory window — its drop intake enqueues the same
  // retrieve. The payload rides the vault-only MIME; toolbar, stackOps merge,
  // and loot intake never see it.
  grid.addEventListener("dragstart", (event: DragEvent) => {
    const slot = slotFromEvent(event.target);
    const key = slot?.dataset.key;
    const vault = key ? vaultByKey.get(key) : undefined;
    if (!vault || !event.dataTransfer) return;
    const denial = transferDenialReason();
    if (denial) {
      event.preventDefault();
      deny(denial);
      return;
    }
    const payload: BankDragPayload = {
      stackId: vault.stackId,
      quantity: vault.vm.count,
      label: vault.vm.label,
    };
    event.dataTransfer.setData(BANK_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
    slot?.setAttribute("data-dragging", "");
  });
  grid.addEventListener("dragend", (event: DragEvent) => {
    slotFromEvent(event.target)?.removeAttribute("data-dragging");
  });

  // ── Deposit intake: drop a carried inventory stack anywhere on the window.
  // The inventory grid already tags every native stack drag with the slot
  // key under INVENTORY_STACK_MIME; resolving that key against live state is
  // the honest source for stackId + available (never trust dragged counts).
  root.addEventListener("dragover", (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes(INVENTORY_STACK_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = transferDenialReason() === null ? "copy" : "none";
  });
  root.addEventListener("drop", (event: DragEvent) => {
    const raw = event.dataTransfer?.getData(INVENTORY_STACK_MIME);
    if (!raw) return;
    event.preventDefault();
    const denial = transferDenialReason();
    if (denial) {
      deny(denial);
      return;
    }
    const item = resolveInventoryItem(state, raw);
    if (!item || item.row.stackId === undefined || !isLocalInventoryContainer(state, item.row.container)) {
      deny("VAULT REFUSES THAT");
      return;
    }
    const quantity = Math.max(0, Math.trunc(item.row.available));
    if (quantity <= 0) {
      deny("STACK GONE");
      return;
    }
    const queued = enqueueAuthorityBankStoreItemCommand(
      state.authorityCommands,
      String(item.row.stackId),
      quantity,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    if (!queued) {
      deny("DENIED");
      return;
    }
    deps.sfx?.play(successorAudioIds.itemTransfer);
    flashStatus(`${item.label.toUpperCase()} · STORING ${quantity}`);
  });

  // ── Credits rail (compact, secondary) ────────────────────────────────────
  const walletCredits = (): number => {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    return Math.max(0, Math.trunc(state.serverAuthority.actors[actorId]?.credits ?? 0));
  };

  const submitCredits = (direction: "deposit" | "withdraw"): void => {
    const denial = transferDenialReason();
    if (denial) {
      deny(denial);
      return;
    }
    const amount = Number(amountEl.value);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      deny("ENTER A POSITIVE AMOUNT");
      return;
    }
    if (direction === "deposit" && amount > walletCredits()) {
      deny("INSUFFICIENT WALLET CREDITS");
      return;
    }
    const bank = state.serverAuthority.bank;
    if (direction === "withdraw" && amount > (bank?.credits ?? 0)) {
      deny("INSUFFICIENT VAULT CREDITS");
      return;
    }
    const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const queued = direction === "deposit"
      ? enqueueAuthorityBankDepositCreditsCommand(state.authorityCommands, amount, issuedAtTick)
      : enqueueAuthorityBankWithdrawCreditsCommand(state.authorityCommands, amount, issuedAtTick);
    if (!queued) {
      deny("ENTER A POSITIVE AMOUNT");
      return;
    }
    deps.sfx?.play(successorAudioIds.itemTransfer);
    flashStatus(direction === "deposit" ? `DEPOSITING ${formatCredits(amount)}` : `WITHDRAWING ${formatCredits(amount)}`);
    amountEl.value = "";
  };

  depositEl.addEventListener("click", () => submitCredits("deposit"));
  withdrawEl.addEventListener("click", () => submitCredits("withdraw"));
  amountEl.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
    event.preventDefault();
    submitCredits("deposit");
  });

  // ── Header + chrome diffing ──────────────────────────────────────────────
  const headApplied = { link: "\u0000", wallet: "\u0000", vault: "\u0000", empty: "\u0000", controls: null as boolean | null };

  return {
    update(dtSeconds: number, timeMs: number): void {
      // Dock/`/ui` open beside a terminal adopts it (only this window knows
      // it is open, so adopt-from-null lives here, not in the shared seam).
      if (activeBankTerminal() === null) {
        const nearby = nearestBankTerminalInRange(state, slice);
        if (nearby) setActiveBankTerminal(nearby);
      }
      const session = resolveBankVaultSession(state, slice);
      inReach = session.inReach;
      live = session.live;
      const bank = state.serverAuthority.bank;

      if (bank) collectVaultItems(bank);
      else {
        items.length = 0;
        vaultByKey.clear();
        generationBySlot.clear();
      }
      vm.items = items;
      if (itemSetChanged()) {
        reconcileSlots();
        publishRects();
      }
      diffSlots(transferDenialReason() !== null);

      const linkText = !inReach ? "NO VAULT LINK" : live ? "VAULT LINKED" : "LINKING VAULT…";
      if (headApplied.link !== linkText) {
        headApplied.link = linkText;
        linkEl.textContent = linkText;
        linkEl.toggleAttribute("data-denied", !inReach);
        statusEl.textContent = idleStatus();
        statusEl.toggleAttribute("data-flash", false);
        window.clearTimeout(statusFlashTimer);
      }
      const walletText = formatCredits(walletCredits());
      if (headApplied.wallet !== walletText) {
        headApplied.wallet = walletText;
        walletEl.textContent = walletText;
      }
      const vaultText = bank ? formatCredits(bank.credits) : "—";
      if (headApplied.vault !== vaultText) {
        headApplied.vault = vaultText;
        vaultCreditsEl.textContent = vaultText;
      }
      const controlsLive = transferDenialReason() === null;
      if (headApplied.controls !== controlsLive) {
        headApplied.controls = controlsLive;
        amountEl.disabled = !controlsLive;
        depositEl.disabled = !controlsLive;
        withdrawEl.disabled = !controlsLive;
      }
      const emptyText = live ? "VAULT EMPTY" : "LINKING VAULT…";
      if (headApplied.empty !== emptyText) {
        headApplied.empty = emptyText;
        emptyTextEl.textContent = emptyText;
      }
      const empty = items.length === 0;
      if (emptyEl.hidden !== !empty) emptyEl.hidden = !empty;

      const denied = rejectWatcher.poll();
      if (denied) deny(denied);
      modelRenderer.render(vm, dtSeconds, timeMs);
    },
    onResized(): void {
      schedulePublish();
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

function formatCredits(value: number): string {
  return `${Math.max(0, Math.trunc(value)).toLocaleString()} CR`;
}

function mustRef(root: HTMLElement, ref: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${ref}"]`);
  if (!el) throw new Error(`bank window: missing ref ${ref}`);
  return el;
}

function inner(slot: HTMLElement, name: string): HTMLElement {
  const el = slot.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`bank window: missing slot ref ${name}`);
  return el;
}
