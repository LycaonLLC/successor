import { spatialBubblesForActor, wrapSpeechBubbleText } from "@successor/client/src/slice-core/spatialBubbleSystem";
import type { PlayState, SliceSnapshot, SpatialChatBubble } from "@successor/client/src/slice-core/gameState";
import { spatialBubbleFadeInMs, spatialBubbleFadeOutMs } from "@successor/client/src/slice-core/gameTuning";
import { clamp } from "@successor/client/src/slice-core/geometry";
import { actorDrawEntries } from "@successor/client/src/slice-core/actorPresentationSystem";
import { OVERLAY_FONT_STACK } from "./font";
import type { OverlayWorldProjector } from "./index";
import {
  claimScreenRect,
  compareActorId,
  overlayViewportBounds,
  placeScreenRect,
  type ScreenRect,
} from "./screenPlacement";

export interface BubbleFrameResult {
  count: number;
}


interface LaidBubble {
  bubble: SpatialChatBubble;
  lines: string[];
  width: number;
  height: number;
  hasSpeakerTail: boolean;
  tail: number;
  localX: number;
  localY: number;
}

interface PlacedBubbleStack {
  speakerX: number;
  speakerY: number;
  dx: number;
  dy: number;
  laid: LaidBubble[];
}

function measureBubbleStack(
  ctx: CanvasRenderingContext2D,
  bubbles: SpatialChatBubble[],
  speakerX: number,
  speakerY: number,
): { laid: LaidBubble[]; preferred: ScreenRect } | null {
  if (bubbles.length === 0) return null;

  const paddingX = 8;
  const paddingY = 5;
  const lineHeight = 14;
  const gap = 5;
  const tailHeight = 14;
  const maxTextWidth = 228;
  const minBubbleWidth = 58;
  const maxLines = 4;

  ctx.font = `400 11px ${OVERLAY_FONT_STACK}`;
  const laid: LaidBubble[] = [];
  let nextTipX = speakerX;
  let nextTipY = speakerY;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [index, bubble] of bubbles.entries()) {
    const lines = wrapSpeechBubbleText(ctx, bubble.body, maxTextWidth, maxLines);
    const textWidth = Math.max(
      ...lines.map((line) => ctx.measureText(line).width),
      minBubbleWidth - paddingX * 2,
    );
    const width = Math.ceil(textWidth + paddingX * 2);
    const height = paddingY * 2 + lines.length * lineHeight;
    const hasSpeakerTail = index === 0;
    const tail = hasSpeakerTail ? tailHeight : 7;
    const x = nextTipX - width / 2;
    const y = nextTipY - height - tail;
    laid.push({ bubble, lines, width, height, hasSpeakerTail, tail, localX: x, localY: y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    // Include the speaker tail in the collision box so stacks clear nameplates.
    maxY = Math.max(maxY, y + height + (hasSpeakerTail ? tail : 0));
    nextTipX = x + width / 2;
    nextTipY = y - gap;
  }

  return {
    laid,
    preferred: {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
    },
  };
}

function paintBubbleStack(
  ctx: CanvasRenderingContext2D,
  stack: PlacedBubbleStack,
): void {
  const paddingX = 8;
  const paddingY = 5;
  const lineHeight = 14;
  const { speakerX, speakerY, dx, dy, laid } = stack;

  ctx.save();
  ctx.font = `400 11px ${OVERLAY_FONT_STACK}`;
  ctx.textBaseline = "top";

  for (const item of laid) {
    const x = item.localX + dx;
    const y = item.localY + dy;
    const ageMs = item.bubble.totalTtlMs - item.bubble.ttlMs;
    const fadeIn = clamp(ageMs / spatialBubbleFadeInMs, 0, 1);
    const fadeOut = clamp(item.bubble.ttlMs / spatialBubbleFadeOutMs, 0, 1);
    const opacity = Math.min(1, fadeIn, fadeOut);
    const settleOffset = (1 - fadeIn) * 3 - (1 - fadeOut) * 4;
    // First tail stays aimed at the unshifted speaker so actor attribution
    // holds when the stack box slides to clear a nameplate.
    const tailTipX = item.hasSpeakerTail ? speakerX : (item.localX + item.width / 2 + dx);
    const tailTipY = item.hasSpeakerTail
      ? speakerY
      : (item.localY + item.height + item.tail + dy);
    const tailBaseX = clamp(tailTipX, x + 18, x + item.width - 18);

    ctx.globalAlpha = opacity;
    speechBubblePath(ctx, {
      x,
      y: y + settleOffset,
      width: item.width,
      height: item.height,
      radius: 6,
      tailBaseX,
      tailTipX,
      tailTipY: tailTipY + settleOffset,
      tailWidth: item.hasSpeakerTail ? 18 : 12,
    });
    ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.94)";
    ctx.lineWidth = 1.25;
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(0, 0, 0, 0.88)";
    for (let lineIndex = 0; lineIndex < item.lines.length; lineIndex += 1) {
      ctx.fillText(
        item.lines[lineIndex] ?? "",
        x + paddingX,
        y + settleOffset + paddingY + lineIndex * lineHeight,
      );
    }
  }

  ctx.restore();
}

function speechBubblePath(
  ctx: CanvasRenderingContext2D,
  bubble: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
    tailBaseX: number;
    tailTipX: number;
    tailTipY: number;
    tailWidth: number;
  },
): void {
  const { x, y, width, height, radius, tailBaseX, tailTipX, tailTipY, tailWidth } = bubble;
  const bottom = y + height;
  const tailLeft = clamp(tailBaseX - tailWidth / 2, x + radius, x + width - radius);
  const tailRight = clamp(tailBaseX + tailWidth / 2, x + radius, x + width - radius);

  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, bottom - radius);
  ctx.quadraticCurveTo(x + width, bottom, x + width - radius, bottom);
  ctx.lineTo(tailRight, bottom);
  ctx.lineTo(tailTipX, tailTipY);
  ctx.lineTo(tailLeft, bottom);
  ctx.lineTo(x + radius, bottom);
  ctx.quadraticCurveTo(x, bottom, x, bottom - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export function drawSpatialBubbles(
  ctx: CanvasRenderingContext2D,
  projector: OverlayWorldProjector,
  slice: SliceSnapshot,
  state: PlayState,
  timeMs: number,
  width: number,
  height: number,
  occupied: ScreenRect[],
  renderedActorKeys?: string[],
): BubbleFrameResult {
  if (renderedActorKeys) renderedActorKeys.length = 0;
  if (state.chatBubbles.length === 0) return { count: 0 };

  const followActorId = slice.camera.followActor;
  type StackJob = {
    actorId: string;
    bubbles: SpatialChatBubble[];
    speakerX: number;
    speakerY: number;
    priority: number;
  };
  const jobs: StackJob[] = [];

  for (const entry of actorDrawEntries(slice, state, timeMs)) {
    const actorBubbles = spatialBubblesForActor(state.chatBubbles, entry.actor.id, followActorId);
    if (actorBubbles.length === 0) continue;
    // Anchor at head height in world space. A ground anchor plus fixed pixel
    // lift drifts at low zoom; bubbles should stay just above the nameplate.
    const anchor = projector.worldToScreen(entry.pos.x + 0.5, entry.pos.y + 0.5, 1.75);
    const speakerY = anchor.py - 52;
    if (anchor.px < -260 || anchor.px > width + 260 || speakerY < -260 || speakerY > height + 260) {
      continue;
    }
    jobs.push({
      actorId: entry.actor.id,
      bubbles: actorBubbles,
      speakerX: anchor.px,
      speakerY,
      priority: entry.actor.id === followActorId ? 0 : 1,
    });
  }

  // Place/claim in priority order; actor-key report follows placement priority.
  jobs.sort((a, b) => (
    a.priority - b.priority
    || a.speakerY - b.speakerY
    || compareActorId(a.actorId, b.actorId)
  ));

  // Shared overlay viewport (right dock reserved). Bubble stacks use the same
  // seat bounds as nameplates/floating text so chat never slides under the rail.
  const viewBounds = overlayViewportBounds(width, height);

  const placedStacks: PlacedBubbleStack[] = [];
  let count = 0;
  ctx.save();
  ctx.font = `400 11px ${OVERLAY_FONT_STACK}`;

  for (const job of jobs) {
    renderedActorKeys?.push(job.actorId);
    const measured = measureBubbleStack(ctx, job.bubbles, job.speakerX, job.speakerY);
    if (!measured) continue;
    const placed = placeScreenRect(measured.preferred, occupied, viewBounds, {
      preferAxis: "y",
      maxShiftX: 80,
      maxShiftY: 110,
      step: 10,
      pad: 4,
    });
    placedStacks.push({
      speakerX: job.speakerX,
      speakerY: job.speakerY,
      dx: placed.dx,
      dy: placed.dy,
      laid: measured.laid,
    });
    claimScreenRect(occupied, placed.rect);
    count += job.bubbles.length;
  }
  ctx.restore();

  // Paint reverse: low-priority stacks first, follow-actor stack last/top.
  for (let i = placedStacks.length - 1; i >= 0; i -= 1) {
    paintBubbleStack(ctx, placedStacks[i]!);
  }

  return { count };
}
