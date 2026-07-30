import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import type { PropSnapshot } from "@successor/client/src/slice-core/worldTypes";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

import { examinedPropIdRef, PROP_EXAMINE_WINDOW_ID, setExaminedProp } from "./propExamineWindowIds";
export { PROP_EXAMINE_WINDOW_ID, setExaminedProp };
const EMPTY_STATE_TEXT = "CACHE LOST";
const CACHE_CONTAINER_PREFIX = "cache:";

export function createPropExamineWindowDefinition(): WindowDefinition {
  return {
    id: PROP_EXAMINE_WINDOW_ID,
    title: "PROP EXAMINE",
    icon: "examine",
    hotkey: null,
    minWidth: 270,
    minHeight: 260,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = 300;
      const h = 292;
      return { x: Math.max(12, viewport.w - w - 32), y: Math.max(48, Math.round(viewport.h * 0.28)), w, h };
    },
    mount: (contentRoot, ctx) => mountPropExamineContent(contentRoot, ctx),
  };
}

function mountPropExamineContent(contentRoot: HTMLElement, ctx: WindowContext): WindowContentHandle {
  const root = document.createElement("div");
  root.className = "txm-root pxm-root";
  root.innerHTML = `
    <section class="txm-card" data-ref="info">
      <header class="txm-head">
        <span class="txm-name" data-ref="name">—</span>
        <span class="txm-stamp" data-ref="state">—</span>
      </header>
      <div class="txm-subtitle" data-ref="subtitle">—</div>
      <div class="txm-grid">
        <span>STATE</span><strong data-ref="stateText">—</strong>
        <span>CONTENTS</span><strong data-ref="contents">—</strong>
        <span>RANGE</span><strong data-ref="range">—</strong>
      </div>
      <div class="txm-statuses" data-ref="flavor"></div>
    </section>
    <div class="txm-empty" data-ref="empty" hidden>${EMPTY_STATE_TEXT}</div>
  `;
  contentRoot.appendChild(root);

  const infoEl = ref(root, "info");
  const emptyEl = ref(root, "empty");
  const nameEl = ref(root, "name");
  const stateEl = ref(root, "state");
  const subtitleEl = ref(root, "subtitle");
  const stateTextEl = ref(root, "stateText");
  const contentsEl = ref(root, "contents");
  const rangeEl = ref(root, "range");
  const flavorEl = ref(root, "flavor");

  const applied = {
    empty: false,
    name: "\0",
    state: "\0",
    subtitle: "\0",
    stateText: "\0",
    contents: "\0",
    range: "\0",
    flavor: "\0",
  };
  let disposed = false;

  const showEmpty = (empty: boolean): void => {
    if (applied.empty === empty) return;
    applied.empty = empty;
    emptyEl.hidden = !empty;
    infoEl.style.visibility = empty ? "hidden" : "visible";
  };

  return {
    update(): void {
      const prop = resolveExaminedProp(ctx.state, ctx.slice);
      if (!prop) {
        showEmpty(true);
        return;
      }
      showEmpty(false);
      if (prop.kind === "travel_terminal") {
        publishText(nameEl, "name", prop.label || "Travel Terminal");
        publishText(stateEl, "state", "ONLINE");
        publishText(subtitleEl, "subtitle", subtitleFor(prop));
        publishText(stateTextEl, "stateText", "ONLINE");
        publishText(contentsEl, "contents", "Transit uplink");
        publishText(rangeEl, "range", rangeText(ctx.state, prop));
        publishText(flavorEl, "flavor", "A transit-authority terminal. Chart passage and print tickets.");
        return;
      }
      const emptied = cacheEmptied(ctx.state, prop.id);
      const stateText = emptied ? "EMPTIED" : "SEALED";
      const count = cacheContentCount(ctx.state, prop.id);
      publishText(nameEl, "name", prop.label || "Supply Cache");
      publishText(stateEl, "state", stateText);
      publishText(subtitleEl, "subtitle", subtitleFor(prop));
      publishText(stateTextEl, "stateText", stateText);
      publishText(contentsEl, "contents", emptied ? "Empty" : itemCountText(count));
      publishText(rangeEl, "range", rangeText(ctx.state, prop));
      publishText(flavorEl, "flavor", emptied
        ? "The lid is open. Nothing remains inside."
        : "A sealed field cache. Open it to take everything inside.");
    },
    onResized(): void {
      // The layout is pure DOM and flexes with the shared window chrome.
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.remove();
    },
  };

  function publishText(
    el: HTMLElement,
    key: "name" | "state" | "subtitle" | "stateText" | "contents" | "range" | "flavor",
    text: string,
  ): void {
    if (applied[key] === text) return;
    applied[key] = text;
    el.textContent = text;
  }
}

function resolveExaminedProp(state: PlayState, slice: SliceSnapshot): PropSnapshot | null {
  if (!examinedPropIdRef()) return null;
  return slice.props.find((prop) => prop.id === examinedPropIdRef() && prop.areaId === state.activeAreaId) ?? null;
}

function subtitleFor(prop: PropSnapshot): string {
  if (prop.kind === "storage_chest") return "FIELD SUPPLY CACHE";
  return prop.kind.replace(/[_-]+/gu, " ").toUpperCase();
}

function rangeText(state: PlayState, prop: PropSnapshot): string {
  const player = authorityPlayer(state);
  if (!player || player.areaId !== prop.areaId) return "—";
  const centerX = prop.cell.x + prop.size.w / 2;
  const centerY = prop.cell.y + prop.size.h / 2;
  // Same unit as the actor examine (meters) — one range language everywhere.
  const distance = Math.hypot(player.x - centerX, player.y - centerY);
  return `${distance.toFixed(distance < 10 ? 1 : 0)}m`;
}

function authorityPlayer(state: PlayState): { areaId: string; x: number; y: number } | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const actor = state.serverAuthority.actors[actorId];
  if (actor) return { areaId: actor.areaId, x: actor.x, y: actor.y };
  return { areaId: state.activeAreaId, x: state.player.x, y: state.player.y };
}

function cacheContentCount(state: PlayState, propId: string): number {
  const container = `${CACHE_CONTAINER_PREFIX}${propId}`;
  return state.inventory.reduce((sum, row) => {
    if (row.container !== container) return sum;
    return sum + Math.max(0, Number(row.available ?? row.quantity ?? 0));
  }, 0);
}

function itemCountText(count: number): string {
  return count === 1 ? "1 item inside" : `${count} items inside`;
}

function cacheEmptied(state: PlayState, propId: string): boolean {
  return state.serverAuthority.propStates?.[propId]?.cacheEmptied === true;
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`prop examine window: missing data-ref="${name}"`);
  return el;
}
