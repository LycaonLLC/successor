import {
  authorityIssuedAtServerTick,
  enqueueAuthorityCorpseTakeCreditsCommand,
  enqueueAuthorityTakeLootItemCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import { enqueueTakeAllLootStacks } from "@successor/client/src/slice-core/interactionSystem";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import {
  collectInventoryItems,
  createCollectedItemsScratch,
  dispatchInventoryAction,
} from "../../inventory/data";
import { LOOT_DRAG_MIME, type LootDragPayload } from "../../inventory/lootDrag";
import { InventoryModelRenderer } from "../../inventory/modelRenderer";
import { CATEGORY_LABEL } from "../../inventory/shell";
import type {
  InventoryItemVM,
  InventoryLayoutRects,
  InventoryViewModel,
  PaperDollVM,
} from "../../inventory/types";
import { UI_ICONS } from "../../icons";
import { cleanActorName } from "../../hud/actorNames";
import type { ContextRadial } from "../contextRadial";
import { createRejectWatcher } from "./commandReceipts";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * LOOT — one salvage surface for corpses AND loot caches (owner spec
 * 2026-07-05: "loot menu should be same for bodies and containers").
 *
 * The window is the player INVENTORY grid vocabulary minus the paper doll:
 * same slot tiles, same turntable thumbnails (own doll-less renderer, the
 * datapad precedent), same examine route. Items live in the target's
 * streamed container rows (`corpse:<actorId>` / `cache:<propId>`); every
 * mutation is the authoritative per-stack `TakeLootItem` command — this
 * module never edits inventory locally.
 *
 * Take paths: double-click / Enter / radial TAKE / drag the tile out onto
 * the inventory window. Nothing can be inserted: the grid accepts no drops,
 * and the BE rejects writes into loot containers anyway.
 *
 * Honest affordances: rights (damage-based, server-frozen) and reach gate
 * the take actions CLIENT-side with the reason on the header/status line;
 * the server re-validates everything (loot_* rejection codes stream back
 * through command receipts).
 */

import {
  LOOT_WINDOW_ID,
  lootTargetRef,
  setLootTarget,
  type LootTarget,
} from "./lootWindowIds";
export { LOOT_WINDOW_ID, lootTargetRef, setLootTarget, type LootTarget };

function lootContainerIdFor(target: LootTarget): string {
  return target.kind === "cache" ? (target.container ?? `cache:${target.id}`) : `corpse:${target.id}`;
}

/** Shared reach gate (HARVEST_INTERACTION_RADIUS on the sim side). */
const LOOT_REACH_CELLS = 1.75;
const STATUS_FLASH_MS = 1400;
const STATUS_IDLE = "DOUBLE-CLICK TO TAKE";

export interface LootWindowDeps {
  radial: ContextRadial;
  /** Shared page SfxPlayer for transfer/deny affordances. */
  sfx?: SfxPlayer;
}

export function createLootWindowDefinition(deps: LootWindowDeps): WindowDefinition {
  return {
    id: LOOT_WINDOW_ID,
    title: "LOOT",
    icon: "loot",
    hotkey: null,
    minWidth: 380,
    minHeight: 330,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.max(380, Math.min(520, Math.round(viewport.w * 0.3)));
      const h = Math.max(330, Math.round(viewport.h * 0.52));
      return { x: Math.round(viewport.w * 0.6), y: Math.round((viewport.h - h) / 2), w, h };
    },
    mount: (contentRoot, ctx) => mountLootContent(contentRoot, ctx, deps),
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
}

interface ResolvedTarget {
  label: string;
  containerId: string;
  /** Target still exists in the world (corpse body present / cache prop in area). */
  present: boolean;
  inReach: boolean;
  distanceCells: number | null;
  /** null = free loot; string = exclusive rights holder actor id. */
  rightsActorId: string | null;
  rightsMine: boolean;
  /** Authority ticks until the body fades (corpses only). */
  decayTicks: number | null;
  /** Player-corpse credits still on the bag (drives the TAKE CREDITS verb). */
  creditsPresent: boolean;
}

function mountLootContent(
  contentRoot: HTMLElement,
  ctx: WindowContext,
  deps: LootWindowDeps,
): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root dwl-root";
  root.innerHTML = `
    <div class="inv-canvas-layer" data-ref="canvasLayer" aria-hidden="true"></div>
    <div class="dwl-chrome">
      <header class="dwl-head">
        <div class="dwl-head-row">
          <span class="dwl-name" data-ref="name">—</span>
          <span class="dwl-decay" data-ref="decay" hidden></span>
        </div>
        <div class="dwl-head-row dwl-head-meta">
          <span class="dwl-rights" data-ref="rights"></span>
          <span class="dwl-range" data-ref="range"></span>
        </div>
      </header>
      <div class="inv-grid dwl-grid" data-ref="grid" role="grid" tabindex="-1"></div>
      <div class="scp-empty" data-ref="empty" hidden>
        <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.loot}</span>
        <span data-ref="emptyText">NOTHING REMAINS</span>
      </div>
      <footer class="scp-status-foot dwl-foot">
        <span class="scp-status-line" data-ref="status">${STATUS_IDLE}</span>
        <button type="button" class="scp-craft-btn dwl-take-credits" data-ref="takeCredits" hidden>TAKE CREDITS</button>
        <button type="button" class="scp-craft-btn scp-craft-btn--accent dwl-take-all" data-ref="takeAll">TAKE ALL</button>
      </footer>
    </div>
  `;
  contentRoot.appendChild(root);

  const canvasLayer = ref(root, "canvasLayer");
  const grid = ref(root, "grid");
  const emptyEl = ref(root, "empty");
  const emptyTextEl = ref(root, "emptyText");
  const statusEl = ref(root, "status");
  const takeAllEl = ref(root, "takeAll") as HTMLButtonElement;
  const takeCreditsEl = ref(root, "takeCredits") as HTMLButtonElement;
  const nameEl = ref(root, "name");
  const decayEl = ref(root, "decay");
  const rightsEl = ref(root, "rights");
  const rangeEl = ref(root, "range");

  const modelRenderer = InventoryModelRenderer.create(canvasLayer, { state, paperDoll: false });
  const scratch = createCollectedItemsScratch();
  const doll: PaperDollVM = { body: "male", equipmentIds: [], weaponId: null };
  const vm: InventoryViewModel = { open: true, items: [], selectedKey: null, hoveredKey: null, doll };

  const slotNodes = new Map<string, SlotNodes>();
  const applied = new Map<string, SlotApplied>();
  const publishedKeys = new Set<string>();
  const slotsMap = new Map<string, DOMRectReadOnly>();
  const rects: InventoryLayoutRects = { slots: slotsMap, doll: null, gridClip: null };
  const headApplied = { name: "\u0000", decay: "\u0000", rights: "\u0000", range: "\u0000", empty: "\u0000" };

  let disposed = false;
  let statusFlashTimer = 0;
  let resolved: ResolvedTarget | null = null;
  const rejectWatcher = createRejectWatcher(state, ["TakeLootItem", "CorpseTakeCredits"]);

  const flashStatus = (message: string): void => {
    window.clearTimeout(statusFlashTimer);
    statusEl.textContent = message;
    statusEl.toggleAttribute("data-flash", true);
    statusFlashTimer = window.setTimeout(() => {
      statusEl.textContent = STATUS_IDLE;
      statusEl.toggleAttribute("data-flash", false);
    }, STATUS_FLASH_MS);
  };

  // ── Target resolution (per frame; cheap field reads) ─────────────────────
  const playerPosition = (): { areaId: string; x: number; y: number } => {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const actor = state.serverAuthority.actors[actorId];
    if (actor) return { areaId: actor.areaId, x: actor.x, y: actor.y };
    return { areaId: state.activeAreaId, x: state.player.x, y: state.player.y };
  };

  const resolveTarget = (): ResolvedTarget | null => {
    const target = lootTargetRef();
    if (!target) return null;
    const containerId = target.kind === "cache"
      ? slice.props?.find((prop) => prop.id === target.id)?.container
        ?? target.container
        ?? `cache:${target.id}`
      : `corpse:${target.id}`;
    const me = playerPosition();
    const myActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    if (target.kind === "corpse") {
      const actor = state.serverAuthority.actors[target.id];
      // A corpse is present while the body renders: downed + same area.
      // "respawning" (body faded) or a missing/revived actor = target lost.
      const present = Boolean(actor && actor.areaId === me.areaId && actor.lifeState === "downed");
      const distance = actor && present ? Math.hypot(me.x - actor.x, me.y - actor.y) : null;
      const rightsActorId = actor?.lootRightsActorId ?? null;
      const estimatedTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
      const decayTicks = typeof actor?.bodyVanishTick === "number" && actor.bodyVanishTick > 0
        ? Math.max(0, actor.bodyVanishTick - estimatedTick)
        : null;
      return {
        label: cleanActorName(actor, target.id),
        containerId,
        present,
        inReach: distance !== null && distance <= LOOT_REACH_CELLS,
        distanceCells: distance,
        rightsActorId,
        rightsMine: rightsActorId === null || rightsActorId === myActorId,
        decayTicks,
        creditsPresent: false,
      };
    }
    if (target.kind === "playerCorpse") {
      // Player corpse bags stream as AOI public snapshots, not actors.
      const corpse = state.serverAuthority.playerCorpses.find((candidate) => candidate.id === target.id) ?? null;
      const present = Boolean(corpse && corpse.areaId === me.areaId);
      const distance = corpse && present ? Math.hypot(me.x - corpse.x, me.y - corpse.y) : null;
      const estimatedTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
      return {
        label: corpse ? `${corpse.ownerLabel} — Remains` : "Remains",
        containerId: corpse?.container ?? containerId,
        present,
        inReach: distance !== null && distance <= LOOT_REACH_CELLS,
        distanceCells: distance,
        // Public salvage the moment the bag exists (no owner lock).
        rightsActorId: null,
        rightsMine: true,
        decayTicks: corpse ? Math.max(0, corpse.expiryTick - estimatedTick) : null,
        creditsPresent: Boolean(corpse?.creditsPresent),
      };
    }
    const prop = slice.props.find((candidate) => candidate.id === target.id && candidate.areaId === me.areaId) ?? null;
    const center = prop ? { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h / 2 } : null;
    const distance = center ? Math.hypot(me.x - center.x, me.y - center.y) : null;
    return {
      label: prop?.label || "Supply Cache",
      containerId,
      present: prop !== null,
      inReach: distance !== null && distance <= LOOT_REACH_CELLS,
      distanceCells: distance,
      rightsActorId: null,
      rightsMine: true,
      decayTicks: null,
      creditsPresent: false,
    };
  };

  const isLootRow = (container: string): boolean => {
    const id = resolved?.containerId;
    if (!id) return false;
    return container === id || container.startsWith(`${id}:`) || container.startsWith(`${id}/`);
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
    applied.set(item.key, { category: "", count: "\u0000", title: "\u0000", locked: null });
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
  const diffSlots = (items: readonly InventoryItemVM[], locked: boolean): void => {
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
    }
  };

  // ── Take dispatch (double-click / Enter / radial / drag-out) ─────────────
  const findItem = (key: string): InventoryItemVM | null => {
    for (const item of vm.items) {
      if (item.key === key) return item;
    }
    return null;
  };

  const takeDenialReason = (): string | null => {
    if (!resolved || !resolved.present) return "TARGET LOST";
    if (!resolved.rightsMine) return "NO LOOT RIGHTS";
    if (!resolved.inReach) return "OUT OF REACH";
    return null;
  };

  const takeStack = (key: string): boolean => {
    const item = findItem(key);
    if (!item) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("ITEM GONE");
      return false;
    }
    const denial = takeDenialReason();
    if (denial) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus(`DENIED · ${denial}`);
      return false;
    }
    const queued = enqueueAuthorityTakeLootItemCommand(
      state.authorityCommands,
      item.row.container,
      item.itemId,
      item.row.variantId,
      item.count,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    if (!queued) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("DENIED");
      return false;
    }
    deps.sfx?.play(successorAudioIds.itemTransfer);
    flashStatus(`${item.label.toUpperCase()} · TAKING ${item.count > 1 ? item.count : 1}`);
    return true;
  };

  // TAKE ALL — the whole container in one gesture (owner ruling). Same client
  // loop as HOLD-F (enqueueTakeAllLootStacks: one TakeLootItem per stack),
  // honest-gated on reach/rights, server re-validates each take.
  const takeAll = (): void => {
    const denial = takeDenialReason();
    if (denial) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus(`DENIED · ${denial}`);
      return;
    }
    const container = resolved?.containerId;
    if (!container || vm.items.length === 0) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("NOTHING REMAINS");
      return;
    }
    const queued = enqueueTakeAllLootStacks(state, slice, container);
    if (queued > 0) {
      deps.sfx?.play(successorAudioIds.itemTransfer);
      flashStatus(`TAKING ALL · ${queued} STACK${queued === 1 ? "" : "S"}`);
    } else {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("DENIED");
    }
  };
  takeAllEl.addEventListener("click", takeAll);

  // TAKE CREDITS — player-corpse bags only: one atomic authoritative sweep of
  // every credit still on the bag (`CorpseTakeCredits`); items stay per-stack.
  const takeCredits = (): void => {
    const target = lootTargetRef();
    if (!target || target.kind !== "playerCorpse") return;
    const denial = takeDenialReason();
    if (denial) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus(`DENIED · ${denial}`);
      return;
    }
    if (!resolved?.creditsPresent) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("NO CREDITS LEFT");
      return;
    }
    const queued = enqueueAuthorityCorpseTakeCreditsCommand(
      state.authorityCommands,
      target.id,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    if (!queued) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("DENIED");
      return;
    }
    deps.sfx?.play(successorAudioIds.itemTransfer);
    flashStatus("TAKING CREDITS");
  };
  takeCreditsEl.addEventListener("click", takeCredits);

  const slotFromEvent = (target: EventTarget | null): HTMLButtonElement | null => {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLButtonElement>(".inv-slot");
  };

  grid.addEventListener("dblclick", (event: MouseEvent) => {
    const key = slotFromEvent(event.target)?.dataset.key;
    if (key) takeStack(key);
  });
  grid.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
    const key = slotFromEvent(event.target)?.dataset.key;
    if (key) {
      event.preventDefault();
      takeStack(key);
    }
  });

  // Drag OUT to the inventory window (its loot-drop zone enqueues the same
  // take). The payload rides a loot-only MIME type; the toolbar and stackOps
  // never see it. Drops INTO this grid are not accepted anywhere.
  grid.addEventListener("dragstart", (event: DragEvent) => {
    const slot = slotFromEvent(event.target);
    const key = slot?.dataset.key;
    if (!key || !event.dataTransfer) return;
    const item = findItem(key);
    const denial = takeDenialReason();
    if (!item || denial) {
      event.preventDefault();
      if (denial) flashStatus(`DENIED · ${denial}`);
      return;
    }
    const payload: LootDragPayload = {
      container: item.row.container,
      itemId: item.itemId,
      variantId: item.row.variantId,
      quantity: item.count,
      label: item.label,
    };
    event.dataTransfer.setData(LOOT_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
    slot?.setAttribute("data-dragging", "");
  });
  grid.addEventListener("dragend", (event: DragEvent) => {
    slotFromEvent(event.target)?.removeAttribute("data-dragging");
  });

  grid.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();
    const key = slotFromEvent(event.target)?.dataset.key;
    if (!key) {
      deps.radial.close();
      return;
    }
    const item = findItem(key);
    if (!item) return;
    const denial = takeDenialReason();
    deps.radial.openFor(event.clientX, event.clientY, [
      { id: "take", label: "TAKE", enabled: denial === null, note: denial },
      { id: "examine", label: "EXAMINE", enabled: true, note: null },
    ], {
      onAction: (actionId) => {
        if (actionId === "take") {
          takeStack(key);
          return;
        }
        if (actionId === "examine") {
          const current = findItem(key);
          if (current) dispatchInventoryAction(state, slice, current, "examine");
        }
      },
      onDisabled: (note) => flashStatus(note ? `DENIED · ${note}` : "DENIED"),
    });
  });

  // ── Header diffing ───────────────────────────────────────────────────────
  const publishHead = (): void => {
    const name = resolved ? resolved.label.toUpperCase() : "—";
    if (headApplied.name !== name) {
      headApplied.name = name;
      nameEl.textContent = name;
    }
    const decay = resolved?.decayTicks !== null && resolved !== null && resolved.decayTicks !== undefined
      ? `FADES ${formatTicks(resolved.decayTicks, slice.tickRateHz)}`
      : "";
    if (headApplied.decay !== decay) {
      headApplied.decay = decay;
      decayEl.textContent = decay;
      decayEl.hidden = decay === "";
    }
    let rights = "OPEN SALVAGE";
    if (resolved && resolved.rightsActorId !== null) {
      rights = resolved.rightsMine
        ? "RIGHTS · YOURS"
        : `RIGHTS · ${cleanActorName(state.serverAuthority.actors[resolved.rightsActorId], resolved.rightsActorId).toUpperCase()}`;
    }
    if (headApplied.rights !== rights) {
      headApplied.rights = rights;
      rightsEl.textContent = rights;
      rightsEl.toggleAttribute("data-denied", resolved !== null && !resolved.rightsMine);
    }
    let range = "—";
    if (resolved && resolved.distanceCells !== null) {
      // Unit-free like the rest of the HUD (C18) — "0.8M" implied meters in a
      // cells world; the number alone matches the radial's range grammar.
      range = resolved.inReach ? resolved.distanceCells.toFixed(1) : "OUT OF REACH";
    }
    if (headApplied.range !== range) {
      headApplied.range = range;
      rangeEl.textContent = range;
      rangeEl.toggleAttribute("data-denied", resolved !== null && !resolved.inReach);
    }
  };

  return {
    update(dtSeconds: number, timeMs: number): void {
      resolved = resolveTarget();
      const items = resolved && resolved.present
        ? collectInventoryItems(state, (row) => isLootRow(row.container), scratch)
        : collectInventoryItems(state, () => false, scratch);
      vm.items = items;
      if (itemSetChanged(items)) {
        reconcileSlots(items);
        publishRects();
      }
      diffSlots(items, resolved !== null && !resolved.rightsMine);
      publishHead();
      const emptyText = !resolved || !resolved.present
        ? "TARGET LOST"
        : resolved.creditsPresent
          ? "NO ITEMS · CREDITS REMAIN"
          : "NOTHING REMAINS";
      const empty = items.length === 0;
      if (headApplied.empty !== emptyText) {
        headApplied.empty = emptyText;
        emptyTextEl.textContent = emptyText;
      }
      if (emptyEl.hidden !== !empty) emptyEl.hidden = !empty;
      takeAllEl.disabled = empty || takeDenialReason() !== null;
      const creditsVerb = lootTargetRef()?.kind === "playerCorpse" && resolved !== null && resolved.creditsPresent;
      if (takeCreditsEl.hidden !== !creditsVerb) takeCreditsEl.hidden = !creditsVerb;
      takeCreditsEl.disabled = !creditsVerb || takeDenialReason() !== null;
      const denied = rejectWatcher.poll();
      if (denied) flashStatus(denied);
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


function formatTicks(ticks: number, tickRateHz: number): string {
  const totalSeconds = Math.max(0, Math.round(ticks / Math.max(1, tickRateHz)));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `0:${String(seconds).padStart(2, "0")}`;
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`loot window: missing data-ref="${name}"`);
  return el;
}

function inner(slot: HTMLElement, name: string): HTMLElement {
  const el = slot.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`loot window: missing slot data-ref="${name}"`);
  return el;
}
