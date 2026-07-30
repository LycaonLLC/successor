/**
 * Successor 3D UI theme engine — selectable Pip-Boy chrome palettes.
 *
 * Owns the themeable UI chrome via `--sc3d-*` CSS custom properties installed
 * on document.documentElement (inline style + a `data-sc3d-theme` attribute).
 * Four Fallout-3/NV-style palettes: `signal` (cold cyan, default), `phosphor`
 * (CRT green), `amber` (Pip-Boy amber), `oxide` (rust red).
 *
 * Role split with ui/theme.ts — there is exactly ONE chrome system, this one:
 *   • `--sc3d-*`  (here)     themeable CHROME — panels, borders, text, accents.
 *   • `--sc-fixed-*`    (theme.ts) fixed SEMANTIC gameplay + requisition-paper palette
 *                            (health/action/spirit bar fills, brass pips, the
 *                            downed dried-blood vignette, the paper card) and
 *                            the font stacks. Never re-themed.
 *
 * Semantic gameplay colours — the health-red / action-olive / spirit-ochre bar
 * fills, brass magazine pips, the downed vignette, and nameplate/relation tints
 * drawn on the overlay canvas — deliberately stay on `--sc-fixed-*` so they do NOT
 * shift when the chrome theme changes.
 *
 * All setters ALWAYS rewrite the variables on every call: a live
 * green→amber swap re-paints the whole shell with no reload, CSS-vars only.
 */

import { buildGameCursorCssValue } from "../overlay/cursor";

const STORAGE_KEY = "successor3d.theme.v1";

export type UiThemeId = "signal" | "phosphor" | "amber" | "oxide";

/** Themeable palette. Hex literals except `accentGlow` (rgba, for shadows). */
export interface UiThemePalette {
  /** Near-black panel backdrop, faintly hue-tinted per theme. */
  readonly bgPanel: string;
  /** One step lighter than bgPanel — gauge tracks, cells, wells. */
  readonly bgCell: string;
  /** Primary text — tinted off-white, or the accent itself for phosphor/amber. */
  readonly ink: string;
  /** Secondary text / gauge labels. */
  readonly inkDim: string;
  /** Hairline borders & separators. */
  readonly hairline: string;
  /** Signature accent — cursor, focus rings, ENTER stamp, input caret. */
  readonly accent: string;
  /** Muted accent for soft fills (hovers, selections, low glows). */
  readonly accentSoft: string;
  /** rgba accent for box-shadow glows. */
  readonly accentGlow: string;
  /** Danger / death / error chrome (DOWN stamp, webgl-error border). */
  readonly danger: string;
}

export interface UiThemeDef {
  /** Stable id — persisted and used as the `data-sc3d-theme` value. */
  readonly id: UiThemeId;
  /** Human label for swatch buttons. */
  readonly label: string;
  readonly palette: UiThemePalette;
}

/** The `--sc3d-*` custom properties, in install order. */
const THEME_VARS = [
  "--sc3d-bg-panel",
  "--sc3d-bg-cell",
  "--sc3d-ink",
  "--sc3d-ink-dim",
  "--sc3d-hairline",
  "--sc3d-accent",
  "--sc3d-accent-soft",
  "--sc3d-accent-glow",
  "--sc3d-danger",
  "--sc3d-glass",
  "--sc3d-cursor-default",
  "--sc3d-cursor-interact",
] as const;

/**
 * Semantic z-scale (DESIGN.md): window base < focused window (manager-assigned
 * within the window band) < dock < context-radial < examine-drag ghost. HUD
 * plates sit below all UI chrome. Theme-independent; installed alongside the
 * palette so every surface reads them as vars, never literals.
 */
const Z_SCALE: Record<string, string> = {
  "--sc3d-z-hud": "6",
  "--sc3d-z-window": "20",
  "--sc3d-z-dock": "30",
  "--sc3d-z-radial": "40",
  "--sc3d-z-ghost": "50",
};

export const UI_THEMES: readonly UiThemeDef[] = [
  {
    id: "signal",
    label: "SIGNAL",
    palette: {
      bgPanel: "#070b0d",
      bgCell: "#0b1216",
      ink: "#cfe9ef",
      inkDim: "#5f818c",
      hairline: "#1d2f37",
      accent: "#48d6e6",
      accentSoft: "#0f3b44",
      accentGlow: "rgba(72,214,230,0.45)",
      danger: "#e34a4a",
    },
  },
  {
    id: "phosphor",
    label: "PHOSPHOR",
    palette: {
      bgPanel: "#050a06",
      bgCell: "#08120a",
      ink: "#56e07a",
      inkDim: "#2f8f4b",
      hairline: "#123321",
      accent: "#46ff7a",
      accentSoft: "#0e3a1c",
      accentGlow: "rgba(70,255,122,0.45)",
      danger: "#e34a4a",
    },
  },
  {
    id: "amber",
    label: "AMBER",
    palette: {
      bgPanel: "#0a0703",
      bgCell: "#120d05",
      ink: "#ffd98c",
      inkDim: "#a07c3c",
      hairline: "#3a2a12",
      accent: "#ffb24a",
      accentSoft: "#3a270c",
      accentGlow: "rgba(255,178,74,0.45)",
      danger: "#e34a4a",
    },
  },
  {
    id: "oxide",
    label: "OXIDE",
    palette: {
      bgPanel: "#0c0605",
      bgCell: "#150a07",
      ink: "#e6d4b8",
      inkDim: "#8a7355",
      hairline: "#3a201a",
      accent: "#c44a26",
      accentSoft: "#3a160e",
      accentGlow: "rgba(196,74,38,0.45)",
      danger: "#d83a3a",
    },
  },
];

export const DEFAULT_UI_THEME: UiThemeId = "signal";

const THEME_IDS: readonly UiThemeId[] = UI_THEMES.map((t) => t.id);

function defById(id: UiThemeId): UiThemeDef {
  return UI_THEMES.find((t) => t.id === id) ?? UI_THEMES[0]!;
}

// Current theme. Defaults to `signal` so getUiThemeColors() is safe even before
// initUiTheme() runs (it matches the styles.css :root fallbacks).
let current: UiThemeDef = defById(DEFAULT_UI_THEME);
const listeners = new Set<(theme: UiThemeDef) => void>();

/** A parsed colour for canvas / lighting rigs. */
export interface UiThemeColor {
  /** 0–255 channel. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** CSS colour string, e.g. `rgb(72,214,230)`. */
  readonly css: string;
}

/** The seven themeable colours canvas-painted UI retints to. */
export interface UiThemeColors {
  readonly accent: UiThemeColor;
  readonly accentSoft: UiThemeColor;
  readonly ink: UiThemeColor;
  readonly inkDim: UiThemeColor;
  readonly bgPanel: UiThemeColor;
  readonly hairline: UiThemeColor;
  readonly danger: UiThemeColor;
}

function parseHex(hex: string): UiThemeColor {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const digits = match ? match[1]! : "000000";
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);
  return { r, g, b, css: `rgb(${r},${g},${b})` };
}

/** Install a theme's vars + z-scale + data attribute, then notify subscribers. */
function applyTheme(def: UiThemeDef): void {
  const root = document.documentElement;
  const style = root.style;
  const p = def.palette;
  const values: Record<string, string> = {
    "--sc3d-bg-panel": p.bgPanel,
    "--sc3d-bg-cell": p.bgCell,
    "--sc3d-ink": p.ink,
    "--sc3d-ink-dim": p.inkDim,
    "--sc3d-hairline": p.hairline,
    "--sc3d-accent": p.accent,
    "--sc3d-accent-soft": p.accentSoft,
    "--sc3d-accent-glow": p.accentGlow,
    "--sc3d-danger": p.danger,
    // Hairline HUD-glass window backing (DESIGN.md): translucent near-black
    // derived from the theme's panel color — baked per theme as a literal mix.
    "--sc3d-glass": `color-mix(in srgb, ${p.bgPanel} 72%, transparent)`,
    // Identity cursor states (overlay/cursor art) baked from the accent so
    // a live theme cycle re-skins the pointer with no reload.
    "--sc3d-cursor-default": buildGameCursorCssValue(p.accent, "default"),
    "--sc3d-cursor-interact": buildGameCursorCssValue(p.accent, "interact"),
  };
  for (const name of THEME_VARS) {
    style.setProperty(name, values[name]!);
  }
  for (const [name, value] of Object.entries(Z_SCALE)) {
    style.setProperty(name, value);
  }
  root.setAttribute("data-sc3d-theme", def.id);
  current = def;
  for (const fn of listeners) fn(current);
}

function readStoredTheme(): UiThemeId | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (THEME_IDS as readonly string[]).includes(raw)) {
      return raw as UiThemeId;
    }
  } catch {
    /* localStorage unavailable (private mode / disabled) — fall back to default. */
  }
  return null;
}

function writeStoredTheme(id: UiThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore — theme still applies in-session. */
  }
}

/**
 * Restore the persisted theme (or the default) and apply it. Idempotent and
 * safe to call at app boot, before first paint: run it synchronously at the
 * top of main.ts so the shell never flashes the wrong palette.
 */
export function initUiTheme(): UiThemeId {
  const id = readStoredTheme() ?? DEFAULT_UI_THEME;
  applyTheme(defById(id));
  return id;
}

/** Apply + persist a specific theme by id. Always rewrites the root vars. */
export function setUiTheme(id: UiThemeId): UiThemeId {
  const def = defById(id);
  writeStoredTheme(def.id);
  applyTheme(def);
  return def.id;
}

/** Advance to the next theme (signal→phosphor→amber→oxide→signal). */
export function cycleUiTheme(): UiThemeId {
  const index = UI_THEMES.findIndex((theme) => theme.id === current.id);
  const next = UI_THEMES[(index + 1) % UI_THEMES.length]!;
  return setUiTheme(next.id);
}

/** Current theme id. */
export function getUiTheme(): UiThemeId {
  return current.id;
}

/** Parsed colour snapshot of the current theme, for canvas/lighting rigs. */
export function getUiThemeColors(): UiThemeColors {
  const p = current.palette;
  return {
    accent: parseHex(p.accent),
    accentSoft: parseHex(p.accentSoft),
    ink: parseHex(p.ink),
    inkDim: parseHex(p.inkDim),
    bgPanel: parseHex(p.bgPanel),
    hairline: parseHex(p.hairline),
    danger: parseHex(p.danger),
  };
}

/**
 * Subscribe to live theme swaps. The listener is invoked synchronously on
 * every apply (init / set / cycle), receiving the new theme def. Use it to
 * retint canvas-painted UI without reloading. Returns an unsubscribe function.
 */
export function subscribeUiTheme(fn: (theme: UiThemeDef) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
