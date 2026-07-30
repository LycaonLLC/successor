import type { PlayState } from "@successor/client/src/slice-core/gameState";
import type { OverlayWorldProjector } from "./index";
import {
  claimScreenRect,
  overlayViewportBounds,
  placeScreenRect,
  type ScreenRect,
} from "./screenPlacement";

/**
 * Floating combat texts (targeting v2, 2026-07-03) — damage ticks, XP pops,
 * status shouts. The SHARED authority-event path already spawns and decays
 * `state.floatingTexts` (effectsSystem: value/label, ttl, drift, color,
 * scale); the 3D client just never drew them. World-anchored at the source
 * cell, rising with progress, fading over the last third.
 *
 * Screen placement only deconflicts concurrent ticks against each other and
 * already-claimed seats on the shared occupied list. Drift, fade,
 * reduced-motion, and actor attribution stay with the spawner semantics.
 * Place newest-first (id desc); paint oldest-first so newest stays on top.
 */

const FONT_FAMILY = "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace";
const OUTLINE = "rgba(8, 10, 8, 0.9)";

let reducedMotion = false;
if (typeof matchMedia !== "undefined") {
  const query = matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion = query.matches;
  const onChange = (event: MediaQueryListEvent): void => {
    reducedMotion = event.matches;
  };
  if (typeof query.addEventListener === "function") query.addEventListener("change", onChange);
  else if (typeof query.addListener === "function") query.addListener(onChange);
}

export interface FloatingTextFrameResult {
  count: number;
}

interface PlacedFloatDraw {
  text: string;
  color: string;
  fontPx: number;
  alpha: number;
  px: number;
  py: number;
}

export function drawFloatingTexts(
  ctx: CanvasRenderingContext2D,
  projector: OverlayWorldProjector,
  state: PlayState,
  width: number,
  height: number,
  occupied: ScreenRect[],
): FloatingTextFrameResult {
  const texts = state.floatingTexts;
  if (texts.length === 0) return { count: 0 };

  // Projected cell scale once per frame (same trick the bracket uses).
  const origin = projector.worldToScreen(0, 0, 0);
  const oneCell = projector.worldToScreen(1, 0, 0);
  const pxPerCell = Math.max(10, Math.hypot(oneCell.px - origin.px, oneCell.py - origin.py));

  const bounds = overlayViewportBounds(width, height);

  // Place newest first: monotonic id descending, original index as tie-break.
  const order = texts
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.id - a.item.id || a.index - b.index);

  const draws: PlacedFloatDraw[] = [];
  ctx.save();
  ctx.textAlign = "center";
  // Bottom baseline: py is the foot of the glyph box (matches legacy paint).
  ctx.textBaseline = "bottom";

  for (const { item } of order) {
    const total = Math.max(1, item.totalTtlMs);
    const progress = 1 - Math.max(0, Math.min(1, item.ttlMs / total));
    // x/y arrive PRE-BAKED from the shared spawner: x already cell-centered,
    // y already lifted above the head (−1.55 − stack in simulation-plane coordinates —
    // projects up-left in iso, a natural overhead stagger). No re-centering.
    const screen = projector.worldToScreen(item.x, item.y, 1.2);
    // Reduced motion: hold at the spawn anchor and crossfade only — no drift climb.
    const rise = reducedMotion ? 0 : progress;
    const preferredPx = screen.px + (reducedMotion ? 0 : item.driftX * pxPerCell * 0.4 * progress);
    const preferredPy = screen.py - rise * pxPerCell * 1.1;
    if (preferredPx < -40 || preferredPx > width + 40 || preferredPy < -40 || preferredPy > height + 40) {
      continue;
    }
    const fadeWindow = reducedMotion ? 0.5 : 0.34;
    const life = item.ttlMs / total;
    const alpha = life < fadeWindow ? Math.max(0, life / fadeWindow) : 1;
    // Owner typography ruling: fixed small size, regular weight; spawner's
    // item.scale is the crit/big-damage size-up (screen-fixed, not zoom-fed).
    const fontPx = Math.max(9, Math.round(12 * (item.scale || 1)));
    const text = item.label ?? (item.value !== null ? String(item.value) : "");
    if (!text) continue;

    ctx.font = `400 ${fontPx}px ${FONT_FAMILY}`;
    const boxW = Math.max(14, Math.ceil(ctx.measureText(text).width + 8));
    const boxH = fontPx + 4;
    // textBaseline bottom → entire glyph box sits above preferredPy.
    const preferred: ScreenRect = {
      left: preferredPx - boxW * 0.5,
      top: preferredPy - boxH,
      right: preferredPx + boxW * 0.5,
      bottom: preferredPy,
    };
    const placed = placeScreenRect(preferred, occupied, bounds, {
      preferAxis: "yx",
      maxShiftX: 48,
      maxShiftY: 56,
      step: 8,
      pad: 2,
    });
    draws.push({
      text,
      color: item.color,
      fontPx,
      alpha,
      px: (placed.rect.left + placed.rect.right) * 0.5,
      py: placed.rect.bottom,
    });
    claimScreenRect(occupied, placed.rect);
  }

  // Paint reverse: older (placed later) first, newest last/top.
  for (let i = draws.length - 1; i >= 0; i -= 1) {
    const draw = draws[i]!;
    ctx.font = `400 ${draw.fontPx}px ${FONT_FAMILY}`;
    ctx.globalAlpha = draw.alpha;
    ctx.lineWidth = Math.max(2, draw.fontPx / 5);
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(draw.text, draw.px, draw.py);
    ctx.fillStyle = draw.color;
    ctx.fillText(draw.text, draw.px, draw.py);
  }

  ctx.restore();
  return { count: draws.length };
}
