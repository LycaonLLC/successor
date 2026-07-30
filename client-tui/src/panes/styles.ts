/**
 * Resolved style table — theme roles → packed cell styles, built once.
 * Panes never touch raw colors; they name a slot here.
 */

import { SLATE } from "../theme";
import { style, type Style } from "../term/surface";

export interface Palette {
  /** Full-canvas base — explicit soot bg + ink fg so light-theme terminals never wash out. */
  canvas: Style;
  ink: Style;
  inkBold: Style;
  dim: Style;
  faint: Style;
  oxide: Style;
  oxideBold: Style;
  olive: Style;
  brass: Style;
  brassBold: Style;
  accent: Style;
  accentBold: Style;
  danger: Style;
  dangerBold: Style;
  amber: Style;
  green: Style;
  greenBold: Style;
  haze: Style;
  hazeItalic: Style;
  frame: Style;
  title: Style;
  stampDown: Style;
  gaugeTrack: Style;
}

export function createPalette(): Palette {
  // Every style carries the canvas bg explicitly: a fg-only style would
  // stamp the terminal's default bg back over the painted canvas, which
  // is exactly the light-theme washout (owner field report). Mono mode
  // strips color SGR entirely, so the degrade path is untouched.
  const on = (spec: Parameters<typeof style>[0]): Style => style({ bg: SLATE.soot, ...spec });
  return {
    canvas: on({ fg: SLATE.ink }),
    ink: on({ fg: SLATE.ink }),
    inkBold: on({ fg: SLATE.ink, bold: true }),
    dim: on({ fg: SLATE.dim }),
    faint: on({ fg: SLATE.faint }),
    oxide: on({ fg: SLATE.oxide }),
    oxideBold: on({ fg: SLATE.oxide, bold: true }),
    olive: on({ fg: SLATE.olive }),
    brass: on({ fg: SLATE.brass }),
    brassBold: on({ fg: SLATE.brass, bold: true }),
    accent: on({ fg: SLATE.accent }),
    accentBold: on({ fg: SLATE.accent, bold: true }),
    danger: on({ fg: SLATE.danger }),
    dangerBold: on({ fg: SLATE.danger, bold: true }),
    amber: on({ fg: SLATE.amber }),
    green: on({ fg: SLATE.green }),
    greenBold: on({ fg: SLATE.green, bold: true }),
    haze: on({ fg: SLATE.haze }),
    hazeItalic: on({ fg: SLATE.haze, italic: true }),
    frame: on({ fg: SLATE.faint }),
    title: on({ fg: SLATE.dim, bold: true }),
    stampDown: on({ fg: SLATE.oxide, bold: true }),
    gaugeTrack: on({ fg: SLATE.faint, dim: true }),
  };
}

/** Log register → its ink. */
export function registerStyle(palette: Palette, register: string): Style {
  switch (register) {
    case "dialogue": return palette.amber;
    case "scene": return palette.hazeItalic;
    case "world": return palette.ink;
    case "combat": return palette.ink;
    case "reject": return palette.oxide;
    case "receipt": return palette.dim;
    case "survey": return palette.brass;
    case "loot": return palette.brass;
    case "system": return palette.dim;
    case "chat": return palette.ink;
    case "echo": return palette.faint;
    default: return palette.ink;
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
