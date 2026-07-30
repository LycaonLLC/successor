import { inputActionDefinitions, labelForInputCode } from "@successor/client/src/slice-core/settingsSystem";
import { SUCCESSOR_3D_CONFIG } from "../../../config";
import { getUiTheme, setUiTheme, subscribeUiTheme, UI_THEMES } from "../../uiTheme";
import {
  getDefaultSplitSnap,
  setDefaultSplitSnap,
  SPLIT_SNAP_STEPS,
} from "../../inventory/splitPrefs";
import { TOOLBAR_SLOT_COUNT, type ToolbarController } from "../../hud/toolbar";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * OPTIONS — display + input reference.
 *
 * DISPLAY: the canonical theme picker (four swatches; the dock swatch stays
 * as a cycle shortcut), a live edge-fog strength slider writing the post
 * pass's exported dial (`window.__successor3dPost.edgeFogMaxStrength` —
 * session dial, re-applied every frame by the post pass), and the current
 * camera zoom (display-only; the wheel owns zoom and persists it).
 *
 * INPUT: keybinding rows generated from the shared settings registry
 * (id/label/help/defaultCodes). Read-only this pass — rebinding is follow-up;
 * the help text lives on hover per the copy principle.
 */
export function createOptionsWindowDefinition(
  toolbar: ToolbarController,
  hooks: { openWindow: (id: string) => void },
): WindowDefinition {
  return {
    id: "options",
    title: "OPTIONS",
    icon: "options",
    hotkey: "KeyO",
    minWidth: 340,
    minHeight: 380,
    // r2: taller default — the INPUT reference used to cut mid-glyph at both
    // audited viewports with no scroll affordance (fe-polish P0). Cascade:
    // right-of-center, strip above the inventory's (§1.30).
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = 380;
      const h = Math.min(760, Math.round(viewport.h * 0.82));
      const x = Math.min(viewport.w - w - 12, Math.round((viewport.w - w) / 2) + 190);
      return { x: Math.max(12, x), y: Math.min(54, Math.round(viewport.h * 0.06)), w, h };
    },
    mount: (contentRoot, ctx) => mountOptionsContent(contentRoot, ctx, toolbar, hooks),
  };
}

function mountOptionsContent(
  contentRoot: HTMLElement,
  ctx: WindowContext,
  toolbar: ToolbarController,
  hooks: { openWindow: (id: string) => void },
): WindowContentHandle {
  const root = document.createElement("div");
  root.className = "scp-root scp-options";

  const display = document.createElement("section");
  display.className = "scp-section";
  display.innerHTML = `<h3 class="scp-section-title">DISPLAY</h3>`;

  // Theme swatch row — the canonical picker.
  const themeRow = document.createElement("div");
  themeRow.className = "scp-row";
  themeRow.innerHTML = `<span class="scp-label" title="UI chrome palette">THEME</span>`;
  const swatches = document.createElement("div");
  swatches.className = "scp-swatches";
  const swatchById = new Map<string, HTMLButtonElement>();
  for (const theme of UI_THEMES) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "scp-swatch";
    swatch.title = theme.label;
    swatch.setAttribute("aria-label", theme.label);
    swatch.style.background = theme.palette.accent;
    swatch.addEventListener("click", () => {
      setUiTheme(theme.id);
    });
    swatchById.set(theme.id, swatch);
    swatches.appendChild(swatch);
  }
  themeRow.appendChild(swatches);
  const applyActiveSwatch = (): void => {
    const active = getUiTheme();
    for (const [id, swatch] of swatchById) swatch.toggleAttribute("data-active", id === active);
  };
  applyActiveSwatch();
  const unsubscribeTheme = subscribeUiTheme(applyActiveSwatch);

  // Ambient-dust strength — live post-pass dial.
  const fogRow = document.createElement("div");
  fogRow.className = "scp-row";
  fogRow.innerHTML = `
    <span class="scp-label" title="Ambient dust haze at zoom-out. Session dial — resets on reload.">DUST</span>
    <input class="scp-range" data-ref="fog" type="range" min="0" max="1" step="0.05" aria-label="Ambient dust strength" />
    <span class="scp-value" data-ref="fogValue">—</span>
  `;
  const fogInput = fogRow.querySelector<HTMLInputElement>('[data-ref="fog"]')!;
  const fogValue = fogRow.querySelector<HTMLElement>('[data-ref="fogValue"]')!;
  fogInput.addEventListener("input", () => {
    const dials = window.__successor3dPost;
    if (!dials) return;
    dials.dustMaxStrength = Number(fogInput.value);
  });

  // Camera zoom — display-only (the wheel owns it).
  const zoomRow = document.createElement("div");
  zoomRow.className = "scp-row";
  zoomRow.innerHTML = `
    <span class="scp-label" title="Mouse wheel zooms; steps of ${SUCCESSOR_3D_CONFIG.input.wheelStepPercent}%. Persisted automatically.">ZOOM</span>
    <span class="scp-value scp-value-wide" data-ref="zoom">—</span>
  `;
  const zoomValue = zoomRow.querySelector<HTMLElement>('[data-ref="zoom"]')!;

  display.append(themeRow, fogRow, zoomRow);

  // Projected aim-capture controls retired with the always-free cursor.

  // Toolbar — hotkey reference + rebind. Action ASSIGNMENT lives in the
  // Action Browser now (drag actions onto slots, drag slots off to clear);
  // this section only manages which KEY fires each slot.
  const toolbarSection = document.createElement("section");
  toolbarSection.className = "scp-section";
  toolbarSection.innerHTML = `<h3 class="scp-section-title">TOOLBAR</h3>`;

  const actionsRow = document.createElement("div");
  actionsRow.className = "scp-row";
  const actionsLabel = document.createElement("span");
  actionsLabel.className = "scp-label";
  actionsLabel.textContent = "ACTIONS";
  const openActions = document.createElement("button");
  openActions.type = "button";
  openActions.className = "scp-rebind-btn";
  openActions.textContent = "OPEN BROWSER";
  openActions.title = "Open the Action Browser to assign actions by drag-and-drop";
  openActions.addEventListener("click", () => hooks.openWindow("actions"));
  actionsRow.append(actionsLabel, openActions);
  toolbarSection.appendChild(actionsRow);

  const toolbarList = document.createElement("div");
  toolbarList.className = "scp-bindings";
  const toolbarRowRefresh: (() => void)[] = [];
  for (let slot = 0; slot < TOOLBAR_SLOT_COUNT; slot++) {
    const row = document.createElement("div");
    row.className = "scp-binding-row";
    const label = document.createElement("span");
    label.className = "scp-binding-label";
    label.textContent = `SLOT ${String(slot + 1).padStart(2, "0")}`;
    const keys = document.createElement("span");
    keys.className = "scp-binding-keys";
    const kbd = document.createElement("kbd");
    kbd.className = "scp-kbd";
    const rebind = document.createElement("button");
    rebind.type = "button";
    rebind.className = "scp-rebind-btn";
    rebind.textContent = "REBIND";
    rebind.title = "Click, then press the new key (Esc cancels)";
    const refresh = (): void => {
      kbd.textContent = labelForInputCode(toolbar.bindForSlot(slot));
    };
    refresh();
    toolbarRowRefresh.push(refresh);
    rebind.addEventListener("click", () => {
      rebind.textContent = "PRESS KEY…";
      rebind.toggleAttribute("data-pending", true);
      toolbar.rebindSlot(slot, () => {
        rebind.textContent = "REBIND";
        rebind.toggleAttribute("data-pending", false);
        for (const fn of toolbarRowRefresh) fn();
      });
    });
    keys.append(kbd, rebind);
    row.append(label, leaderSpan(), keys);
    toolbarList.appendChild(row);
  }
  toolbarSection.appendChild(toolbarList);

  // Input reference — read-only binding rows from the shared registry.
  const inputSection = document.createElement("section");
  inputSection.className = "scp-section";
  inputSection.innerHTML = `<h3 class="scp-section-title">INPUT</h3>`;
  const bindingList = document.createElement("div");
  bindingList.className = "scp-bindings";
  for (const definition of inputActionDefinitions) {
    const row = document.createElement("div");
    row.className = "scp-binding-row";
    row.title = definition.help;
    const label = document.createElement("span");
    label.className = "scp-binding-label";
    label.textContent = definition.label.toUpperCase();
    const keys = document.createElement("span");
    keys.className = "scp-binding-keys";
    const codes = ctx.state.settings.bindings[definition.id] ?? definition.defaultCodes;
    for (const code of dedupe(codes.map((c) => labelForInputCode(c)))) {
      const kbd = document.createElement("kbd");
      kbd.className = "scp-kbd";
      kbd.textContent = code;
      keys.appendChild(kbd);
    }
    row.append(label, leaderSpan(), keys);
    bindingList.appendChild(row);
  }
  inputSection.appendChild(bindingList);

  // Inventory — default stack-split snap (the split slider's initial step).
  const inventorySection = document.createElement("section");
  inventorySection.className = "scp-section";
  inventorySection.innerHTML = `<h3 class="scp-section-title">INVENTORY</h3>`;
  const snapRow = document.createElement("div");
  snapRow.className = "scp-row";
  snapRow.innerHTML = `<span class="scp-label" title="Default snap step for the stack-split slider.">DEFAULT SNAP</span>`;
  const snapSeg = document.createElement("div");
  snapSeg.className = "scp-snapseg";
  const snapButtons = new Map<number, HTMLButtonElement>();
  const applyActiveSnap = (): void => {
    const active = getDefaultSplitSnap();
    for (const [step, button] of snapButtons) button.toggleAttribute("data-active", step === active);
  };
  for (const step of SPLIT_SNAP_STEPS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scp-snapseg-btn";
    button.textContent = step >= 1000 ? `${step / 1000}K` : String(step);
    button.title = `Snap split amounts to multiples of ${step}`;
    button.addEventListener("click", () => {
      setDefaultSplitSnap(step);
      applyActiveSnap();
    });
    snapButtons.set(step, button);
    snapSeg.appendChild(button);
  }
  applyActiveSnap();
  snapRow.appendChild(snapSeg);
  inventorySection.appendChild(snapRow);

  root.append(display, toolbarSection, inventorySection, inputSection);
  contentRoot.appendChild(root);

  const applied = { zoom: "", fog: "" };

  return {
    update(): void {
      const zoomText = `${ctx.state.settings.mouse.cameraZoomPercent}%`;
      if (applied.zoom !== zoomText) {
        applied.zoom = zoomText;
        zoomValue.textContent = zoomText;
      }
      const dials = window.__successor3dPost;
      const fogText = dials ? dials.dustMaxStrength.toFixed(2) : "—";
      if (applied.fog !== fogText) {
        applied.fog = fogText;
        fogValue.textContent = fogText;
        fogInput.disabled = !dials;
        // Reflect external dial changes, but never fight an active drag.
        if (dials && document.activeElement !== fogInput) {
          fogInput.value = String(dials.dustMaxStrength);
        }
      }
    },
    onResized(): void {
      // Static layout — nothing rect-dependent.
    },
    dispose(): void {
      unsubscribeTheme();
      root.remove();
    },
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Dotted leader filler between a binding row's label and its keys. */
function leaderSpan(): HTMLSpanElement {
  const leader = document.createElement("span");
  leader.className = "scp-binding-leader";
  leader.setAttribute("aria-hidden", "true");
  return leader;
}
