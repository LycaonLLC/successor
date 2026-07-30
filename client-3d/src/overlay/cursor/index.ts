const CURSOR_STYLE_ID = "successor3d-game-cursor-style";
const CURSOR_CLASS = "dw3-game-cursor";

/**
 * The Successor 3D game cursor — ONE always-on pointer for world and UI.
 *
 * Art language (owner spec 2026-07-04): regular-cursor SHAPE, targeting-clicker
 * STYLE — the arrow wears the soft-lock corner-tick bracket at its hotspot and
 * the theme accent as its rim, over a near-black glass fill. Two states:
 *
 *   • default  — hollow glass arrow + accent rim + tl corner bracket.
 *   • interact — same geometry with an accent-tinted body fill (hover on
 *                clickable UI; wired via `--sc3d-cursor-interact`).
 *
 * Native cursors deliberately survive for MANIPULATION feedback only:
 * grab/grabbing (window drag), resize grips, not-allowed (blocked verbs),
 * and the text I-beam. Identity cursors own pointing and acting.
 *
 * Theme wiring: ui/uiTheme.ts bakes `--sc3d-cursor-default` /
 * `--sc3d-cursor-interact` from the active palette accent on every theme
 * apply, so cycling SIGNAL→PHOSPHOR→AMBER→OXIDE re-skins the pointer live.
 */

// CURSOR-ART — tip/hotspot at viewBox (5,5); rendered 26px ⇒ hotspot (4,4).
const CURSOR_VIEWBOX = 30;
const CURSOR_SIZE_PX = 26;
const CURSOR_HOTSPOT_PX = 4;
const CURSOR_HALO = "#0b100e";
const CURSOR_BODY_PATH = "M5 5 L5 19.8 L9.2 15.9 L11.9 22.2 L14.9 20.9 L12.2 14.7 L17.8 14.4 Z";

export type GameCursorKind = "default" | "interact";

/** Build the cursor SVG markup for an accent color. Exported for tests/bench. */
export function buildGameCursorSvg(accent: string, kind: GameCursorKind): string {
  const interactFill = kind === "interact" ? `<path d="${CURSOR_BODY_PATH}" fill="${accent}" opacity="0.30"/>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_SIZE_PX}" height="${CURSOR_SIZE_PX}" viewBox="0 0 ${CURSOR_VIEWBOX} ${CURSOR_VIEWBOX}">` +
    `<path d="${CURSOR_BODY_PATH}" fill="none" stroke="${CURSOR_HALO}" stroke-width="2.6" stroke-linejoin="round" opacity="0.85"/>` +
    `<path d="${CURSOR_BODY_PATH}" fill="rgba(10,15,13,0.4)" stroke="${accent}" stroke-width="1.4" stroke-linejoin="round"/>` +
    interactFill +
    `<path d="M1.2 6.6 L1.2 1.2 L6.6 1.2" fill="none" stroke="${CURSOR_HALO}" stroke-width="2.4" stroke-linecap="butt" stroke-linejoin="miter" opacity="0.8"/>` +
    `<path d="M1.4 6.4 L1.4 1.4 L6.4 1.4" fill="none" stroke="${accent}" stroke-width="1.1" stroke-linecap="butt" stroke-linejoin="miter"/>` +
    `</svg>`
  );
}

/**
 * Full CSS `cursor` value (url + hotspot + keyword fallback) for a theme
 * accent. uiTheme bakes this into `--sc3d-cursor-default` / `-interact`.
 */
export function buildGameCursorCssValue(accent: string, kind: GameCursorKind): string {
  const fallback = kind === "interact" ? "pointer" : "default";
  return `url("data:image/svg+xml,${encodeURIComponent(buildGameCursorSvg(accent, kind))}") ${CURSOR_HOTSPOT_PX} ${CURSOR_HOTSPOT_PX}, ${fallback}`;
}

export interface GameCursorHandle {
  dispose: () => void;
}

/**
 * Install the single always-on 3D game cursor. Gameplay input no longer flips
 * modality: the root declares the default identity cursor and every child
 * inherits it unless a component rule opts into `--sc3d-cursor-interact` or a
 * native manipulation cursor (grab / resize / not-allowed / text).
 */
export function installGameCursor(rootEl: HTMLElement): GameCursorHandle {
  ensureCursorStyle(rootEl.ownerDocument);
  rootEl.classList.add(CURSOR_CLASS);
  return {
    dispose() {
      rootEl.classList.remove(CURSOR_CLASS);
    },
  };
}

function ensureCursorStyle(documentRef: Document): void {
  if (documentRef.getElementById(CURSOR_STYLE_ID)) return;
  const style = documentRef.createElement("style");
  style.id = CURSOR_STYLE_ID;
  style.textContent = `
.${CURSOR_CLASS} {
  cursor: var(--sc3d-cursor-default, default);
}
.${CURSOR_CLASS} input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]),
.${CURSOR_CLASS} textarea,
.${CURSOR_CLASS} [contenteditable] {
  cursor: text;
}
`;
  documentRef.head.appendChild(style);
}
