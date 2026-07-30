/**
 * Surface — a cell buffer with the drawing vocabulary the panes speak.
 *
 * Cells carry (char, fg, bg, attrs) in flat typed arrays; the compositor
 * diffs two surfaces into a minimal escape stream. All drawing clips to the
 * surface bounds. Wide glyphs (CJK in chat/names) occupy two cells: the
 * second is a zero-width continuation the compositor skips.
 */

import { ATTR_BOLD, ATTR_DIM, ATTR_ITALIC, ATTR_UNDERLINE, DEFAULT_COLOR, packRgb } from "./ansi";
import type { ThemeColor } from "../theme";

export interface Style {
  fg: number;
  bg: number;
  attrs: number;
}

export interface StyleSpec {
  fg?: ThemeColor | null;
  bg?: ThemeColor | null;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const CONTINUATION = "\u0000";

export function style(spec: StyleSpec = {}): Style {
  return {
    fg: spec.fg ? packRgb(spec.fg.rgb) : DEFAULT_COLOR,
    bg: spec.bg ? packRgb(spec.bg.rgb) : DEFAULT_COLOR,
    attrs: (spec.bold ? ATTR_BOLD : 0)
      | (spec.dim ? ATTR_DIM : 0)
      | (spec.italic ? ATTR_ITALIC : 0)
      | (spec.underline ? ATTR_UNDERLINE : 0),
  };
}

export const PLAIN: Style = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0 };

/**
 * Display width of one code point: 0 for combining/zero-width, 2 for East
 * Asian wide + emoji presentation, else 1. Compact table — the TUI's own
 * chrome is width-1 by construction; this exists for player-authored text.
 */
export function charWidth(codePoint: number): number {
  if (codePoint === 0x200b || (codePoint >= 0x0300 && codePoint <= 0x036f) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) return 2;
  return 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0)!);
  return width;
}

export class Surface {
  readonly width: number;
  readonly height: number;
  readonly chars: string[];
  readonly fg: Int32Array;
  readonly bg: Int32Array;
  readonly attrs: Uint8Array;

  constructor(width: number, height: number) {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    const size = this.width * this.height;
    this.chars = new Array<string>(size).fill(" ");
    this.fg = new Int32Array(size).fill(DEFAULT_COLOR);
    this.bg = new Int32Array(size).fill(DEFAULT_COLOR);
    this.attrs = new Uint8Array(size);
  }

  clear(base: Style = PLAIN): void {
    this.chars.fill(" ");
    this.fg.fill(base.fg);
    this.bg.fill(base.bg);
    this.attrs.fill(base.attrs);
  }

  set(x: number, y: number, ch: string, s: Style): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    this.chars[i] = ch;
    this.fg[i] = s.fg;
    this.bg[i] = s.bg;
    this.attrs[i] = s.attrs;
  }

  /** Paint style over an existing cell without changing its glyph. */
  tint(x: number, y: number, s: Style): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    this.fg[i] = s.fg;
    this.bg[i] = s.bg;
    this.attrs[i] = s.attrs;
  }

  /**
   * Draw text; returns the x just past the last cell written. Clips at
   * `maxX` (exclusive; default surface edge). Wide glyphs write a
   * continuation cell; a wide glyph that would straddle the clip edge is
   * dropped.
   */
  text(x: number, y: number, value: string, s: Style, maxX = this.width): number {
    if (y < 0 || y >= this.height) return x;
    const limit = Math.min(maxX, this.width);
    let cx = x;
    for (const ch of value) {
      if (cx >= limit) break;
      const w = charWidth(ch.codePointAt(0)!);
      if (w === 0) continue;
      if (w === 2) {
        if (cx + 1 >= limit) break;
        if (cx >= 0) {
          this.set(cx, y, ch, s);
          this.set(cx + 1, y, CONTINUATION, s);
        }
        cx += 2;
        continue;
      }
      if (cx >= 0) this.set(cx, y, ch, s);
      cx += 1;
    }
    return cx;
  }

  fillRect(x: number, y: number, w: number, h: number, ch: string, s: Style): void {
    for (let row = y; row < y + h; row += 1) {
      for (let col = x; col < x + w; col += 1) this.set(col, row, ch, s);
    }
  }

  hline(x: number, y: number, w: number, s: Style, ch = "─"): void {
    for (let col = x; col < x + w; col += 1) this.set(col, y, ch, s);
  }

  vline(x: number, y: number, h: number, s: Style, ch = "│"): void {
    for (let row = y; row < y + h; row += 1) this.set(x, row, ch, s);
  }

  /**
   * Hairline frame with an optional stenciled title riding the top rule:
   * `┌ TITLE ────┐`. Titles never overflow; frames of w<2/h<2 no-op.
   */
  box(x: number, y: number, w: number, h: number, s: Style, title?: string, titleStyle?: Style): void {
    if (w < 2 || h < 2) return;
    this.hline(x + 1, y, w - 2, s);
    this.hline(x + 1, y + h - 1, w - 2, s);
    this.vline(x, y + 1, h - 2, s);
    this.vline(x + w - 1, y + 1, h - 2, s);
    this.set(x, y, "┌", s);
    this.set(x + w - 1, y, "┐", s);
    this.set(x, y + h - 1, "└", s);
    this.set(x + w - 1, y + h - 1, "┘", s);
    if (title && w >= 6) {
      const label = ` ${title} `;
      this.text(x + 1, y, label, titleStyle ?? s, x + w - 2);
    }
  }

  /**
   * Horizontal gauge of `w` cells at `frac` (0..1) using eighth-blocks for a
   * sub-cell edge: `█▊  `. Empty track renders as the track glyph.
   */
  gauge(x: number, y: number, w: number, frac: number, fill: Style, track: Style): void {
    const clamped = Math.max(0, Math.min(1, frac));
    const eighths = Math.round(clamped * w * 8);
    const full = Math.floor(eighths / 8);
    const rem = eighths % 8;
    for (let i = 0; i < w; i += 1) {
      if (i < full) this.set(x + i, y, "█", fill);
      else if (i === full && rem > 0) this.set(x + i, y, EIGHTHS[rem]!, fill);
      else this.set(x + i, y, "·", track);
    }
  }
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

/**
 * Braille micro-canvas: (2×4)-dot cells for the radar scope. Plot in dot
 * space (width*2 × height*4), then blit assigns per-cell styles by majority
 * class (caller passes a style resolver keyed on the dot tag).
 */
export class BrailleCanvas {
  readonly cols: number;
  readonly rows: number;
  private readonly dots: Uint8Array;
  private readonly tags: Int8Array;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.dots = new Uint8Array(cols * rows);
    this.tags = new Int8Array(cols * rows).fill(-1);
  }

  get dotWidth(): number {
    return this.cols * 2;
  }

  get dotHeight(): number {
    return this.rows * 4;
  }

  /** Set a dot; `tag` picks the cell's style (highest tag wins per cell). */
  dot(dx: number, dy: number, tag = 0): void {
    if (dx < 0 || dy < 0 || dx >= this.dotWidth || dy >= this.dotHeight) return;
    const cell = Math.floor(dy / 4) * this.cols + Math.floor(dx / 2);
    this.dots[cell]! |= BRAILLE_BITS[(dy % 4) * 2 + (dx % 2)]!;
    if (tag > this.tags[cell]!) this.tags[cell] = tag;
  }

  blit(surface: Surface, x: number, y: number, styleForTag: (tag: number) => Style): void {
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const i = row * this.cols + col;
        const bits = this.dots[i]!;
        if (bits === 0) continue;
        surface.set(x + col, y + row, String.fromCharCode(0x2800 + bits), styleForTag(this.tags[i]!));
      }
    }
  }
}

/** Unicode braille dot numbering: (col,row) → bit. */
const BRAILLE_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80] as const;

/**
 * Greedy word wrap in display cells with a hang indent for continuation
 * lines — the log's typography. Hard-breaks tokens longer than a line.
 */
export function wrapText(text: string, width: number, hangIndent = 2): string[] {
  if (width <= hangIndent + 1) return [text];
  const out: string[] = [];
  const indent = " ".repeat(hangIndent);
  let line = "";
  let lineWidth = 0;
  let limit = width;
  const commit = (): void => {
    out.push(line);
    line = indent;
    lineWidth = hangIndent;
    limit = width;
  };
  for (const word of text.split(" ")) {
    const w = stringWidth(word);
    if (lineWidth > (out.length === 0 ? 0 : hangIndent)) {
      if (lineWidth + 1 + w <= limit) {
        line += ` ${word}`;
        lineWidth += 1 + w;
        continue;
      }
      commit();
    }
    if (w <= limit - lineWidth) {
      line += word;
      lineWidth += w;
      continue;
    }
    // hard-break an over-long token
    for (const ch of word) {
      const cw = charWidth(ch.codePointAt(0)!);
      if (lineWidth + cw > limit) commit();
      line += ch;
      lineWidth += cw;
    }
  }
  out.push(line);
  return out;
}
