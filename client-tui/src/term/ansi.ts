/**
 * ANSI primitives — the only module that writes escape bytes.
 *
 * Everything upstream deals in packed styles (style.ts) and cell buffers
 * (surface.ts); this file turns them into the smallest correct byte stream
 * for the active color mode.
 */

import type { ColorMode } from "../theme";

export const ESC = "\u001b";
export const CSI = `${ESC}[`;

export const enterAltScreen = `${CSI}?1049h`;
export const leaveAltScreen = `${CSI}?1049l`;
export const hideCursor = `${CSI}?25l`;
export const showCursor = `${CSI}?25h`;
export const clearScreen = `${CSI}2J${CSI}H`;
export const resetSgr = `${CSI}0m`;
/** Synchronized output (mode 2026): terminals batch the frame atomically. */
export const beginSync = `${CSI}?2026h`;
export const endSync = `${CSI}?2026l`;
export const enableBracketedPaste = `${CSI}?2004h`;
export const disableBracketedPaste = `${CSI}?2004l`;

export function cursorTo(row: number, col: number): string {
  return `${CSI}${row + 1};${col + 1}H`;
}

export function windowTitle(title: string): string {
  return `${ESC}]0;${title}\u0007`;
}

// ── packed style ────────────────────────────────────────────────────────────
//
// fg/bg: -1 = terminal default, otherwise 0xRRGGBB.
// attrs: bitfield below. A packed Style is { fg, bg, attrs } flattened into
// the surface's typed arrays — this module only needs the transition emitter.

export const ATTR_BOLD = 1;
export const ATTR_DIM = 2;
export const ATTR_ITALIC = 4;
export const ATTR_UNDERLINE = 8;

export const DEFAULT_COLOR = -1;

/**
 * Emit the minimal SGR transition from (prevFg, prevBg, prevAttrs) to the
 * target triple. Returns "" when nothing changes. Attribute REMOVAL forces a
 * reset-and-rebuild (SGR has no reliable un-bold across terminals).
 */
export function sgrTransition(
  mode: ColorMode,
  prevFg: number,
  prevBg: number,
  prevAttrs: number,
  fg: number,
  bg: number,
  attrs: number,
): string {
  if (prevFg === fg && prevBg === bg && prevAttrs === attrs) return "";
  const removing = (prevAttrs & ~attrs) !== 0;
  const parts: string[] = [];
  if (removing) {
    parts.push("0");
    prevFg = DEFAULT_COLOR;
    prevBg = DEFAULT_COLOR;
    prevAttrs = 0;
  }
  const adding = attrs & ~prevAttrs;
  if (adding & ATTR_BOLD) parts.push("1");
  if (adding & ATTR_DIM) parts.push("2");
  if (adding & ATTR_ITALIC) parts.push("3");
  if (adding & ATTR_UNDERLINE) parts.push("4");
  if (fg !== prevFg) pushColor(parts, mode, fg, false);
  if (bg !== prevBg) pushColor(parts, mode, bg, true);
  if (parts.length === 0) return "";
  return `${CSI}${parts.join(";")}m`;
}

function pushColor(parts: string[], mode: ColorMode, color: number, isBg: boolean): void {
  if (mode === "mono") return;
  if (color === DEFAULT_COLOR) {
    parts.push(isBg ? "49" : "39");
    return;
  }
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  if (mode === "truecolor") {
    parts.push(isBg ? "48" : "38", "2", String(r), String(g), String(b));
    return;
  }
  parts.push(isBg ? "48" : "38", "5", String(rgbTo256(r, g, b)));
}

/** 24-bit → xterm-256 (6×6×6 cube or grayscale ramp, nearest by channel). */
export function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const to6 = (v: number): number => (v < 48 ? 0 : v < 114 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  return 16 + 36 * to6(r) + 6 * to6(g) + to6(b);
}

export function packRgb(rgb: readonly [number, number, number]): number {
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}
