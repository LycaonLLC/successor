/**
 * TURNTABLE INTERACTION — the one pointer vocabulary for every 3D preview.
 *
 * Click-hold-spin (horizontal drag = yaw) plus wheel zoom, shared by the
 * inventory paper doll, EXAMINE item well, TARGET EXAMINE mannequin, the
 * character-select doll, the dialogue portrait's live promotion, and any
 * future preview well (trade window). One implementation so drag feel and
 * zoom curve are identical everywhere (owner spec 2026-07-08).
 *
 * Contract:
 *   • Drag: while the pointer is held the model tracks the hand EXACTLY
 *     (surfaces freeze their auto-turn for the drag and resume rebased on
 *     release — see PaperDollRenderer / InventoryModelRenderer).
 *   • Zoom: wheel over a turntable scales the surface's ortho camera.zoom,
 *     clamped to the shared range. preventDefault fires ONLY when a target
 *     is hit, so scrollable panes (target-examine card, grids) keep native
 *     scrolling everywhere else.
 *   • Cursor: native grab/grabbing — sanctioned manipulation feedback under
 *     the identity-cursor rule (overlay/cursor owns pointing, not grabbing).
 *
 * The pure math lives in exported functions (node-testable, no DOM).
 */

/** Drag feel: radians of yaw per device pixel of horizontal travel. */
export const TURNTABLE_DRAG_RADIANS_PER_DEVICE_PX = 0.0065;
/** Ortho camera.zoom clamp shared by every surface. */
export const TURNTABLE_ZOOM_MIN = 0.6;
export const TURNTABLE_ZOOM_MAX = 2.5;
/** Exponential wheel response: ~×1.12 per 100px notch. */
export const TURNTABLE_ZOOM_WHEEL_SENSITIVITY = 0.0011;
/** Firefox line-mode wheel deltas normalized at 16px per line. */
const WHEEL_LINE_PX = 16;

export function clampTurntableZoom(zoom: number, min = TURNTABLE_ZOOM_MIN, max = TURNTABLE_ZOOM_MAX): number {
  return Math.min(max, Math.max(min, zoom));
}

/** Yaw after dragging `deltaDevicePx` from a drag that began at `startYaw`. */
export function turntableYawFromDrag(
  startYaw: number,
  deltaDevicePx: number,
  radiansPerDevicePx = TURNTABLE_DRAG_RADIANS_PER_DEVICE_PX,
): number {
  return startYaw + deltaDevicePx * radiansPerDevicePx;
}

/**
 * Next zoom for a wheel event: exponential curve (equal notches = equal
 * FACTORS, so zooming feels symmetric in and out), clamped to the shared
 * range. `deltaMode` 1 (lines) is normalized to pixels.
 */
export function nextTurntableZoom(
  current: number,
  wheelDeltaY: number,
  deltaMode = 0,
  min = TURNTABLE_ZOOM_MIN,
  max = TURNTABLE_ZOOM_MAX,
): number {
  const deltaPx = deltaMode === 1 ? wheelDeltaY * WHEEL_LINE_PX : wheelDeltaY;
  return clampTurntableZoom(current * Math.exp(-deltaPx * TURNTABLE_ZOOM_WHEEL_SENSITIVITY), min, max);
}

/**
 * One interactive model behind a host: the surface owns yaw/zoom state and
 * how they render; the helper owns pointer bookkeeping and the shared math.
 * Omit the zoom pair to leave wheel untouched (native scroll wins).
 */
export interface TurntableTarget {
  getYaw(): number;
  setYaw(yaw: number): void;
  getZoom?(): number;
  setZoom?(zoom: number): void;
  /** Drag lifecycle — surfaces freeze/resume auto-turn here. */
  onDragStart?(): void;
  onDragEnd?(): void;
}

export interface TurntableInteractionOptions {
  /**
   * Resolve the target under a host-local CSS-pixel point, or null to let
   * the event pass (grids, dead margins). Called on pointerdown and wheel.
   */
  targetAt(localX: number, localY: number): TurntableTarget | null;
  radiansPerDevicePx?: number;
  zoomMin?: number;
  zoomMax?: number;
}

/** Attach the shared drag+zoom vocabulary to `host`; returns a disposer. */
export function attachTurntableInteraction(host: HTMLElement, options: TurntableInteractionOptions): () => void {
  const radiansPerDevicePx = options.radiansPerDevicePx ?? TURNTABLE_DRAG_RADIANS_PER_DEVICE_PX;
  const zoomMin = options.zoomMin ?? TURNTABLE_ZOOM_MIN;
  const zoomMax = options.zoomMax ?? TURNTABLE_ZOOM_MAX;

  const previousTouchAction = host.style.touchAction;
  const previousCursor = host.style.cursor;
  host.style.touchAction = "none";
  host.style.cursor = "grab";

  let drag: {
    readonly pointerId: number;
    readonly target: TurntableTarget;
    readonly startClientX: number;
    readonly startYaw: number;
    readonly devicePixelRatio: number;
  } | null = null;

  const localPoint = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const endDrag = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.target.setYaw(turntableYawFromDrag(
      drag.startYaw,
      (event.clientX - drag.startClientX) * drag.devicePixelRatio,
      radiansPerDevicePx,
    ));
    drag.target.onDragEnd?.();
    drag = null;
    host.style.cursor = "grab";
    try {
      host.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be gone on cancel — harmless.
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (drag || event.button !== 0 || event.isPrimary === false) return;
    const point = localPoint(event);
    const target = options.targetAt(point.x, point.y);
    if (!target) return;
    drag = {
      pointerId: event.pointerId,
      target,
      startClientX: event.clientX,
      startYaw: target.getYaw(),
      devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
    };
    target.onDragStart?.();
    host.style.cursor = "grabbing";
    try {
      host.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the browser already cancelled the pointer.
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.target.setYaw(turntableYawFromDrag(
      drag.startYaw,
      (event.clientX - drag.startClientX) * drag.devicePixelRatio,
      radiansPerDevicePx,
    ));
    event.preventDefault();
    event.stopPropagation();
  };

  const onWheel = (event: WheelEvent): void => {
    const point = localPoint(event);
    const target = drag?.target ?? options.targetAt(point.x, point.y);
    if (!target?.getZoom || !target.setZoom) return;
    target.setZoom(nextTurntableZoom(target.getZoom(), event.deltaY, event.deltaMode, zoomMin, zoomMax));
    event.preventDefault();
    event.stopPropagation();
  };

  // Capture phase for pointers: turntable wells can host decorative children
  // and the drag must win before any of them see the event (the pattern the
  // inventory drag hosts already relied on). Wheel bubbles: it only needs to
  // beat ANCESTOR scrolling, and passive:false is required for preventDefault.
  host.addEventListener("pointerdown", onPointerDown, { capture: true });
  host.addEventListener("pointermove", onPointerMove, { capture: true });
  host.addEventListener("pointerup", endDrag, { capture: true });
  host.addEventListener("pointercancel", endDrag, { capture: true });
  host.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    host.removeEventListener("pointerdown", onPointerDown, { capture: true });
    host.removeEventListener("pointermove", onPointerMove, { capture: true });
    host.removeEventListener("pointerup", endDrag, { capture: true });
    host.removeEventListener("pointercancel", endDrag, { capture: true });
    host.removeEventListener("wheel", onWheel);
    host.style.touchAction = previousTouchAction;
    host.style.cursor = previousCursor;
    drag = null;
  };
}
