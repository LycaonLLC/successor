import {
  spatialBubbleMaxStack,
  spatialBubbleMaxTtlMs,
  spatialBubbleMinTtlMs,
  spatialBubbleMsPerChar,
} from "./gameTuning";
import type { SpatialChatBubble } from "./gameState";
import { clamp } from "./geometry";

interface BubbleTextMeasurer {
  measureText(text: string): { width: number };
}

export interface SpatialBubbleState {
  chatBubbles: SpatialChatBubble[];
}

export function enqueueSpatialBubble(
  state: SpatialBubbleState,
  message: { body: string; sender: string; own: boolean; actorId?: string },
) {
  const text = message.body.trim();
  if (!text) return;
  const ttlMs = spatialBubbleTtlMs(text);
  state.chatBubbles.unshift({
    ...message,
    body: text,
    ttlMs,
    totalTtlMs: ttlMs,
  });
  if (state.chatBubbles.length > spatialBubbleMaxStack) {
    state.chatBubbles.length = spatialBubbleMaxStack;
  }
}

export function spatialBubblesForActor(
  bubbles: SpatialChatBubble[],
  actorId: string,
  fallbackActorId: string,
): SpatialChatBubble[] {
  return bubbles.filter((bubble) => {
    // An actorId property marks a network/actor-owned bubble, even when the
    // value is missing or no longer resolves. Never route those to the local
    // fallback; only bubbles created without actor ownership may use it.
    if ("actorId" in bubble) return bubble.actorId === actorId;
    return fallbackActorId === actorId;
  });
}

export function spatialBubbleTtlMs(body: string): number {
  return clamp(body.length * spatialBubbleMsPerChar, spatialBubbleMinTtlMs, spatialBubbleMaxTtlMs);
}

export function wrapSpeechBubbleText(
  ctx: BubbleTextMeasurer,
  body: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = body.replace(/\s+/gu, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (ctx.measureText(line).width > maxWidth) {
      const splitAt = splitWordAtWidth(ctx, line, maxWidth);
      lines.push(line.slice(0, splitAt));
      line = line.slice(splitAt);
    }
  }

  if (line) lines.push(line);
  return withTrailingEllipsis(ctx, lines, maxWidth, maxLines);
}

function splitWordAtWidth(ctx: BubbleTextMeasurer, word: string, maxWidth: number): number {
  for (let index = 1; index < word.length; index += 1) {
    if (ctx.measureText(word.slice(0, index + 1)).width > maxWidth) return index;
  }
  return word.length;
}

function withTrailingEllipsis(
  ctx: BubbleTextMeasurer,
  lines: string[],
  maxWidth: number,
  maxLines: number,
): string[] {
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  let last = visible[maxLines - 1] ?? "";
  while (last.length > 0 && ctx.measureText(`${last}...`).width > maxWidth) {
    last = last.slice(0, -1);
  }
  visible[maxLines - 1] = `${last}...`;
  return visible;
}
