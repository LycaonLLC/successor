/**
 * Quartermaster's Slate — the Successor 3D look, in one place.
 *
 * A scrappy desert field operation run out of a requisition office: crate-stencil
 * typography, oxide/olive/bone on soot, forms and stamps instead of chrome.
 * Strings, fonts, weapon names and the FIXED semantic/paper palette live here;
 * styles.css consumes them via the `--sc-fixed-*` properties installed by
 * `applyThemeVariables()`. The themeable UI chrome (panels, borders, accents)
 * is owned by uiTheme.ts as `--sc3d-*` — one chrome system, not two.
 *
 * Typeface: Saira Stencil One (Omnibus-Type), SIL Open Font License 1.1.
 * Bundled at src/assets/fonts/saira-stencil-one-latin.woff2 — see OFL.txt
 * beside the font file for the full license text.
 */

export const SUCCESSOR_THEME = {
  palette: {
    /** Deep charcoal backdrop behind everything. */
    sootDeep: "#0c0a06",
    /** Slate plates and ribbons sit on this. */
    soot: "#17130d",
    /** Sun-bleached primary text on dark surfaces. */
    bone: "#e4d7b4",
    /** Secondary text / gauge labels. */
    boneDim: "#a2946f",
    /** The requisition-form card. */
    paper: "#ddd0ab",
    /** Stencil ink on paper. */
    ink: "#262012",
    /** Rust-red stamps: ENTER WORLD, HEALTH, the DOWN stamp. */
    oxide: "#a63c20",
    /** Darker dried-blood oxide for the downed vignette. */
    oxideDeep: "#781a08",
    /** Field-drab: ACTION gauge. */
    olive: "#767446",
    /** Brass/cartridge: SPIRIT gauge and magazine pips. */
    ochre: "#b98c3a",
    /** Desert dust haze — MUST match renderer fog/clear colour (config.ts). */
    haze: "#c9ad82",
  },
  fonts: {
    stencil:
      '"Saira Stencil One", "Stencil Std", "Stencil", "Impact", "Arial Black", sans-serif',
    fine: '"Courier Prime", "Courier New", ui-monospace, "SFMono-Regular", monospace',
  },
  strings: {
    masthead: "SUCCESSOR",
    formNumber: "FORM 27-B",
    formTitle: "REQUISITION OF PERSONNEL",
    subline: "OPEN DESERT THEATRE",
    nameLabel: "OPERATIVE NAME",
    enter: "ENTER WORLD",
    statusReady: "AWAITING SIGNATURE",
    statusSubmitting: "PROCESSING REQUISITION",
    manifestPending: "MANIFEST · QUERYING FIELD OFFICE",
    gaugeHealth: "HEALTH",
    gaugeAction: "ACTION",
    gaugeSpirit: "SPIRIT",
    noSignal: "AWAITING FIELD MANIFEST",
    rearming: "REARMING",
    observerTag: "OBS",
    downStamp: "DOWN",
    respawnStamp: "RESPAWN",
  },
  /** Sim weapon ids to stenciled field designations. */
  weaponNames: {
    slugthrower: "SLUGTHROWER",
    vibrosword: "VIBROSWORD",
    "scrapline-machete": "SCRAPLINE MACHETE",
    unarmed: "UNARMED",
    "wpn-pistol": "SIDEARM",
    "wpn-smg": "SCRAP SMG",
    "wpn-carbine": "ENERGY CARBINE",
    "wpn-assault": "ASSAULT RIFLE",
    "wpn-shotgun": "COMBAT SHOTGUN",
    "wpn-sniper": "MARKSMAN RIFLE",
    "wpn-heavy": "SUPPORT LMG",
    "wpn-launcher": "MISSILE LAUNCHER",
  } as Record<string, string>,
} as const;

export function weaponDisplayName(weaponId: string | null | undefined): string {
  if (!weaponId) return "UNARMED";
  return SUCCESSOR_THEME.weaponNames[weaponId] ?? weaponId.replace(/-/g, " ").toUpperCase();
}

/**
 * Install the FIXED semantic + paper palette and font stacks as `--sc-fixed-*`
 * custom properties. Each swatch also gets a `--sc-fixed-*-rgb` space-separated
 * triplet so styles can derive alpha variants (`rgb(var(--sc-fixed-bone-rgb) / 0.3)`)
 * without duplicating a colour literal.
 *
 * These are the NON-themeable tokens: health/action/spirit bar fills, brass
 * pips, the downed vignette, the requisition-paper card, and the fonts. The
 * themeable UI chrome lives in uiTheme.ts as `--sc3d-*`. Always re-installs —
 * there is no one-shot guard, so callers can rely on a fresh write any time.
 */
export function applyThemeVariables(root: HTMLElement = document.documentElement): void {
  const style = root.style;
  const swatches: Record<string, string> = {
    "soot-deep": SUCCESSOR_THEME.palette.sootDeep,
    soot: SUCCESSOR_THEME.palette.soot,
    bone: SUCCESSOR_THEME.palette.bone,
    "bone-dim": SUCCESSOR_THEME.palette.boneDim,
    paper: SUCCESSOR_THEME.palette.paper,
    ink: SUCCESSOR_THEME.palette.ink,
    oxide: SUCCESSOR_THEME.palette.oxide,
    "oxide-deep": SUCCESSOR_THEME.palette.oxideDeep,
    olive: SUCCESSOR_THEME.palette.olive,
    ochre: SUCCESSOR_THEME.palette.ochre,
    haze: SUCCESSOR_THEME.palette.haze,
  };
  for (const [name, hex] of Object.entries(swatches)) {
    style.setProperty(`--sc-fixed-${name}`, hex);
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    style.setProperty(`--sc-fixed-${name}-rgb`, `${r} ${g} ${b}`);
  }
  style.setProperty("--sc-fixed-font-stencil", SUCCESSOR_THEME.fonts.stencil);
  style.setProperty("--sc-fixed-font-fine", SUCCESSOR_THEME.fonts.fine);
}
