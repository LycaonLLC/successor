import "./overlay.css";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import type { ScreenPoint } from "../render/camera";
import { drawSpatialBubbles } from "./bubbles";
import { drawFloatingTexts } from "./floatingTexts";
import { drawInteractChip } from "./interactChip";
import { paintNameplates, placeNameplates } from "./nameplates";
import { drawTargetBracket } from "./targetBracket";
import type { ScreenRect } from "./screenPlacement";

export interface OverlayWorldProjector {
  worldToScreen: (x: number, z: number, y?: number) => ScreenPoint;
}

export interface OverlayFrameStats {
  nameplateCount: number;
  bubbleCount: number;
  /** Opaque actor keys whose bubbles were actually painted this frame. */
  bubbleActorKeys: readonly string[];
}

export interface Successor3dOverlayLayer {
  projector: OverlayWorldProjector;
  canvas: HTMLCanvasElement;
  render: (slice: SliceSnapshot, state: PlayState, timeMs: number) => OverlayFrameStats;
  dispose: () => void;
}

export function createOverlayLayer(host: HTMLElement, projector: OverlayWorldProjector): Successor3dOverlayLayer {
  const canvas = document.createElement("canvas");
  canvas.className = "successor3d-overlay-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D overlay canvas unavailable");
  const context = ctx;
  let cssWidth = 0;
  let cssHeight = 0;
  let dpr = 1;
  const bubbleActorKeys: string[] = [];
  /** One mutable occupancy list reused every frame (cleared, never reallocated). */
  const occupied: ScreenRect[] = [];

  function resize(): void {
    const rect = host.getBoundingClientRect();
    const nextCssWidth = Math.max(1, Math.floor(rect.width || window.innerWidth));
    const nextCssHeight = Math.max(1, Math.floor(rect.height || window.innerHeight));
    const nextDpr = Math.max(1, window.devicePixelRatio || 1);
    if (nextCssWidth === cssWidth && nextCssHeight === cssHeight && nextDpr === dpr) return;
    cssWidth = nextCssWidth;
    cssHeight = nextCssHeight;
    dpr = nextDpr;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  return {
    projector,
    canvas,
    render(slice, state, timeMs) {
      resize();
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);
      // Blood belongs to the in-world particle layer. This canvas is reserved
      // for projected labels, targeting, interaction, and combat text.
      //
      // Occupancy chain (one mutable list, presentation only):
      //  1) nameplates place/claim seats — local followed actor, then current target
      //  2) target bracket (no occupancy — world chrome)
      //  3) interact chip (publishes rect for next-frame plate whisper only)
      //  4) floating combat text avoids plates + sibling ticks, claims seats
      //  5) spatial bubbles avoid plates, combat text, and other stacks
      //  6) nameplates paint last so glyphs sit above bubble tails / underlays
      // Floating + bubbles already yield seats to plates; paint order only
      // fixes crossing tails and dense-fallback underlaps.
      occupied.length = 0;
      const nameplates = placeNameplates(
        context,
        projector,
        slice,
        state,
        timeMs,
        cssWidth,
        cssHeight,
        occupied,
      );
      drawTargetBracket(context, projector, state, timeMs, cssWidth, cssHeight);
      // World-anchored use indicator — under floating combat texts, above the
      // bracket (a damage number must never lose to a USE affordance).
      drawInteractChip(context, projector, slice, state, timeMs, cssWidth, cssHeight);
      drawFloatingTexts(context, projector, state, cssWidth, cssHeight, occupied);
      const bubbles = drawSpatialBubbles(
        context,
        projector,
        slice,
        state,
        timeMs,
        cssWidth,
        cssHeight,
        occupied,
        bubbleActorKeys,
      );
      // Single nameplate paint pass after underlays (no duplicate repaint).
      paintNameplates(context, nameplates);
      return {
        nameplateCount: nameplates.count,
        bubbleCount: bubbles.count,
        bubbleActorKeys,
      };
    },
    dispose() {
      canvas.remove();
    },
  };
}
