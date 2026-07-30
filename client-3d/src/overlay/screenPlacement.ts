/**
 * Shared screen-rect placement for world overlays (nameplates, bubbles,
 * floating combat text). Presentation-only: never mutates gameplay state.
 *
 * Invariants:
 *  - Placement is deterministic from preferred rect + occupied set + bounds.
 *  - Priority callers place first; later callers only avoid already-claimed rects.
 *  - Shifts are bounded; every label stays attributable (never hidden for space).
 *  - On-screen clamp keeps the rect inside the viewport margin when possible.
 *  - Interact-chip precedence stays outside this helper (whisper alpha on plates).
 *  - Offset tables are memoized; per-frame drawers share one mutable occupied list.
 */

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlaceScreenRectOptions {
  /** Horizontal search radius in px (inclusive). Default 72. */
  maxShiftX?: number;
  /** Vertical search radius in px (inclusive). Default 96. */
  maxShiftY?: number;
  /** Grid step in px. Default 10. */
  step?: number;
  /** Extra separation between rects. Default 2. */
  pad?: number;
  /**
   * Axis bias for the candidate walk:
   *  - "y": prefer vertical motion (nameplates, bubble stacks)
   *  - "x": prefer lateral motion
   *  - "yx": balanced diamond (floating combat text)
   */
  preferAxis?: "y" | "x" | "yx";
}

export interface PlaceScreenRectResult {
  rect: ScreenRect;
  dx: number;
  dy: number;
}

const DEFAULT_MAX_SHIFT_X = 72;
const DEFAULT_MAX_SHIFT_Y = 96;
const DEFAULT_STEP = 10;
const DEFAULT_PAD = 2;

/**
 * Fixed right HUD dock (.sc3d-dock: right 10px + 36px button + pad/border)
 * occludes ~58px. Reserve 64px so world labels never sit under the rail.
 */
export const OVERLAY_RIGHT_DOCK_RESERVE_PX = 64;
/** Uniform edge margin on left/top/bottom (and residual right slack). */
export const OVERLAY_VIEWPORT_EDGE_PX = 4;

/**
 * Screen bounds available to world overlays inside a cssWidth×cssHeight canvas.
 * Right edge yields to the fixed dock; other edges keep the small edge margin.
 * Tiny viewports still produce a non-inverted rect (at least 1×1).
 */
export function overlayViewportBounds(width: number, height: number): ScreenRect {
  const edge = OVERLAY_VIEWPORT_EDGE_PX;
  const rightReserve = Math.max(edge, OVERLAY_RIGHT_DOCK_RESERVE_PX);
  const left = edge;
  const top = edge;
  const right = Math.max(left + 1, width - rightReserve);
  const bottom = Math.max(top + 1, height - edge);
  return { left, top, right, bottom };
}

export function screenRectWidth(rect: ScreenRect): number {
  return rect.right - rect.left;
}

export function screenRectHeight(rect: ScreenRect): number {
  return rect.bottom - rect.top;
}

export function screenRectFromCenter(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
): ScreenRect {
  const halfW = width * 0.5;
  const halfH = height * 0.5;
  return {
    left: centerX - halfW,
    top: centerY - halfH,
    right: centerX + halfW,
    bottom: centerY + halfH,
  };
}

export function screenRectFromBaseline(
  centerX: number,
  baselineY: number,
  width: number,
  ascent: number,
  descent: number,
): ScreenRect {
  const halfW = width * 0.5;
  return {
    left: centerX - halfW,
    top: baselineY - ascent,
    right: centerX + halfW,
    bottom: baselineY + descent,
  };
}

export function shiftScreenRect(rect: ScreenRect, dx: number, dy: number): ScreenRect {
  if (dx === 0 && dy === 0) return rect;
  return {
    left: rect.left + dx,
    top: rect.top + dy,
    right: rect.right + dx,
    bottom: rect.bottom + dy,
  };
}

export function screenRectsOverlap(a: ScreenRect, b: ScreenRect, pad = 0): boolean {
  return !(
    a.right + pad <= b.left
    || a.left - pad >= b.right
    || a.bottom + pad <= b.top
    || a.top - pad >= b.bottom
  );
}

export function screenRectHitsAny(
  rect: ScreenRect,
  occupied: readonly ScreenRect[],
  pad = 0,
): boolean {
  for (let i = 0; i < occupied.length; i += 1) {
    const other = occupied[i];
    if (other && screenRectsOverlap(rect, other, pad)) return true;
  }
  return false;
}

/** Translate rect so it fits inside bounds when the rect is smaller than bounds. */
export function clampScreenRect(rect: ScreenRect, bounds: ScreenRect): ScreenRect {
  const width = screenRectWidth(rect);
  const height = screenRectHeight(rect);
  const boundsW = screenRectWidth(bounds);
  const boundsH = screenRectHeight(bounds);

  let left = rect.left;
  let top = rect.top;

  if (width >= boundsW) {
    left = bounds.left + (boundsW - width) * 0.5;
  } else {
    if (left < bounds.left) left = bounds.left;
    if (left + width > bounds.right) left = bounds.right - width;
  }

  if (height >= boundsH) {
    top = bounds.top + (boundsH - height) * 0.5;
  } else {
    if (top < bounds.top) top = bounds.top;
    if (top + height > bounds.bottom) top = bounds.bottom - height;
  }

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
  };
}

function candidateScore(
  dx: number,
  dy: number,
  preferAxis: "y" | "x" | "yx",
): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // Prefer upward (-y) slightly over downward so stacked actors rise cleanly.
  const yBias = dy < 0 ? 0 : dy > 0 ? 1.15 : 0;
  // Lower score wins. Prefer-axis means the OTHER axis is penalized (costlier),
  // so motion along the preferred axis sorts first.
  if (preferAxis === "y") return ax * 2 + ay + yBias;
  if (preferAxis === "x") return ay * 2 + ax + yBias;
  return ax + ay + yBias * 0.25;
}

/**
 * Axis steps from 0 outward: 0, +step, -step, +2step, -2step, ... up to max.
 * Guarantees 0 is always present even when max is not divisible by step.
 */
function axisSteps(maxShift: number, step: number): number[] {
  const safeStep = Math.max(1, Math.floor(step));
  const max = Math.max(0, Math.floor(maxShift));
  const values: number[] = [0];
  for (let mag = safeStep; mag <= max; mag += safeStep) {
    values.push(mag, -mag);
  }
  // Include the exact bound when it is not on the step grid (e.g. 64 with step 10).
  if (max > 0 && max % safeStep !== 0) {
    values.push(max, -max);
  }
  return values;
}

/**
 * Build a deterministic candidate offset list.
 * Always starts with (0,0); then filled grid sorted by score.
 */
export function buildPlacementOffsets(
  maxShiftX = DEFAULT_MAX_SHIFT_X,
  maxShiftY = DEFAULT_MAX_SHIFT_Y,
  step = DEFAULT_STEP,
  preferAxis: "y" | "x" | "yx" = "y",
): ReadonlyArray<readonly [number, number]> {
  const xs = axisSteps(maxShiftX, step);
  const ys = axisSteps(maxShiftY, step);
  const points: Array<{ dx: number; dy: number; score: number; order: number }> = [];
  let order = 0;
  for (let yi = 0; yi < ys.length; yi += 1) {
    const dy = ys[yi]!;
    for (let xi = 0; xi < xs.length; xi += 1) {
      const dx = xs[xi]!;
      points.push({
        dx,
        dy,
        score: candidateScore(dx, dy, preferAxis),
        order: order++,
      });
    }
  }
  points.sort((a, b) => a.score - b.score || a.order - b.order);
  return points.map((p) => [p.dx, p.dy] as const);
}

/** Small module cache — offset tables are pure in (maxX, maxY, step, axis). */
const offsetCache = new Map<string, ReadonlyArray<readonly [number, number]>>();

function cachedOffsets(
  maxShiftX: number,
  maxShiftY: number,
  step: number,
  preferAxis: "y" | "x" | "yx",
): ReadonlyArray<readonly [number, number]> {
  const key = `${maxShiftX}|${maxShiftY}|${step}|${preferAxis}`;
  let cached = offsetCache.get(key);
  if (!cached) {
    cached = buildPlacementOffsets(maxShiftX, maxShiftY, step, preferAxis);
    offsetCache.set(key, cached);
  }
  return cached;
}

// Warm common caller tables once at module load.
const OFFSETS_DEFAULT_Y = cachedOffsets(DEFAULT_MAX_SHIFT_X, DEFAULT_MAX_SHIFT_Y, DEFAULT_STEP, "y");
const OFFSETS_NAMEPLATE = cachedOffsets(64, 88, 10, "y");
const OFFSETS_BUBBLE = cachedOffsets(80, 110, 10, "y");
const OFFSETS_FLOAT_CALLER = cachedOffsets(48, 56, 8, "yx");

void OFFSETS_DEFAULT_Y;
void OFFSETS_NAMEPLATE;
void OFFSETS_BUBBLE;
void OFFSETS_FLOAT_CALLER;

/**
 * Place `preferred` against `occupied` inside `bounds`.
 * Tries bounded offsets in deterministic order; clamps each candidate.
 * If every candidate collides, returns the least-overlap clamped rect (still visible).
 */
export function placeScreenRect(
  preferred: ScreenRect,
  occupied: readonly ScreenRect[],
  bounds: ScreenRect,
  options: PlaceScreenRectOptions = {},
): PlaceScreenRectResult {
  const pad = options.pad ?? DEFAULT_PAD;
  const preferAxis = options.preferAxis ?? "y";
  const maxShiftX = options.maxShiftX ?? DEFAULT_MAX_SHIFT_X;
  const maxShiftY = options.maxShiftY ?? DEFAULT_MAX_SHIFT_Y;
  const step = options.step ?? DEFAULT_STEP;
  const offsets = cachedOffsets(maxShiftX, maxShiftY, step, preferAxis);

  let bestColliding: PlaceScreenRectResult | null = null;
  let bestHits = Number.POSITIVE_INFINITY;

  for (let i = 0; i < offsets.length; i += 1) {
    const pair = offsets[i]!;
    const dx = pair[0];
    const dy = pair[1];
    const shifted = shiftScreenRect(preferred, dx, dy);
    const clamped = clampScreenRect(shifted, bounds);
    const appliedDx = clamped.left - preferred.left;
    const appliedDy = clamped.top - preferred.top;

    if (!screenRectHitsAny(clamped, occupied, pad)) {
      return { rect: clamped, dx: appliedDx, dy: appliedDy };
    }

    // Track least-overlap fallback so dense piles still keep authority labels.
    let hits = 0;
    for (let j = 0; j < occupied.length; j += 1) {
      const other = occupied[j];
      if (other && screenRectsOverlap(clamped, other, pad)) hits += 1;
    }
    if (hits < bestHits) {
      bestHits = hits;
      bestColliding = { rect: clamped, dx: appliedDx, dy: appliedDy };
    }
  }

  if (bestColliding) return bestColliding;
  const clamped = clampScreenRect(preferred, bounds);
  return {
    rect: clamped,
    dx: clamped.left - preferred.left,
    dy: clamped.top - preferred.top,
  };
}

/**
 * Push the placed rect into the shared per-frame occupied list.
 * Rects from placeScreenRect are fresh objects; no copy needed.
 */
export function claimScreenRect(occupied: ScreenRect[], rect: ScreenRect): void {
  occupied.push(rect);
}

/** Byte-simple lexical compare for locale-independent actor-id tie-breaks. */
export function compareActorId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
