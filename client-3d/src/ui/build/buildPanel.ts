import "./build.css";
import {
  BUILD_CATEGORIES,
  DEFAULT_BUILD_CATALOG,
  affordable,
  costText,
  dimensionText,
  materialShortName,
  rotationLetter,
  type BuildCatalogItem,
  type BuildCategory,
  type BuildPalette,
  type BuildRotation,
  type BuildTool,
} from "./catalog";

/**
 * BUILD panel — the Sims-style property-builder rail, framework-free.
 *
 * Pure preview UI: it never touches authority state. The building controller
 * (render/building) subscribes to the emitted events, drives the ghost /
 * BuildPlace / BuildRemove commands, and pushes projection truth back in via
 * `setState` / `setRotation` / `setTool`. Setter calls never echo events —
 * only direct user action emits.
 *
 * Input contract: the panel listens for keys ONLY inside its own root. While
 * the world has focus, boot routes keys through `handleKey` (N close, Esc
 * cancel, R rotate, Delete demolish). No window-level listeners are installed.
 */

export interface BuildPanelState {
  /** Top-strip property label, e.g. "PARCEL K-7". */
  parcelLabel: string;
  /** Owned material units by material id (authority inventory projection). */
  materials: Readonly<Record<string, number>>;
  /** Authority/preview refusal for the current ghost; null = placeable. */
  invalidReason: string | null;
}

export interface BuildPanelEvents {
  onSelectItem(item: BuildCatalogItem | null): void;
  onRotate(rotation: BuildRotation): void;
  onToolChange(tool: BuildTool): void;
  onPaletteChange(palette: BuildPalette): void;
  /** Esc / CANCEL — drop the current ghost or leave demolish. */
  onCancel(): void;
  /** N / ✕ — leave build mode entirely. */
  onClose(): void;
}

export interface BuildPanelOptions {
  catalog?: readonly BuildCatalogItem[];
  state?: Partial<BuildPanelState>;
  events?: Partial<BuildPanelEvents>;
}

export interface BuildPanelHandle {
  readonly root: HTMLElement;
  setState(patch: Partial<BuildPanelState>): void;
  /** Sync rotation from the world (mouse wheel). No event echo. */
  setRotation(rotation: BuildRotation): void;
  /** Sync tool from the world. No event echo. */
  setTool(tool: BuildTool): void;
  selectedItem(): BuildCatalogItem | null;
  rotation(): BuildRotation;
  tool(): BuildTool;
  palette(): BuildPalette;
  /** World-focused key routing. Returns true when the key was consumed. */
  handleKey(ev: KeyboardEvent): boolean;
  dispose(): void;
}

/** Industrial recolor swatches — brass/oxide/olive field palette, no neon. */
const SWATCHES: readonly { hex: string; name: string }[] = [
  { hex: "#b98c3a", name: "Brass" },
  { hex: "#a63c20", name: "Oxide red" },
  { hex: "#767446", name: "Field olive" },
  { hex: "#e4d7b4", name: "Bone" },
  { hex: "#c9ad82", name: "Dust" },
  { hex: "#5b6a70", name: "Gunmetal" },
  { hex: "#3f5561", name: "Slate blue" },
  { hex: "#262012", name: "Soot" },
];

const PALETTE_SLOTS: readonly { key: keyof BuildPalette; short: string; name: string }[] = [
  { key: "primary", short: "1", name: "Primary color" },
  { key: "secondary", short: "2", name: "Secondary color" },
  { key: "accent", short: "3", name: "Accent color" },
];

export function mountBuildPanel(host: HTMLElement, opts: BuildPanelOptions = {}): BuildPanelHandle {
  const catalog = opts.catalog ?? DEFAULT_BUILD_CATALOG;
  const events = opts.events ?? {};

  const state: BuildPanelState = {
    parcelLabel: opts.state?.parcelLabel ?? "",
    materials: opts.state?.materials ?? {},
    invalidReason: opts.state?.invalidReason ?? null,
  };

  let category: BuildCategory = "floors";
  let query = "";
  let selected: BuildCatalogItem | null = null;
  let rotation: BuildRotation = 0;
  let tool: BuildTool = "place";
  const palette: BuildPalette = { primary: null, secondary: null, accent: null };
  let openSlot: keyof BuildPalette | null = null;

  // ── Skeleton ────────────────────────────────────────────────────────────

  const root = document.createElement("section");
  root.className = "scb-panel";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Build");
  root.innerHTML = `
    <div class="scb-head">
      <span class="scb-title">BUILD</span>
      <span class="scb-parcel" data-ref="parcel"></span>
      <button type="button" class="scb-close" data-ref="close" aria-label="Close build (N)">✕</button>
    </div>
    <div class="scb-materials" data-ref="materials" aria-label="Materials"></div>
    <div class="scb-tabs" role="tablist" aria-label="Catalog" data-ref="tabs"></div>
    <input class="scb-search" data-ref="search" type="search" placeholder="SEARCH" aria-label="Search catalog" autocomplete="off" spellcheck="false" />
    <div class="scb-grid" role="listbox" data-ref="grid"></div>
    <div class="scb-info" data-ref="info"></div>
    <div class="scb-reason" data-ref="reason" role="status" aria-live="polite"></div>
    <div class="scb-palette">
      <span class="scb-palette-label">COLOR</span>
    </div>
    <div class="scb-swatches" data-ref="swatches" role="listbox" aria-label="Swatches"></div>
    <div class="scb-tools">
      <button type="button" class="scb-tool" data-ref="rotate">ROTATE<span class="scb-tool-key">R</span></button>
      <button type="button" class="scb-tool" data-ref="place" aria-pressed="false" disabled>PLACE<span class="scb-tool-key">CLICK</span></button>
      <button type="button" class="scb-tool scb-tool--demolish" data-ref="remove" aria-pressed="false">DEMOLISH<span class="scb-tool-key">DEL</span></button>
      <button type="button" class="scb-tool" data-ref="cancel">CANCEL<span class="scb-tool-key">ESC</span></button>
    </div>
  `;

  const ref = <T extends HTMLElement = HTMLElement>(name: string): T => {
    const el = root.querySelector<T>(`[data-ref="${name}"]`);
    if (!el) throw new Error(`build panel ref missing: ${name}`);
    return el;
  };

  const parcelEl = ref("parcel");
  const materialsEl = ref("materials");
  const tabsEl = ref("tabs");
  const searchEl = ref<HTMLInputElement>("search");
  const gridEl = ref("grid");
  const infoEl = ref("info");
  const reasonEl = ref("reason");
  const swatchesEl = ref("swatches");
  const rotateBtn = ref<HTMLButtonElement>("rotate");
  const placeBtn = ref<HTMLButtonElement>("place");
  const removeBtn = ref<HTMLButtonElement>("remove");

  // Tabs.
  const tabButtons = {} as Record<BuildCategory, HTMLButtonElement>;
  for (const cat of BUILD_CATEGORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scb-tab";
    btn.setAttribute("role", "tab");
    btn.textContent = cat.label;
    btn.addEventListener("click", () => setCategory(cat.id));
    tabButtons[cat.id] = btn;
    tabsEl.appendChild(btn);
  }
  tabsEl.addEventListener("keydown", (ev) => {
    if (ev.code !== "ArrowLeft" && ev.code !== "ArrowRight") return;
    const order = BUILD_CATEGORIES.map((c) => c.id);
    const step = ev.code === "ArrowRight" ? 1 : -1;
    const next = order[(order.indexOf(category) + step + order.length) % order.length]!;
    setCategory(next);
    tabButtons[next].focus();
    ev.preventDefault();
    ev.stopPropagation();
  });

  // Palette slots.
  const paletteRow = root.querySelector<HTMLElement>(".scb-palette")!;
  const slotButtons = {} as Record<keyof BuildPalette, HTMLButtonElement>;
  for (const slot of PALETTE_SLOTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scb-slot";
    btn.setAttribute("aria-label", slot.name);
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", () => {
      openSlot = openSlot === slot.key ? null : slot.key;
      renderPalette();
    });
    slotButtons[slot.key] = btn;
    paletteRow.appendChild(btn);
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  function renderStatus(): void {
    parcelEl.textContent = state.parcelLabel;
    materialsEl.textContent = "";
    const ids = Object.keys(state.materials).sort((a, b) =>
      a === "structural" ? -1 : b === "structural" ? 1 : a.localeCompare(b),
    );
    for (const id of ids) {
      const chip = document.createElement("span");
      chip.className = "scb-mat";
      chip.dataset.mat = id;
      chip.innerHTML = `${materialShortName(id)} <b>${state.materials[id]}</b>`;
      materialsEl.appendChild(chip);
    }
  }

  function visibleItems(): BuildCatalogItem[] {
    const q = query.trim().toLowerCase();
    return catalog.filter(
      (item) =>
        item.category === category &&
        (q.length === 0 || item.label.toLowerCase().includes(q) || item.id.includes(q)),
    );
  }

  function renderTabs(): void {
    for (const cat of BUILD_CATEGORIES) {
      const btn = tabButtons[cat.id];
      const active = cat.id === category;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    }
    const label = BUILD_CATEGORIES.find((c) => c.id === category)!.label;
    gridEl.setAttribute("aria-label", `${label} items`);
  }

  function renderGrid(): void {
    gridEl.textContent = "";
    const items = visibleItems();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "scb-grid-empty";
      empty.textContent = query.trim().length > 0 ? "NO MATCH" : "NOTHING HERE YET";
      gridEl.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "scb-tile";
      tile.setAttribute("role", "option");
      tile.dataset.itemId = item.id;
      const isSelected = selected?.id === item.id;
      tile.setAttribute("aria-selected", isSelected ? "true" : "false");
      tile.tabIndex = isSelected || (selected === null && index === 0) ? 0 : -1;
      if (!affordable(item.cost, state.materials)) tile.dataset.short = "";
      tile.setAttribute("aria-label", `${item.label}, ${costText(item.cost)}`);
      tile.innerHTML = `
        <span class="scb-tile-name">${item.label}</span>
        <span class="scb-tile-cost">${costText(item.cost)}</span>
      `;
      tile.addEventListener("click", () => selectItem(item));
      gridEl.appendChild(tile);
    });
  }

  gridEl.addEventListener("keydown", (ev) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(ev.code)) return;
    const tiles = [...gridEl.querySelectorAll<HTMLButtonElement>(".scb-tile")];
    if (tiles.length === 0) return;
    const current = tiles.indexOf(document.activeElement as HTMLButtonElement);
    const from = current === -1 ? 0 : current;
    const step = ev.code === "ArrowLeft" ? -1 : ev.code === "ArrowRight" ? 1 : ev.code === "ArrowUp" ? -2 : 2;
    const next = Math.min(tiles.length - 1, Math.max(0, from + step));
    tiles.forEach((t, i) => (t.tabIndex = i === next ? 0 : -1));
    tiles[next]!.focus();
    ev.preventDefault();
    ev.stopPropagation();
  });

  function renderInfo(): void {
    if (tool === "remove") {
      infoEl.innerHTML = `<span><b>DEMOLISH</b> · CLICK A PIECE TO REMOVE</span>`;
      return;
    }
    if (!selected) {
      infoEl.innerHTML = `<span>PICK A PIECE TO PLACE</span>`;
      return;
    }
    infoEl.innerHTML = `
      <span><b>${selected.label}</b> · ${dimensionText(selected)}</span>
      <span>FACING ${rotationLetter(rotation)} · ${costText(selected.cost)}</span>
    `;
  }

  function renderReason(): void {
    if (state.invalidReason) {
      reasonEl.textContent = state.invalidReason;
      reasonEl.dataset.visible = "";
    } else {
      reasonEl.textContent = "";
      delete reasonEl.dataset.visible;
    }
  }

  function renderPalette(): void {
    for (const slot of PALETTE_SLOTS) {
      const btn = slotButtons[slot.key];
      const color = palette[slot.key];
      if (color) {
        btn.dataset.color = color;
        btn.style.setProperty("--scb-slot-color", color);
      } else {
        delete btn.dataset.color;
        btn.style.removeProperty("--scb-slot-color");
      }
      btn.setAttribute("aria-expanded", openSlot === slot.key ? "true" : "false");
      const named = color ? (SWATCHES.find((s) => s.hex === color)?.name ?? color) : "none";
      btn.setAttribute("aria-label", `${slot.name}: ${named}`);
    }
    swatchesEl.textContent = "";
    if (openSlot === null) {
      delete swatchesEl.dataset.visible;
      return;
    }
    swatchesEl.dataset.visible = "";
    const options: { hex: string | null; name: string }[] = [
      ...SWATCHES,
      { hex: null, name: "No color" },
    ];
    for (const opt of options) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "scb-swatch";
      sw.setAttribute("role", "option");
      sw.setAttribute("aria-label", opt.name);
      sw.setAttribute("aria-selected", palette[openSlot] === opt.hex ? "true" : "false");
      if (opt.hex) sw.style.setProperty("--scb-swatch-color", opt.hex);
      else sw.dataset.none = "";
      sw.addEventListener("click", () => {
        palette[openSlot!] = opt.hex;
        openSlot = null;
        renderPalette();
        events.onPaletteChange?.({ ...palette });
      });
      swatchesEl.appendChild(sw);
    }
  }

  function renderTools(): void {
    placeBtn.disabled = selected === null;
    placeBtn.setAttribute("aria-pressed", tool === "place" && selected !== null ? "true" : "false");
    removeBtn.setAttribute("aria-pressed", tool === "remove" ? "true" : "false");
    rotateBtn.setAttribute("aria-label", `Rotate, facing ${rotationLetter(rotation)} (R)`);
  }

  // ── State transitions ───────────────────────────────────────────────────

  function setCategory(next: BuildCategory): void {
    if (category === next) return;
    category = next;
    renderTabs();
    renderGrid();
  }

  function selectItem(item: BuildCatalogItem): void {
    selected = item;
    if (tool !== "place") {
      tool = "place";
      events.onToolChange?.(tool);
    }
    renderGrid();
    renderInfo();
    renderTools();
    events.onSelectItem?.(item);
  }

  function clearSelection(emit: boolean): void {
    const had = selected !== null;
    selected = null;
    renderGrid();
    renderInfo();
    renderTools();
    if (emit && had) events.onSelectItem?.(null);
  }

  function rotate(): void {
    rotation = ((rotation + 1) & 3) as BuildRotation;
    renderInfo();
    renderTools();
    events.onRotate?.(rotation);
  }

  function enterDemolish(): void {
    if (tool === "remove") return;
    tool = "remove";
    clearSelection(true);
    events.onToolChange?.(tool);
  }

  function cancel(): void {
    openSlot = null;
    if (tool === "remove") {
      tool = "place";
      events.onToolChange?.(tool);
    }
    clearSelection(true);
    state.invalidReason = null;
    renderReason();
    renderPalette();
    events.onCancel?.();
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  ref("close").addEventListener("click", () => events.onClose?.());
  rotateBtn.addEventListener("click", rotate);
  placeBtn.addEventListener("click", () => {
    if (selected === null || tool === "place") return;
    tool = "place";
    renderInfo();
    renderTools();
    events.onToolChange?.(tool);
  });
  removeBtn.addEventListener("click", enterDemolish);
  ref("cancel").addEventListener("click", cancel);

  searchEl.addEventListener("input", () => {
    query = searchEl.value;
    renderGrid();
  });

  /** Shared hotkey handling for panel-focused and world-focused (handleKey) paths. */
  function hotkey(ev: KeyboardEvent): boolean {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return false;
    switch (ev.code) {
      case "KeyN":
        events.onClose?.();
        return true;
      case "Escape":
        cancel();
        return true;
      case "KeyR":
        rotate();
        return true;
      case "Delete":
        enterDemolish();
        return true;
      default:
        return false;
    }
  }

  root.addEventListener("keydown", (ev) => {
    if (ev.target === searchEl) {
      // Typing must never rotate/close; Esc leaves the search field.
      if (ev.code === "Escape") {
        if (searchEl.value.length > 0) {
          searchEl.value = "";
          query = "";
          renderGrid();
        } else {
          searchEl.blur();
        }
        ev.preventDefault();
        ev.stopPropagation();
      }
      return;
    }
    if (hotkey(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  });

  renderStatus();
  renderTabs();
  renderGrid();
  renderInfo();
  renderReason();
  renderPalette();
  renderTools();
  host.appendChild(root);

  return {
    root,
    setState(patch) {
      if (patch.parcelLabel !== undefined) state.parcelLabel = patch.parcelLabel;
      if (patch.materials !== undefined) state.materials = patch.materials;
      if (patch.invalidReason !== undefined) state.invalidReason = patch.invalidReason;
      renderStatus();
      renderGrid();
      renderReason();
    },
    setRotation(q) {
      rotation = q;
      renderInfo();
      renderTools();
    },
    setTool(next) {
      if (tool === next) return;
      tool = next;
      if (next === "remove") {
        selected = null;
        renderGrid();
      }
      renderInfo();
      renderTools();
    },
    selectedItem: () => selected,
    rotation: () => rotation,
    tool: () => tool,
    palette: () => ({ ...palette }),
    handleKey: hotkey,
    dispose() {
      root.remove();
    },
  };
}
