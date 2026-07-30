import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { isTextInputTarget } from "@successor/client/src/slice-core/inputController";
import { gameplayCodeForInput, inputActionForCode } from "@successor/client/src/slice-core/settingsSystem";
import { UI_ICONS, type UiIconId } from "../icons";
import { windowIconSvg } from "../iconRegistry";

/**
 * Desktop-style window manager — the 3D client's UI foundation (DESIGN.md).
 *
 * Windows are hairline HUD-glass panels floating over the war: 22px title
 * strip (icon · noun · ✕), drag by title, 14px corner resize grip, min-size +
 * viewport clamp, bounds persisted per window. Play continues while they are
 * open — the layer root is `pointer-events: none`, so clicks on empty space
 * fall through to the game canvas.
 *
 * Always-free cursor contract:
 *  - The UI root, dock, radial, HUD windows and normal windows stay visible
 *    and pointer-interactive; empty space still falls through to the game
 *    canvas because the layer root is `pointer-events: none`.
 *  - Esc / ✕ / hotkey-toggle FULLY close (removed from the persisted open set).
 *  - Window hotkeys register directly; no mode switch is required before
 *    opening or toggling a panel.
 *
 * Lifecycle: content mounts lazily on first visible open and keeps its DOM
 * until `dispose()` — closing a window never tears down its content handle
 * (cheap re-open, scroll preserved).
 */

export interface WindowDefinition {
  /** Stable id — dock button, hotkey routing, storage keys. */
  id: string;
  /** Title-strip text — minimal short noun (copy principle). */
  title: string;
  icon: UiIconId;
  /** `KeyboardEvent.code` (e.g. "KeyI") or null. Yields to gameplay bindings. */
  hotkey: string | null;
  minWidth: number;
  minHeight: number;
  /** Show a dock button for this window (default true). */
  dockVisible?: boolean;
  /** Never written to the persisted open set (session-scoped panes like Target
   *  Examine — restoring one at boot would float a stale TARGET LOST pane). */
  transient?: boolean;
  /** Bump to discard previously persisted bounds (default layout changed). */
  boundsRevision?: number;
  defaultBounds: (viewport: { w: number; h: number }) => { x: number; y: number; w: number; h: number };
  /** Build DOM once into contentRoot; returned handle drives per-frame updates. */
  mount(contentRoot: HTMLElement, ctx: WindowContext): WindowContentHandle;
}

export interface WindowContentHandle {
  /** Called while the window is open. */
  update(dtSeconds: number, timeMs: number): void;
  /** Content re-layout after drag-resize / restore / viewport clamp. */
  onResized(): void;
  dispose(): void;
}

export interface WindowContext {
  state: PlayState;
  slice: SliceSnapshot;
}

/** Dock-facing view of a registered window. */
export interface WindowDockEntry {
  id: string;
  title: string;
  icon: UiIconId;
  /** Effective hotkey code (null when the definition yielded to a gameplay binding). */
  hotkey: string | null;
}

export interface WindowManager {
  register(def: WindowDefinition): void;
  toggle(id: string): void;
  open(id: string): void;
  close(id: string): void;
  /** Open = in the persisted/open set. */
  isOpen(id: string): boolean;
  /** Stable IDs for privacy-safe support diagnostics (no bounds or local-storage data). */
  openWindowIds(): readonly string[];
  anyInteractiveVisible(): boolean;
  /** Per-frame fanout to visible content handles. */
  update(dtSeconds: number, timeMs: number): void;
  dispose(): void;
  /** UI root (.sc3d-ui) — the dock and context radial mount here. */
  readonly root: HTMLElement;
  /** Dock-visible windows in registration order. */
  dockEntries(): readonly WindowDockEntry[];
  /** Observe open/close transitions (dock open-state signifier). */
  subscribeOpenChanged(fn: (id: string, open: boolean) => void): () => void;
}

export interface WindowManagerOptions {
  /** Element the UI root mounts into (the canvas host, above the game). */
  mount: HTMLElement;
  state: PlayState;
  slice: SliceSnapshot;
  /** Fired when the LAST open window closes. Always-cursor input has no mode side effects. */
  onAllWindowsClosed?: () => void;
  /** Character-scoped namespace for persisted open-window state. */
  storageScope: string;
}

interface PanelBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WindowRecord {
  def: WindowDefinition;
  el: HTMLElement;
  titleEl: HTMLElement;
  contentRoot: HTMLElement;
  resizeEl: HTMLElement;
  handle: WindowContentHandle | null;
  bounds: PanelBounds;
  open: boolean;
  /** Effective hotkey after the gameplay-binding yield check. */
  hotkey: string | null;
  /** Last-applied bottom scroll-cue state (diff gate for the DOM attribute). */
  cueBelow: boolean;
  /** Bounds still come from the def's defaults — eligible for the open-time
   *  cascade nudge. Any user drag/resize (persisted) pins them. */
  fromDefaults: boolean;
}

interface DragState {
  rec: WindowRecord;
  pointerId: number;
  startX: number;
  startY: number;
  bounds: PanelBounds;
  mode: "move" | "resize";
}

const OPEN_SET_KEY_PREFIX = "successor3d.windows.open.v1.";
const TITLE_STRIP_PX = 22;

function boundsKeyFor(def: Pick<WindowDefinition, "id" | "boundsRevision">): string {
  const revision = def.boundsRevision && def.boundsRevision > 1 ? `.r${def.boundsRevision}` : "";
  return `successor3d.window.${def.id}.v1${revision}`;
}

export function windowOpenSetStorageKey(storageScope: string): string {
  return `${OPEN_SET_KEY_PREFIX}${encodeURIComponent(storageScope)}`;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function createWindowManager(options: WindowManagerOptions): WindowManager {
  const { mount, state, slice } = options;
  const ctx: WindowContext = { state, slice };
  const openSetKey = windowOpenSetStorageKey(options.storageScope);

  const root = document.createElement("div");
  root.className = "sc3d-ui";
  const layer = document.createElement("div");
  layer.className = "sc3d-windows";
  root.appendChild(layer);
  mount.appendChild(root);

  const records = new Map<string, WindowRecord>();
  const order: WindowRecord[] = []; // registration order (dock)
  const openListeners = new Set<(id: string, open: boolean) => void>();
  let focusedId: string | null = null;
  let zCounter = 0;
  let drag: DragState | null = null;
  let disposed = false;

  // ── Persistence ──────────────────────────────────────────────────────────
  const restoredOpenIds = new Set<string>(loadOpenSet());

  function loadOpenSet(): string[] {
    try {
      const raw = window.localStorage.getItem(openSetKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
    } catch {
      // storage unavailable / corrupt — start closed
    }
    return [];
  }

  function persistOpenSet(): void {
    try {
      const ids: string[] = [];
      for (const rec of order) {
        if (rec.open && !rec.def.transient) ids.push(rec.def.id);
      }
      window.localStorage.setItem(openSetKey, JSON.stringify(ids));
    } catch {
      // storage unavailable — open set stays session-local
    }
  }

  function loadBounds(rec: WindowRecord): PanelBounds {
    try {
      const raw = window.localStorage.getItem(boundsKeyFor(rec.def));
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PanelBounds>;
        if (
          parsed && typeof parsed.x === "number" && typeof parsed.y === "number"
          && typeof parsed.w === "number" && typeof parsed.h === "number"
        ) {
          rec.fromDefaults = false;
          return clampToViewport({ x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h }, rec.def);
        }
      }
    } catch {
      // fall through to default
    }
    rec.fromDefaults = true;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return clampToViewport(rec.def.defaultBounds({ w: vw, h: vh }), rec.def);
  }

  /**
   * Fraction of a strip band [x, x+w) × [y, y+22) hidden under the OPEN
   * windows' rects (self excluded). Free intervals shrink per overlapping
   * rect; z is irrelevant — an open window above OR below still steals the
   * grab (below gets covered on focus).
   */
  function stripCoveredFraction(rec: WindowRecord, bounds: PanelBounds): number {
    let intervals: Array<readonly [number, number]> = [[bounds.x, bounds.x + bounds.w]];
    for (const other of order) {
      if (other === rec || !other.open) continue;
      const o = other.bounds;
      if (o.y > bounds.y + TITLE_STRIP_PX - 2 || o.y + o.h < bounds.y + TITLE_STRIP_PX) continue;
      const next: Array<readonly [number, number]> = [];
      for (const [a, b] of intervals) {
        const lo = Math.max(a, o.x);
        const hi = Math.min(b, o.x + o.w);
        if (hi <= lo) {
          next.push([a, b]);
          continue;
        }
        if (a < lo) next.push([a, lo]);
        if (hi < b) next.push([hi, b]);
      }
      intervals = next;
    }
    let free = 0;
    for (const [a, b] of intervals) free += b - a;
    return bounds.w > 0 ? 1 - free / bounds.w : 0;
  }

  /**
   * Cascade-on-collision (fe-polish §1.30): a window opening at its DEFAULT
   * bounds steps its title strip down out of the open pile until at least a
   * fifth of it is grabbable — authored defaults stay the common case, new
   * windows joining the family can never bury (or be buried into) a heap.
   * User-persisted bounds are law and never nudge.
   */
  const CASCADE_STEP_PX = 26;
  const CASCADE_MAX_STEPS = 6;
  const CASCADE_COVER_LIMIT = 0.8;

  function cascadeDefaultBounds(rec: WindowRecord): void {
    if (!rec.fromDefaults) return;
    if (stripCoveredFraction(rec, rec.bounds) <= CASCADE_COVER_LIMIT) return;
    for (let step = 1; step <= CASCADE_MAX_STEPS; step += 1) {
      const candidate = clampToViewport(
        { ...rec.bounds, y: rec.bounds.y + CASCADE_STEP_PX * step },
        rec.def,
      );
      if (stripCoveredFraction(rec, candidate) <= CASCADE_COVER_LIMIT) {
        rec.bounds = candidate;
        return;
      }
    }
  }

  function persistBounds(rec: WindowRecord): void {
    // A persisted rect is a user decision — the cascade never touches it.
    rec.fromDefaults = false;
    try {
      window.localStorage.setItem(boundsKeyFor(rec.def), JSON.stringify(rec.bounds));
    } catch {
      // storage unavailable — bounds stay session-local
    }
  }

  /** Keep the window on-screen: at least the title strip + a sliver visible. */
  function clampToViewport(b: PanelBounds, def: WindowDefinition): PanelBounds {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = clamp(b.w, Math.min(def.minWidth, vw), vw);
    const h = clamp(b.h, Math.min(def.minHeight, vh), vh);
    const x = clamp(b.x, 0, Math.max(0, vw - TITLE_STRIP_PX * 5));
    const y = clamp(b.y, 0, Math.max(0, vh - TITLE_STRIP_PX));
    return { x, y, w, h };
  }

  function applyBounds(rec: WindowRecord): void {
    rec.el.style.left = `${rec.bounds.x}px`;
    rec.el.style.top = `${rec.bounds.y}px`;
    rec.el.style.width = `${rec.bounds.w}px`;
    rec.el.style.height = `${rec.bounds.h}px`;
  }

  // ── Focus ────────────────────────────────────────────────────────────────
  function focusWindow(rec: WindowRecord): void {
    zCounter += 1;
    rec.el.style.zIndex = String(zCounter);
    if (focusedId === rec.def.id) return;
    const previous = focusedId ? records.get(focusedId) : undefined;
    previous?.el.removeAttribute("data-focused");
    focusedId = rec.def.id;
    rec.el.setAttribute("data-focused", "");
  }

  function focusTopmostOpen(): void {
    let best: WindowRecord | null = null;
    let bestZ = -1;
    for (const rec of order) {
      if (!rec.open) continue;
      const z = Number(rec.el.style.zIndex) || 0;
      if (z > bestZ) {
        bestZ = z;
        best = rec;
      }
    }
    const previous = focusedId ? records.get(focusedId) : undefined;
    previous?.el.removeAttribute("data-focused");
    focusedId = best ? best.def.id : null;
    best?.el.setAttribute("data-focused", "");
  }

  // ── Mount / visibility ───────────────────────────────────────────────────
  function ensureMounted(rec: WindowRecord): void {
    if (rec.handle) return;
    rec.handle = rec.def.mount(rec.contentRoot, ctx);
  }

  /** A window's element shows iff it is open; the root class handles alt-hide. */
  function applyOpenVisibility(rec: WindowRecord): void {
    rec.el.hidden = !rec.open;
  }

  function notifyOpenChanged(id: string, open: boolean): void {
    for (const fn of openListeners) fn(id, open);
  }

  /**
   * Bottom scroll cue: when the content's direct scroll host has more below
   * the fold, the frame shows a quiet fade + chevron (windows.css). Clipped
   * content must never read as the end of the panel (fe-polish P0 — options/
   * fx-lab rows used to cut mid-glyph with no affordance). Windows that manage
   * their own inner scrollers (overflow:hidden roots) never trip this.
   */
  function syncScrollCue(rec: WindowRecord): void {
    const host = rec.contentRoot.firstElementChild;
    let below = false;
    if (host instanceof HTMLElement && host.scrollHeight > host.clientHeight + 1) {
      below = host.scrollTop + host.clientHeight < host.scrollHeight - 2;
    }
    if (rec.cueBelow === below) return;
    rec.cueBelow = below;
    rec.el.toggleAttribute("data-scroll-below", below);
  }

  // ── Drag / resize (pointer capture on the grabbed chrome element) ───────
  function onDragPointerDown(rec: WindowRecord, mode: "move" | "resize") {
    return (event: PointerEvent): void => {
      if (event.button !== 0 || drag) return;
      if (mode === "move" && event.target instanceof Element && event.target.closest(".sc3d-window-close")) {
        return; // the close button handles its own click
      }
      drag = {
        rec,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        bounds: { ...rec.bounds },
        mode,
      };
      (mode === "move" ? rec.titleEl : rec.resizeEl).setPointerCapture(event.pointerId);
      rec.el.classList.add(mode === "move" ? "dragging" : "resizing");
      event.preventDefault();
    };
  }

  function onDragPointerMove(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rec = drag.rec;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.mode === "move") {
      rec.bounds = clampToViewport(
        { x: drag.bounds.x + dx, y: drag.bounds.y + dy, w: drag.bounds.w, h: drag.bounds.h },
        rec.def,
      );
    } else {
      rec.bounds = clampToViewport(
        { x: drag.bounds.x, y: drag.bounds.y, w: drag.bounds.w + dx, h: drag.bounds.h + dy },
        rec.def,
      );
    }
    applyBounds(rec);
    if (drag.mode === "resize") rec.handle?.onResized();
    event.preventDefault();
  }

  function endDrag(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rec = drag.rec;
    const grabTarget = drag.mode === "move" ? rec.titleEl : rec.resizeEl;
    try {
      grabTarget.releasePointerCapture(event.pointerId);
    } catch {
      // capture may already be gone
    }
    rec.el.classList.remove("dragging", "resizing");
    persistBounds(rec);
    if (drag.mode === "resize") rec.handle?.onResized();
    drag = null;
  }

  // ── Window chrome DOM ────────────────────────────────────────────────────
  function buildWindowElement(rec: WindowRecord): void {
    const el = rec.el;
    el.className = "sc3d-window";
    el.dataset.window = rec.def.id;
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "false");
    el.setAttribute("aria-label", rec.def.title);

    const title = document.createElement("header");
    title.className = "sc3d-window-title";
    const icon = document.createElement("span");
    icon.className = "sc3d-window-icon";
    icon.setAttribute("aria-hidden", "true");
    // Purpose-glyph set where covered (solid silhouettes hold at 14px far
    // better than hairlines); UI_ICONS line glyph for the rest.
    icon.innerHTML = windowIconSvg(rec.def.icon) ?? UI_ICONS[rec.def.icon];
    const label = document.createElement("span");
    label.className = "sc3d-window-label";
    label.textContent = rec.def.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "sc3d-window-close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = UI_ICONS.close;
    title.append(icon, label, close);

    const content = document.createElement("div");
    content.className = "sc3d-window-content";

    const scrollCue = document.createElement("div");
    scrollCue.className = "sc3d-window-scrollcue";
    scrollCue.setAttribute("aria-hidden", "true");

    const resize = document.createElement("div");
    resize.className = "sc3d-window-resize";
    resize.setAttribute("aria-hidden", "true");

    el.append(title, content, scrollCue, resize);
    layer.appendChild(el);

    rec.titleEl = title;
    rec.contentRoot = content;
    rec.resizeEl = resize;

    el.addEventListener("pointerdown", () => focusWindow(rec));
    close.addEventListener("click", () => closeWindow(rec.def.id));
    title.addEventListener("pointerdown", onDragPointerDown(rec, "move"));
    resize.addEventListener("pointerdown", onDragPointerDown(rec, "resize"));
    title.addEventListener("pointermove", onDragPointerMove);
    resize.addEventListener("pointermove", onDragPointerMove);
    title.addEventListener("pointerup", endDrag);
    resize.addEventListener("pointerup", endDrag);
    title.addEventListener("pointercancel", endDrag);
    resize.addEventListener("pointercancel", endDrag);
  }

  // ── Open / close ─────────────────────────────────────────────────────────
  function openWindow(id: string): void {
    const rec = records.get(id);
    if (!rec) return;
    if (rec.open) {
      focusWindow(rec);
      return;
    }
    rec.open = true;
    rec.bounds = clampToViewport(rec.bounds, rec.def);
    cascadeDefaultBounds(rec);
    applyBounds(rec);
    applyOpenVisibility(rec);
    ensureMounted(rec);
    rec.handle?.onResized();
    focusWindow(rec);
    persistOpenSet();
    notifyOpenChanged(id, true);
  }

  function closeWindow(id: string): void {
    const rec = records.get(id);
    if (!rec || !rec.open) return;
    rec.open = false;
    applyOpenVisibility(rec);
    if (focusedId === id) focusTopmostOpen();
    persistOpenSet();
    notifyOpenChanged(id, false);
    let anyOpen = false;
    for (const other of records.values()) {
      if (other.open) {
        anyOpen = true;
        break;
      }
    }
    if (!anyOpen) options.onAllWindowsClosed?.();
  }

  // ── Keyboard: window hotkeys + Esc (single manager-owned listener) ──────
  function onKeyDown(event: KeyboardEvent): void {
    if (isTextInputTarget(event.target)) return;
    if (event.code === "Escape") {
      // The context radial owns a capture-phase Escape that stops propagation
      // before this handler when it is open.
      if (event.repeat) return;
      if (focusedId && records.get(focusedId)?.open) {
        event.preventDefault();
        closeWindow(focusedId);
      }
      return;
    }
    if (event.repeat) return;
    for (const rec of order) {
      if (rec.hotkey !== event.code) continue;
      event.preventDefault();
      if (rec.open) closeWindow(rec.def.id);
      else openWindow(rec.def.id);
      return;
    }
  }

  // ── Viewport resize: re-clamp every window ──────────────────────────────
  function onViewportResize(): void {
    for (const rec of order) {
      rec.bounds = clampToViewport(rec.bounds, rec.def);
      applyBounds(rec);
      if (rec.open) rec.handle?.onResized();
    }
  }
  function hotkeyAvailable(code: string): boolean {
    if (gameplayCodeForInput(state.settings, code)) return false;
    const action = inputActionForCode(state.settings, code);
    return action !== "reload";
  }


  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onViewportResize);

  return {
    root,

    register(def: WindowDefinition): void {
      if (records.has(def.id)) throw new Error(`window already registered: ${def.id}`);
      const rec: WindowRecord = {
        def,
        el: document.createElement("section"),
        titleEl: null as unknown as HTMLElement,
        contentRoot: null as unknown as HTMLElement,
        resizeEl: null as unknown as HTMLElement,
        handle: null,
        bounds: { x: 0, y: 0, w: def.minWidth, h: def.minHeight },
        open: false,
        // A hotkey yields only when a GAMEPLAY binding claims the code
        // (WASD/fire class), or when the graphical input layer consumes it.
        // Window actions remain available to the definitions registered here.
        hotkey: def.hotkey && hotkeyAvailable(def.hotkey) ? def.hotkey : null,
        cueBelow: false,
        fromDefaults: true,
      };
      buildWindowElement(rec);
      rec.bounds = loadBounds(rec);
      applyBounds(rec);
      records.set(def.id, rec);
      order.push(rec);
      // Boot restore: re-open persisted windows immediately; the 3D client no
      // longer alt-hides UI behind a visibility gate. Transient defs never
      // restore (stale ids from older saves are also scrubbed on the next
      // persistOpenSet write).
      if (restoredOpenIds.has(def.id) && !def.transient) {
        rec.open = true;
        applyOpenVisibility(rec);
        ensureMounted(rec);
        rec.handle?.onResized();
        focusWindow(rec);
      }
    },

    toggle(id: string): void {
      const rec = records.get(id);
      if (!rec) return;
      if (rec.open) closeWindow(id);
      else openWindow(id);
    },

    open: openWindow,
    close: closeWindow,

    isOpen(id: string): boolean {
      return records.get(id)?.open ?? false;
    },

    openWindowIds(): readonly string[] {
      return order.filter((rec) => rec.open).map((rec) => rec.def.id);
    },

    anyInteractiveVisible(): boolean {
      for (const rec of order) {
        if (rec.open) return true;
      }
      return false;
    },

    update(dtSeconds: number, timeMs: number): void {
      for (const rec of order) {
        if (!rec.open || !rec.handle) continue;
        rec.handle.update(dtSeconds, timeMs);
        syncScrollCue(rec);
      }
    },

    dockEntries(): readonly WindowDockEntry[] {
      const entries: WindowDockEntry[] = [];
      for (const rec of order) {
        if (rec.def.dockVisible === false) continue;
        entries.push({ id: rec.def.id, title: rec.def.title, icon: rec.def.icon, hotkey: rec.hotkey });
      }
      return entries;
    },

    subscribeOpenChanged(fn: (id: string, open: boolean) => void): () => void {
      openListeners.add(fn);
      return () => {
        openListeners.delete(fn);
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportResize);
      for (const rec of order) {
        rec.handle?.dispose();
        rec.handle = null;
      }
      records.clear();
      order.length = 0;
      openListeners.clear();
      root.remove();
    },
  };
}
