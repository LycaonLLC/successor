import { TOOLBAR_ACTIONS, toolbarActionById } from "../../hud/toolbarActions";
import { TOOLBAR_SLOT_COUNT, type ToolbarController } from "../../hud/toolbar";
import { UI_ICONS } from "../../icons";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * ACTION BROWSER — the established sandbox-style abilities pane.
 *
 * Lists every bindable action (icon + name + one-line description). Each row
 * is HTML5-draggable: drop it onto a toolbar slot to assign, or onto another
 * slot to swap. The toolbar owns the drop targets and the drag-off-clear rule;
 * this window only initiates drags (it carries the action id payload and never
 * the toolbar source-slot marker, so a browser drag can never clear a slot).
 *
 * Each row reflects its current toolbar home(s) as a small slot badge, so the
 * player can see at a glance what is already bound. Open from the dock or the
 * KeyB hotkey.
 */
export function createActionBrowserWindowDefinition(toolbar: ToolbarController): WindowDefinition {
  return {
    id: "actions",
    title: "ACTIONS",
    icon: "actions",
    hotkey: "KeyB",
    minWidth: 300,
    minHeight: 320,
    defaultBounds: (viewport) => {
      const w = Math.max(300, Math.round(viewport.w * 0.34));
      const h = Math.max(320, Math.round(viewport.h * 0.66));
      return { x: Math.round(viewport.w - w - 70), y: Math.round((viewport.h - h) / 2), w, h };
    },
    mount: (contentRoot, ctx) => mountActionBrowserContent(contentRoot, ctx, toolbar),
  };
}

function mountActionBrowserContent(
  contentRoot: HTMLElement,
  _ctx: WindowContext,
  toolbar: ToolbarController,
): WindowContentHandle {
  const root = document.createElement("div");
  root.className = "scp-root scp-actions";
  root.innerHTML = `
    <p class="scp-actions-hint">Drag an action onto a toolbar slot to assign it. Drag a slot off the bar to remove it.</p>
    <div class="scp-actions-list" data-ref="list" role="list"></div>
  `;
  contentRoot.appendChild(root);

  const listEl = root.querySelector<HTMLElement>('[data-ref="list"]')!;

  // Build the rows once (the action set is static); only the slot badges update.
  const rows: { el: HTMLElement; badge: HTMLElement; actionId: string }[] = [];
  for (const action of TOOLBAR_ACTIONS) {
    const row = document.createElement("div");
    row.className = "scp-action-row";
    row.setAttribute("role", "listitem");
    row.draggable = true;
    row.dataset.action = action.id;
    row.title = `${action.label} — ${action.description}`;
    row.innerHTML =
      `<span class="scp-action-icon">${UI_ICONS[action.icon]}</span>` +
      `<span class="scp-action-text"><strong></strong><small></small></span>` +
      `<span class="scp-action-badge" aria-hidden="true"></span>`;
    row.querySelector("strong")!.textContent = action.label;
    row.querySelector("small")!.textContent = action.description;
    listEl.appendChild(row);
    rows.push({ el: row, badge: row.querySelector<HTMLElement>(".scp-action-badge")!, actionId: action.id });
  }

  // Drag initiation: stamp the action-id payload only (no source-slot marker,
  // so this drag can assign but never clear).
  listEl.addEventListener("dragstart", (event: DragEvent) => {
    const row = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    if (!row || !event.dataTransfer) return;
    event.dataTransfer.setData("text/x-sc3d-action", row.dataset.action ?? "");
    event.dataTransfer.effectAllowed = "copy";
    row.setAttribute("data-dragging", "");
  });
  listEl.addEventListener("dragend", (event: DragEvent) => {
    const row = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    row?.removeAttribute("data-dragging");
  });

  // Double-click a row to put it in the first empty slot (quick-assign).
  listEl.addEventListener("dblclick", (event: MouseEvent) => {
    const row = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    if (!row) return;
    const actionId = row.dataset.action ?? "";
    if (!toolbarActionById(actionId)) return;
    for (let slot = 0; slot < TOOLBAR_SLOT_COUNT; slot++) {
      // Occupancy, not actionIdForSlot: item refs must never read as "empty"
      // or quick-assign would silently overwrite the player's item slots.
      if (!toolbar.slotOccupied(slot)) {
        toolbar.setSlotAction(slot, actionId);
        return;
      }
    }
    // Bar full — overwrite slot 0 as the least-surprising fallback.
    toolbar.setSlotAction(0, actionId);
  });

  const slotBadgeText = (actionId: string): string => {
    const homes: string[] = [];
    for (let slot = 0; slot < TOOLBAR_SLOT_COUNT; slot++) {
      if (toolbar.actionIdForSlot(slot) === actionId) homes.push(String(slot + 1));
    }
    return homes.length === 0 ? "" : homes.join(" ");
  };

  return {
    update(): void {
      // Refresh each row's slot badge only when its assignment changed.
      for (const { actionId, badge } of rows) {
        const text = slotBadgeText(actionId);
        if (badge.textContent !== text) {
          badge.textContent = text;
          badge.toggleAttribute("data-assigned", text !== "");
        }
      }
    },
    onResized(): void {
      // List reflows with the panel — nothing rect-dependent.
    },
    dispose(): void {
      root.remove();
    },
  };
}
