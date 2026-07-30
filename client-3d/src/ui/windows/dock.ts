import { UI_ICONS, hotkeyGlyph } from "../icons";
import { cycleUiTheme } from "../uiTheme";
import type { WindowManager } from "./windowManager";

/**
 * Dock — right-edge vertical rail (DESIGN.md).
 *
 * One 36×36 button per dock-visible window: geometric line icon, hotkey glyph
 * beneath, tooltip = title. Click toggles the window. Open-state signifier is
 * a persistent 2px accent underline plus ONE 200ms glow pulse at the moment of
 * opening (reduced motion: bar only). The theme-cycle swatch sits at the rail
 * bottom; OPTIONS keeps the full named palette picker. The dock lives inside
 * the always-visible manager UI root.
 *
 * Create AFTER all window definitions are registered: the rail is built once
 * from `manager.dockEntries()`.
 */
export interface WindowDock {
  dispose(): void;
}

export function createWindowDock(manager: WindowManager): WindowDock {
  const rail = document.createElement("nav");
  rail.className = "sc3d-dock";
  rail.setAttribute("aria-label", "Windows");

  const buttons = new Map<string, HTMLButtonElement>();

  for (const entry of manager.dockEntries()) {
    const item = document.createElement("div");
    item.className = "sc3d-dock-item";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sc3d-dock-btn";
    btn.title = entry.title;
    btn.setAttribute("aria-label", entry.title);
    btn.dataset.dockWindow = entry.id;
    btn.innerHTML = UI_ICONS[entry.icon];
    btn.addEventListener("click", () => manager.toggle(entry.id));
    if (manager.isOpen(entry.id)) btn.setAttribute("data-open", "");
    buttons.set(entry.id, btn);

    const key = document.createElement("span");
    key.className = "sc3d-dock-key";
    key.setAttribute("aria-hidden", "true");
    key.textContent = entry.hotkey ? hotkeyGlyph(entry.hotkey) : "";

    item.append(btn, key);
    rail.appendChild(item);
  }

  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "sc3d-dock-swatch";
  swatch.title = "Theme";
  swatch.setAttribute("aria-label", "Cycle UI theme");
  swatch.addEventListener("click", () => {
    cycleUiTheme();
  });
  rail.appendChild(swatch);

  const unsubscribe = manager.subscribeOpenChanged((id, open) => {
    const btn = buttons.get(id);
    if (!btn) return;
    btn.toggleAttribute("data-open", open);
    if (open) {
      // Restart the one-shot pulse even on rapid re-open.
      btn.classList.remove("sc3d-pulse");
      void btn.offsetWidth;
      btn.classList.add("sc3d-pulse");
    } else {
      btn.classList.remove("sc3d-pulse");
    }
  });

  manager.root.appendChild(rail);

  return {
    dispose(): void {
      unsubscribe();
      rail.remove();
      buttons.clear();
    },
  };
}
