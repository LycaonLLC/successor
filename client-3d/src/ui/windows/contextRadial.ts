/**
 * Context radial — the single reusable right-click action menu.
 *
 * One instance lives in the window-manager UI root at `--sc3d-z-radial`;
 * world and window callers open it at the current cursor position. There is
 * no combat/cursor restoration path: dismissal simply closes the menu.
 *  - pointerdown ANYWHERE outside the radial closes it (window-level capture,
 *    so the press dismisses BEFORE its target handles it);
 *  - Escape closes it (capture, stops propagation before window-close Esc);
 *  - opening a second radial closes the first (single instance — inherent);
 *  - any scroll closes it (window-level capture "scroll" catches scrolling
 *    grids and ledgers without per-consumer wiring).
 */

export interface RadialAction {
  id: string;
  label: string;
  enabled: boolean;
  /** Honest reason when disabled — shown as hover tooltip + sub-note. */
  note: string | null;
}

export interface RadialHandlers {
  onAction(id: string): void;
  /** Clicking a disabled action surfaces its note (status flash etc.). */
  onDisabled?(note: string | null): void;
  /** Called after any action, disabled click, or dismiss closes the radial. */
  onClosed?(): void;
}

export interface ContextRadial {
  readonly isOpen: boolean;
  openFor(clientX: number, clientY: number, actions: readonly RadialAction[], handlers: RadialHandlers): void;
  close(): void;
  dispose(): void;
}

export function createContextRadial(layerRoot: HTMLElement): ContextRadial {
  const menu = document.createElement("div");
  menu.className = "sc3d-radial";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  layerRoot.appendChild(menu);

  let open = false;
  let handlers: RadialHandlers | null = null;

  const close = (notify = true): void => {
    if (!open) return;
    const active = handlers;
    open = false;
    handlers = null;
    menu.hidden = true;
    if (notify) active?.onClosed?.();
  };

  menu.addEventListener("click", (event: MouseEvent) => {
    const btn = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>(".sc3d-radial-item")
      : null;
    if (!btn || !handlers) return;
    const active = handlers;
    const actionId = btn.dataset.action ?? "";
    const disabled = btn.getAttribute("aria-disabled") === "true";
    const note = btn.dataset.note || null;
    close(false);
    if (disabled) active.onDisabled?.(note);
    else active.onAction(actionId);
    active.onClosed?.();
  });

  // pointerdown anywhere outside dismisses BEFORE the target handles it.
  const onWindowPointerDown = (event: PointerEvent): void => {
    if (open && event.target instanceof Node && !menu.contains(event.target)) close();
  };
  // Escape closes the radial FIRST — capture beats the manager's window-close.
  const onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Escape" && open) {
      event.stopImmediatePropagation();
      event.preventDefault();
      close();
    }
  };
  // Any scroll (grid, ledger, page) invalidates the anchor position.
  const onWindowScroll = (): void => {
    close();
  };
  window.addEventListener("pointerdown", onWindowPointerDown, { capture: true });
  window.addEventListener("keydown", onWindowKeyDown, { capture: true });
  window.addEventListener("scroll", onWindowScroll, { capture: true });

  return {
    get isOpen(): boolean {
      return open;
    },

    openFor(clientX, clientY, actions, nextHandlers): void {
      close(); // a second radial closes the first
      menu.textContent = "";
      for (const action of actions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sc3d-radial-item";
        btn.dataset.action = action.id;
        btn.textContent = action.label;
        btn.setAttribute("role", "menuitem");
        if (!action.enabled) {
          // Copy principle: the label + a lock glyph carry the state; the
          // REASON lives on hover only (title tooltip), never inline.
          btn.setAttribute("aria-disabled", "true");
          btn.dataset.note = action.note ?? "";
          if (action.note) btn.title = action.note;
          const glyph = document.createElement("span");
          glyph.className = "sc3d-radial-lock";
          glyph.setAttribute("aria-hidden", "true");
          glyph.textContent = "\u25CC"; // dotted circle — pending route
          btn.appendChild(glyph);
        }
        menu.appendChild(btn);
      }
      handlers = nextHandlers;
      open = true;
      menu.hidden = false;
      // Position at the cursor, clamped inside the viewport-filling layer.
      const layerRect = layerRoot.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const x = Math.max(0, Math.min(clientX - layerRect.left, layerRect.width - menuRect.width - 2));
      const y = Math.max(0, Math.min(clientY - layerRect.top, layerRect.height - menuRect.height - 2));
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    },

    close,

    dispose(): void {
      window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true });
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
      window.removeEventListener("scroll", onWindowScroll, { capture: true });
      menu.remove();
    },
  };
}
