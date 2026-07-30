export interface DraggablePanelDefaultPosition {
  left: number;
  top: number;
}

export interface DraggablePanelControllerOptions {
  panel: HTMLElement;
  storage: Pick<Storage, "getItem" | "setItem">;
  storageKey: string;
  viewport?: Pick<Window, "innerWidth" | "innerHeight" | "addEventListener" | "removeEventListener">;
  minWidth?: number;
  minHeight?: number;
  defaultPosition?: DraggablePanelDefaultPosition | ((viewport: Pick<Window, "innerWidth" | "innerHeight">, panel: HTMLElement) => DraggablePanelDefaultPosition);
  shouldPersistSize?: (panel: HTMLElement) => boolean;
}

interface PanelPosition {
  left: number;
  top: number;
}

interface PanelSize {
  width: number;
  height: number;
}

const panelViewportPadding = 8;
const defaultPanelMinWidth = 300;
const defaultPanelMinHeight = 220;
const nativeResizeGripPx = 22;

export function installDraggablePanel(options: DraggablePanelControllerOptions): () => void {
  const viewport = options.viewport ?? window;
  const sizeStorageKey = `${options.storageKey}.size`;
  const shouldPersistSize = () => options.shouldPersistSize?.(options.panel) ?? true;
  applyStoredPanelSize(options.panel, options.storage, sizeStorageKey, viewport, options.minWidth, options.minHeight);
  applyStoredPanelPosition(options.panel, options.storage, options.storageKey, viewport, resolveDefaultPosition(options.defaultPosition, viewport, options.panel));
  let drag: {
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null = null;
  let resizePointerId: number | null = null;

  const onPointerDown = (event: PointerEvent) => {
    if (isNativeResizeGrip(event, options.panel)) {
      resizePointerId = event.pointerId;
      return;
    }
    const target = event.target as Element | null;
    if (!target?.closest("[data-panel-drag-handle]") || target.closest("button, input, select, textarea, a")) return;
    const rect = options.panel.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    options.panel.classList.add("dragging");
    options.panel.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const next = clampPanelPosition(
      {
        left: drag.left + event.clientX - drag.startX,
        top: drag.top + event.clientY - drag.startY,
      },
      options.panel,
      viewport,
    );
    applyPanelPosition(options.panel, next);
  };

  const finishPointer = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.pointerId) {
      const rect = options.panel.getBoundingClientRect();
      const next = clampPanelPosition({ left: rect.left, top: rect.top }, options.panel, viewport);
      applyPanelPosition(options.panel, next);
      options.storage.setItem(options.storageKey, JSON.stringify(next));
      options.panel.releasePointerCapture?.(event.pointerId);
      options.panel.classList.remove("dragging");
      drag = null;
    }
    if (resizePointerId === event.pointerId) {
      if (shouldPersistSize()) {
        persistCurrentPanelSize(options.panel, options.storage, sizeStorageKey, viewport, options.minWidth, options.minHeight);
      }
      persistCurrentPanelPosition(options.panel, options.storage, options.storageKey, viewport);
      resizePointerId = null;
    }
  };

  const onViewportResize = () => {
    if (options.panel.hidden) return;
    if (shouldPersistSize()) {
      persistCurrentPanelSize(options.panel, options.storage, sizeStorageKey, viewport, options.minWidth, options.minHeight);
    }
    persistCurrentPanelPosition(options.panel, options.storage, options.storageKey, viewport);
  };

  options.panel.addEventListener("pointerdown", onPointerDown);
  options.panel.addEventListener("pointermove", onPointerMove);
  options.panel.addEventListener("pointerup", finishPointer);
  options.panel.addEventListener("pointercancel", finishPointer);
  viewport.addEventListener?.("resize", onViewportResize);

  return () => {
    options.panel.removeEventListener("pointerdown", onPointerDown);
    options.panel.removeEventListener("pointermove", onPointerMove);
    options.panel.removeEventListener("pointerup", finishPointer);
    options.panel.removeEventListener("pointercancel", finishPointer);
    viewport.removeEventListener?.("resize", onViewportResize);
  };
}

export function applyStoredPanelPosition(
  panel: HTMLElement,
  storage: Pick<Storage, "getItem">,
  storageKey: string,
  viewport: Pick<Window, "innerWidth" | "innerHeight"> = window,
  defaultPosition?: PanelPosition,
): void {
  const stored = parseStoredPosition(storage.getItem(storageKey));
  const position = stored ?? defaultPosition;
  if (!position) return;
  applyPanelPosition(panel, clampPanelPosition(position, panel, viewport));
}

export function applyStoredPanelSize(
  panel: HTMLElement,
  storage: Pick<Storage, "getItem">,
  storageKey: string,
  viewport: Pick<Window, "innerWidth" | "innerHeight"> = window,
  minWidth = defaultPanelMinWidth,
  minHeight = defaultPanelMinHeight,
): void {
  const stored = parseStoredSize(storage.getItem(storageKey));
  if (!stored) return;
  applyPanelSize(panel, clampPanelSize(stored, viewport, minWidth, minHeight));
}

export function parseStoredPosition(raw: string | null): PanelPosition | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PanelPosition>;
    if (!Number.isFinite(value.left) || !Number.isFinite(value.top)) return null;
    return { left: Number(value.left), top: Number(value.top) };
  } catch {
    return null;
  }
}

export function parseStoredSize(raw: string | null): PanelSize | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PanelSize>;
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height)) return null;
    return { width: Number(value.width), height: Number(value.height) };
  } catch {
    return null;
  }
}

export function clampPanelPosition(
  position: PanelPosition,
  panel: HTMLElement,
  viewport: Pick<Window, "innerWidth" | "innerHeight"> = window,
): PanelPosition {
  const { width, height } = measuredPanelSize(panel);
  return {
    left: Math.max(panelViewportPadding, Math.min(position.left, viewport.innerWidth - width - panelViewportPadding)),
    top: Math.max(panelViewportPadding, Math.min(position.top, viewport.innerHeight - height - panelViewportPadding)),
  };
}

export function clampPanelSize(
  size: PanelSize,
  viewport: Pick<Window, "innerWidth" | "innerHeight"> = window,
  minWidth = defaultPanelMinWidth,
  minHeight = defaultPanelMinHeight,
): PanelSize {
  const maxWidth = Math.max(1, viewport.innerWidth - panelViewportPadding * 2);
  const maxHeight = Math.max(1, viewport.innerHeight - panelViewportPadding * 2);
  return {
    width: Math.round(clamp(size.width, Math.min(minWidth, maxWidth), maxWidth)),
    height: Math.round(clamp(size.height, Math.min(minHeight, maxHeight), maxHeight)),
  };
}

export function persistCurrentPanelSize(
  panel: HTMLElement,
  storage: Pick<Storage, "setItem">,
  storageKey: string,
  viewport: Pick<Window, "innerWidth" | "innerHeight"> = window,
  minWidth = defaultPanelMinWidth,
  minHeight = defaultPanelMinHeight,
): void {
  const next = clampPanelSize(measuredPanelSize(panel), viewport, minWidth, minHeight);
  applyPanelSize(panel, next);
  storage.setItem(storageKey, JSON.stringify(next));
}

export function persistCurrentPanelPosition(
  panel: HTMLElement,
  storage: Pick<Storage, "setItem">,
  storageKey: string,
  viewport: Pick<Window, "innerWidth" | "innerHeight"> = window,
): void {
  const rect = panel.getBoundingClientRect();
  const next = clampPanelPosition({ left: rect.left, top: rect.top }, panel, viewport);
  applyPanelPosition(panel, next);
  storage.setItem(storageKey, JSON.stringify(next));
}

function applyPanelPosition(panel: HTMLElement, position: PanelPosition): void {
  panel.classList.add("positioned");
  panel.style.left = `${Math.round(position.left)}px`;
  panel.style.top = `${Math.round(position.top)}px`;
  panel.style.right = "auto";
}

function applyPanelSize(panel: HTMLElement, size: PanelSize): void {
  panel.classList.add("sized");
  panel.style.width = `${size.width}px`;
  panel.style.height = `${size.height}px`;
}

function measuredPanelSize(panel: HTMLElement): PanelSize {
  const rect = panel.getBoundingClientRect();
  return {
    width: panel.offsetWidth || rect.width || parseCssPixels(panel.style.width) || 360,
    height: panel.offsetHeight || rect.height || parseCssPixels(panel.style.height) || 320,
  };
}

function isNativeResizeGrip(event: PointerEvent, panel: HTMLElement): boolean {
  const target = event.target as Element | null;
  if (target?.closest("button, input, select, textarea, a")) return false;
  const rect = panel.getBoundingClientRect();
  return event.clientX >= rect.right - nativeResizeGripPx && event.clientY >= rect.bottom - nativeResizeGripPx;
}

function parseCssPixels(value: string): number {
  if (!value.endsWith("px")) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveDefaultPosition(
  defaultPosition: DraggablePanelControllerOptions["defaultPosition"],
  viewport: Pick<Window, "innerWidth" | "innerHeight">,
  panel: HTMLElement,
): PanelPosition | undefined {
  if (!defaultPosition) return undefined;
  return typeof defaultPosition === "function" ? defaultPosition(viewport, panel) : defaultPosition;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
