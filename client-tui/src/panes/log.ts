/**
 * LOG — the hero pane. The MUD's whole voice scrolls here.
 *
 * Owns the line store (cap 500), wrap cache, and scroll state. New lines
 * pin to the bottom unless the reader has scrolled up, in which case a
 * "── more below ──" rule marks held-back speech. Rejections lead with a
 * stamped glyph; scene lines breathe in italic haze.
 */

import { wrapText } from "../term/surface";
import type { Surface } from "../term/surface";
import type { LogLine } from "../language/narrator";
import { registerStyle, type Palette, type Rect } from "./styles";

const CAPACITY = 500;

interface WrappedCache {
  width: number;
  rows: string[];
}

interface StoredLine extends LogLine {
  wrapped: WrappedCache | null;
}

export class LogPane {
  private readonly lines: StoredLine[] = [];
  /** 0 = pinned to live tail; >0 = rows scrolled back. */
  private scrollback = 0;

  push(line: LogLine): void {
    this.lines.push({ ...line, wrapped: null });
    if (this.lines.length > CAPACITY) this.lines.splice(0, this.lines.length - CAPACITY);
    if (this.scrollback > 0) this.scrollback += 0; // held position; rule shows more below
  }

  scroll(deltaRows: number, pageRows: number): void {
    const total = this.lines.length * 2; // cheap upper bound; clamped in render
    this.scrollback = Math.max(0, Math.min(total, this.scrollback + deltaRows * pageRows));
  }

  pinToLive(): void {
    this.scrollback = 0;
  }

  render(surface: Surface, rect: Rect, palette: Palette): void {
    if (rect.w < 8 || rect.h < 1) return;
    const width = rect.w - 1; // right breathing column
    // Collect wrapped rows bottom-up until the pane is full.
    const rows: Array<{ text: string; register: string }> = [];
    for (let i = this.lines.length - 1; i >= 0 && rows.length < rect.h + this.scrollback + 1; i -= 1) {
      const line = this.lines[i]!;
      if (!line.wrapped || line.wrapped.width !== width) {
        line.wrapped = { width, rows: wrapText(decorate(line), width) };
      }
      for (let r = line.wrapped.rows.length - 1; r >= 0; r -= 1) {
        rows.push({ text: line.wrapped.rows[r]!, register: line.register });
      }
      // paragraph breathing: blank row before scene blocks
      if (line.register === "scene") rows.push({ text: "", register: "pad" });
    }
    const maxScroll = Math.max(0, rows.length - rect.h);
    if (this.scrollback > maxScroll) this.scrollback = maxScroll;
    const start = this.scrollback; // rows from the bottom
    let y = rect.y + rect.h - 1;
    for (let r = start; r < rows.length && y >= rect.y; r += 1) {
      const row = rows[r]!;
      if (row.text.length > 0) {
        surface.text(rect.x, y, row.text, registerStyle(palette, row.register), rect.x + rect.w);
      }
      y -= 1;
    }
    if (this.scrollback > 0) {
      const label = "── more below ──";
      surface.text(rect.x + Math.max(0, Math.floor((rect.w - label.length) / 2)), rect.y + rect.h - 1, label, palette.faint);
    }
  }
}

function decorate(line: LogLine): string {
  if (line.register === "reject") return `✗ ${line.text}`;
  if (line.register === "survey" || line.register === "loot") return `◆ ${line.text}`;
  if (line.register === "system") return `· ${line.text}`;
  if (line.register === "echo") return `› ${line.text}`;
  return line.text;
}
