/**
 * TOASTS — transient field notices over the log's top-right corner.
 * Cooldowns (the 30s autosample ruling), connection turns, macro states.
 */

import type { Surface } from "../term/surface";
import { stringWidth } from "../term/surface";
import type { Palette, Rect } from "./styles";

export type ToastTone = "info" | "warn" | "danger";

interface Toast {
  text: string;
  tone: ToastTone;
  untilMs: number;
}

export class ToastStack {
  private readonly toasts: Toast[] = [];

  push(text: string, tone: ToastTone = "info", ttlMs = 4_000, now = Date.now()): void {
    // replace an identical live toast instead of stacking dupes
    const existing = this.toasts.findIndex((toast) => toast.text === text);
    if (existing !== -1) this.toasts.splice(existing, 1);
    this.toasts.push({ text, tone, untilMs: now + ttlMs });
    if (this.toasts.length > 4) this.toasts.splice(0, this.toasts.length - 4);
  }

  render(surface: Surface, rect: Rect, palette: Palette, now = Date.now()): void {
    for (let i = this.toasts.length - 1; i >= 0; i -= 1) {
      if (this.toasts[i]!.untilMs <= now) this.toasts.splice(i, 1);
    }
    let y = rect.y;
    for (const toast of this.toasts) {
      if (y >= rect.y + rect.h) break;
      const label = ` ${toast.text} `;
      const w = Math.min(stringWidth(label), rect.w - 2);
      const x = rect.x + rect.w - w - 1;
      const styleFor = toast.tone === "danger" ? palette.dangerBold : toast.tone === "warn" ? palette.amber : palette.dim;
      surface.text(x, y, label, styleFor, rect.x + rect.w);
      y += 1;
    }
  }

  get size(): number {
    return this.toasts.length;
  }
}
