import { deriveSlugthrowerStats, slugthrowerStatRows } from "./slugthrowerStats";
import type { PaperDollVM } from "./types";
import { resolveInventoryItem } from "./data";
import { InventoryModelRenderer } from "./modelRenderer";
import { CATEGORY_LABEL } from "./shell";
import { renderResourceStatRows, resourceInfoForRow } from "./resourceInfo";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windows/windowManager";
import type { InventoryItemVM, InventoryLayoutRects, InventoryViewModel } from "./types";
import { examineItemKeyRef, setExamineItem } from "./examineWindowIds";
export { setExamineItem };

/**
 * EXAMINE — a large rotating preview of one inventory item.
 *
 * Opened from the context radial's EXAMINE action (routed through the data
 * adapter's examine sink). Not in the dock (`dockVisible: false`), no hotkey.
 *
 * The item is stored as a KEY (`setExamineItem`) and re-resolved every frame
 * via `resolveInventoryItem` — a private scratch VM, never the inventory
 * window's reused VM (that one goes stale when that window closes). When the
 * item is no longer held the window keeps its position and shows an honest
 * empty state.
 *
 * Preview rendering reuses the shared turntable machinery: an
 * InventoryModelRenderer with the paper doll disabled, fed ONE full-well rect
 * — same lazy-GL pattern (no second eager context), same slot visual
 * vocabulary (containers / normalized GLBs / icon cards), ~3× slot scale by
 * virtue of the well size. GL is disposed with the window content.
 */

const EMPTY_STATE_TEXT = "ITEM NO LONGER HELD";


export function createExamineWindowDefinition(): WindowDefinition {
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
      // Right-of-center: clear of the inventory window's centered default.
      const x = Math.min(Math.max(0, viewport.w - w - 96), Math.round(viewport.w * 0.64));
      const y = Math.round(Math.max(0, (viewport.h - h) / 2 - 40));
      return { x, y, w, h };
    },
    mount: (contentRoot, ctx) => mountExamineContent(contentRoot, ctx),
  };
}

function mountExamineContent(contentRoot: HTMLElement, ctx: WindowContext): WindowContentHandle {
  const root = document.createElement("div");
  root.className = "exm-root";
  root.innerHTML = `
    <div class="exm-well" data-ref="well" aria-hidden="true"></div>
    <div class="exm-info" data-ref="info">
      <span class="exm-name" data-ref="name">\u2014</span>
      <div class="exm-meta">
        <span class="exm-cat" data-ref="cat"></span>
        <span class="exm-count" data-ref="count"></span>
        <span class="exm-variant" data-ref="variant" hidden></span>
      </div>
      <p class="exm-desc" data-ref="desc"></p>
      <div class="exm-stats" data-ref="stats" hidden></div>
    </div>
    <div class="exm-empty" data-ref="empty" hidden>${EMPTY_STATE_TEXT}</div>
  `;
  contentRoot.appendChild(root);

  const well = ref(root, "well");
  const info = ref(root, "info");
  const nameEl = ref(root, "name");
  const catEl = ref(root, "cat");
  const countEl = ref(root, "count");
  const variantEl = ref(root, "variant");
  const descEl = ref(root, "desc");
  const statsEl = ref(root, "stats");
  const emptyEl = ref(root, "empty");

  // Dedicated turntable renderer: no paper doll, one full-well rect.
  const modelRenderer = InventoryModelRenderer.create(well, { state: ctx.state, paperDoll: false, slotDragHost: well });

  const slotsMap = new Map<string, DOMRectReadOnly>();
  const rects: InventoryLayoutRects = { slots: slotsMap, doll: null, gridClip: null };
  const doll: PaperDollVM = { body: "male", equipmentIds: [], weaponId: null };
  const vm: InventoryViewModel = { open: true, items: [], selectedKey: null, hoveredKey: null, doll };

  let disposed = false;
  let publishedKey: string | null = null;

  const applied = {
    name: "\u0000",
    cat: "\u0000",
    count: "\u0000",
    desc: "\u0000",
    variant: "\u0000",
    stats: "\u0000",
    empty: false,
  };

  let publishScheduled = false;
  const schedulePublish = (): void => {
    if (publishScheduled || disposed) return;
    publishScheduled = true;
    requestAnimationFrame(() => {
      publishScheduled = false;
      publishedKey = null; // force re-publish with fresh geometry
    });
  };

  // Canvas dims recorded at publish time: the lazy GL canvas starts at the
  // 300×150 default and only gets its real size on the first render, so the
  // first publish is computed under a wrong scale. Recording the dims lets
  // update() detect the resize on the next frame and republish — the rect
  // converges without per-frame layout reads.
  let publishedCanvasW = 0;
  let publishedCanvasH = 0;

  const publishWellRect = (key: string): void => {
    const canvas = modelRenderer.canvas;
    const wellRect = well.getBoundingClientRect();
    let scaleX: number;
    let scaleY: number;
    if (canvas.width > 0 && wellRect.width > 0) {
      scaleX = canvas.width / wellRect.width;
      scaleY = canvas.height / wellRect.height;
    } else {
      const dpr = window.devicePixelRatio || 1;
      scaleX = dpr;
      scaleY = dpr;
    }
    slotsMap.clear();
    // Inset the turntable a touch so the model never kisses the hairline.
    const inset = 6;
    slotsMap.set(key, new DOMRect(
      inset * scaleX,
      inset * scaleY,
      Math.max(1, (wellRect.width - inset * 2) * scaleX),
      Math.max(1, (wellRect.height - inset * 2) * scaleY),
    ));
    rects.doll = null;
    modelRenderer.setLayoutRects(rects);
    publishedKey = key;
    publishedCanvasW = canvas.width;
    publishedCanvasH = canvas.height;
  };

  const needsPublish = (key: string): boolean => {
    if (publishedKey !== key) return true;
    const canvas = modelRenderer.canvas;
    return canvas.width !== publishedCanvasW || canvas.height !== publishedCanvasH;
  };

  const showEmpty = (empty: boolean): void => {
    if (applied.empty === empty) return;
    applied.empty = empty;
    emptyEl.hidden = !empty;
    info.style.visibility = empty ? "hidden" : "visible";
  };

  const diffInfo = (item: InventoryItemVM): void => {
    const spawn = item.category === "resource"
      ? ctx.state.serverAuthority.resourceSpawns.find(
        (candidate) => String(candidate.variantId) === String(item.row.variantId),
      ) ?? null
      : null;
    const resource = item.category === "resource"
      ? resourceInfoForRow(item.row, { category: item.category, fallbackName: item.label, spawn })
      : null;
    const displayName = resource?.displayName ?? item.label;
    if (applied.name !== displayName) {
      applied.name = displayName;
      nameEl.textContent = displayName;
    }
    const catText = CATEGORY_LABEL[item.category];
    if (applied.cat !== catText) {
      applied.cat = catText;
      catEl.textContent = catText;
    }
    const variantText = resource?.variantCode ? `VAR ${resource.variantCode}` : "";
    if (applied.variant !== variantText) {
      applied.variant = variantText;
      variantEl.textContent = variantText;
      variantEl.hidden = variantText === "";
    }
    const countText = item.count > 1 ? `QTY ${item.count}` : "QTY 1";
    if (applied.count !== countText) {
      applied.count = countText;
      countEl.textContent = countText;
    }
    const descText = resource?.taxonomySubtitle ?? item.description;
    if (applied.desc !== descText) {
      applied.desc = descText;
      descEl.textContent = descText;
    }
    const actorId = ctx.state.serverAuthority.playerActorId ?? ctx.state.playerActorId;
    const equippedWeapon = ctx.state.serverAuthority.actors[actorId]?.weapon;
    const equippedVariant = equippedWeapon && typeof equippedWeapon === "object" && "weaponVariantId" in equippedWeapon
      ? typeof equippedWeapon.weaponVariantId === "number" ? equippedWeapon.weaponVariantId : 0
      : 0;
    const isSlugthrower = item.itemId === 3101;
    const slugthrowerRange = ctx.slice.combatTuning?.weaponRangeBands?.slugthrower;
    const statsKey = isSlugthrower
      ? `${item.row.variantId}:${equippedVariant}:${slugthrowerRange?.pointBlankCells ?? "-"}:${slugthrowerRange?.idealCells ?? "-"}:${slugthrowerRange?.maxCells ?? "-"}`
      : resource?.stats.map((stat) => `${stat.key}:${stat.value}`).join(",") ?? "";
    if (applied.stats !== statsKey) {
      applied.stats = statsKey;
      if (isSlugthrower) {
        statsEl.hidden = false;
        statsEl.textContent = "";
        const equipped = item.row.variantId === equippedVariant ? null : deriveSlugthrowerStats(equippedVariant);
        for (const row of slugthrowerStatRows(deriveSlugthrowerStats(item.row.variantId), equipped, slugthrowerRange)) {
          const line = document.createElement("div");
          line.className = "exm-stat-row";
          line.textContent = `${row.label}: ${row.value}`;
          statsEl.appendChild(line);
        }
      } else {
        renderResourceStatRows(statsEl, resource?.stats ?? null);
      }
    }
  };

  return {
    update(dtSeconds: number, timeMs: number): void {
      const key = examineItemKeyRef();
      const item = key ? resolveInventoryItem(ctx.state, key) : null;
      if (!item || !key) {
        showEmpty(true);
        vm.open = false; // hides + idles the turntable canvas
        modelRenderer.render(vm, dtSeconds, timeMs);
        return;
      }
      showEmpty(false);
      diffInfo(item);
      if (needsPublish(key)) {
        vm.items = [item];
        publishWellRect(key);
      } else {
        vm.items[0] = item;
      }
      vm.open = true;
      modelRenderer.render(vm, dtSeconds, timeMs);
    },
    onResized(): void {
      schedulePublish();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      modelRenderer.dispose();
      root.remove();
    },
  };
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`examine window: missing data-ref="${name}"`);
  return el;
}
