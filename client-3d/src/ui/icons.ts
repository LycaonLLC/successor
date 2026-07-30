/**
 * Geometric line icons — the hand-authored CHROME icon vocabulary.
 *
 * DESIGN.md: chrome uses geometric vectors rather than raster game atlases.
 * Hand-authored inline SVG, 24×24 viewBox, mono-weight 1.5px stroke,
 * `currentColor` so every glyph inherits the theme ink/accent of its parent.
 *
 * Rendering contract: `el.innerHTML = UI_ICONS[id]` into a fixed-size span
 * (windows.css sizes the inner `svg` to 100%). No fills, no second weight.
 *
 * PURPOSE glyphs (component types / fill-slot purposes: resource families,
 * craft slot symbols, item kinds, covered window/system ids) live in
 * iconRegistry.ts as solid-silhouette vectors; surfaces fall back to this set
 * where the registry has no key (see DESIGN.md § Icons).
 */

export type UiIconId =
  | "inventory"
  | "datapad"
  | "options"
  | "character"
  | "skills"
  | "survey"
  | "examine"
  | "lock"
  | "trainer"
  | "converse"
  | "close"
  // ── Inventory category glyphs (toolbar item refs) ─────────────────────
  | "item-ammo"
  | "item-medical"
  | "item-resource"
  | "item-tool"
  | "item-gear"
  | "item-currency"
  | "item-item"
  | "item-weapon"
  // ── Action glyphs (toolbar + Action Browser) ─────────────────────────
  | "crosshair"
  | "kneel"
  | "stand"
  | "sample"
  | "reload"
  | "clone"
  | "peace"
  | "actions"
  | "macro"
  | "craft"
  | "trade"
  | "splice"
  // ── Window-identity glyphs (fx lab / travel terminal / loot salvage) ──
  | "fx"
  | "travel"
  | "loot"
  | "bank"
  | "clone-facility"
  | "association"
  | "bug-report"
  // ── Author command surface (dock window) ─────────────────────────────
  | "author";

const SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

function icon(paths: string): string {
  return `${SVG_OPEN}${paths}</svg>`;
}

export const UI_ICONS: Record<UiIconId, string> = {
  /** Vault door: dial ring + spokes over a strongbox (bank terminal). */
  bank: icon(
    '<rect x="4" y="4.75" width="16" height="14.5" rx="1.5"/>' +
    '<circle cx="12" cy="12" r="4.4"/>' +
    '<circle cx="12" cy="12" r="1.1"/>' +
    '<path d="M12 7.6v2.1M12 14.3v2.1M7.6 12h2.1M14.3 12h2.1"/>' +
    '<path d="M6.5 19.25v1.5M17.5 19.25v1.5"/>',
  ),
  /** Clone pod: rounded capsule, viewport seam and status pips. */
  "clone-facility": icon(
    '<path d="M8 4.75h8a1.5 1.5 0 0 1 1.5 1.5v9.25a5.5 5.5 0 0 1-11 0V6.25A1.5 1.5 0 0 1 8 4.75z"/>' +
    '<path d="M6.5 9.5h11"/>' +
    '<path d="M9.4 13.4a2.6 2.6 0 0 0 5.2 0"/>' +
    '<path d="M9.5 6.9h.01M12 6.9h.01M14.5 6.9h.01"/>',
  ),
  /** Association roster: two members inside the nameplate tag brackets. */
  association: icon(
    '<path d="M6.5 8.5 3.75 12l2.75 3.5"/>' +
    '<path d="M17.5 8.5 20.25 12l-2.75 3.5"/>' +
    '<circle cx="10" cy="9.75" r="2.1"/>' +
    '<path d="M6.6 16.75c.55-2.3 1.8-3.45 3.4-3.45s2.85 1.15 3.4 3.45"/>' +
    '<circle cx="14.6" cy="8.9" r="1.7"/>' +
    '<path d="M14.9 12.6c1.5.15 2.5 1.25 2.95 3.15"/>',
  ),
  /** Field report: folded sheet with a plain issue mark. */
  "bug-report": icon(
    '<path d="M6.25 3.75h8.5l3 3v13.5H6.25z"/>' +
    '<path d="M14.75 3.75v3h3"/>' +
    '<path d="M12 9v4.5M12 16.75v.1"/>',
  ),
  /** Radar sweep: survey tool scan display. */
  survey: icon(
    '<circle cx="12" cy="12" r="8.25"/>' +
    '<circle cx="12" cy="12" r="4.5"/>' +
    '<circle cx="12" cy="12" r="0.9"/>' +
    '<path d="M12 12l5.1-5.1"/>' +
    '<path d="M17.85 8.4a6.9 6.9 0 0 1 1.05 3.6"/>',
  ),
  /** Command pennant: staff with a swallow-tail flag (author orders). */
  author: icon(
    '<path d="M7.25 3.75v16.5"/>' +
    '<path d="M7.25 4.75h9.5l-2.6 3.2 2.6 3.2h-9.5"/>' +
    '<path d="M5.5 20.25h3.5"/>',
  ),
  /** Briefcase: field kit. */
  inventory: icon(
    '<rect x="3.75" y="8" width="16.5" height="11.25" rx="1.5"/>' +
    '<path d="M9 8V6.25A1.5 1.5 0 0 1 10.5 4.75h3A1.5 1.5 0 0 1 15 6.25V8"/>' +
    '<path d="M3.75 13h16.5"/>' +
    '<path d="M12 12v2"/>',
  ),
  /** Tablet with antenna: field data terminal. */
  datapad: icon(
    '<rect x="5.75" y="6.5" width="10.5" height="13" rx="1.5"/>' +
    '<path d="M9.25 16.75h3.5"/>' +
    '<path d="M16.25 8.75V4.5"/>' +
    '<path d="M18.9 6.4a4.4 4.4 0 0 0-2.65-2.15"/>',
  ),
  /** Sliders: tuning rails with beads. */
  options: icon(
    '<path d="M4 7h8.4M17.4 7H20"/><circle cx="15.2" cy="7" r="2.1"/>' +
    '<path d="M4 12h2.4M11.4 12H20"/><circle cx="9.2" cy="12" r="2.1"/>' +
    '<path d="M4 17h10.4M19.4 17H20"/><circle cx="17.2" cy="17" r="2.1"/>',
  ),
  /** Person silhouette: head + shoulders. */
  character: icon(
    '<circle cx="12" cy="7.75" r="3.25"/>' +
    '<path d="M5.25 19.5a6.75 6.75 0 0 1 13.5 0"/>',
  ),
  /** Ascending nodes: skill progression graph. */
  skills: icon(
    '<circle cx="5.5" cy="17.5" r="1.9"/>' +
    '<circle cx="12" cy="13.25" r="1.9"/>' +
    '<circle cx="18.5" cy="6.5" r="1.9"/>' +
    '<path d="M7.1 16.45l3.3-2.15"/>' +
    '<path d="M13.1 11.7l4.3-3.6"/>' +
    '<path d="M12 15.15V19.5M18.5 8.4v11.1"/>',
  ),
  /** Magnifier over cube: inspect the item. */
  examine: icon(
    '<circle cx="10.5" cy="10.5" r="5.9"/>' +
    '<path d="M14.8 14.8 19.6 19.6"/>' +
    '<path d="M10.5 7.4l2.7 1.55v3.1L10.5 13.6 7.8 12.05v-3.1z"/>' +
    '<path d="M7.8 8.95l2.7 1.55 2.7-1.55M10.5 10.5v3.1"/>',
  ),
  /** Padlock: locked skill/route. */
  lock: icon(
    '<rect x="6.75" y="10.5" width="10.5" height="8.75" rx="1.5"/>' +
    '<path d="M9 10.5V8a3 3 0 0 1 6 0v2.5"/>' +
    '<path d="M12 14v2"/>',
  ),
  /** Trainer: person with an instruction mark. */
  trainer: icon(
    '<circle cx="10" cy="8" r="3"/>' +
    '<path d="M4.25 19.5a5.75 5.75 0 0 1 11.5 0"/>' +
    '<path d="M17.4 5.6a2.4 2.4 0 0 1 2.4 2.4c0 1.6-2.4 1.8-2.4 3.2"/>' +
    '<path d="M17.4 14.2v.6"/>',
  ),
  /** Converse: dialogue bubble with speech lines. */
  converse: icon(
    '<path d="M4.75 5.5h14.5v10h-8.25l-3.75 3.25V15.5h-2.5z"/>' +
    '<path d="M8.25 9h8"/>' +
    '<path d="M8.25 12h5"/>',
  ),
  /** Close. */
  close: icon('<path d="M6.75 6.75l10.5 10.5M17.25 6.75l-10.5 10.5"/>'),
  // ── Inventory category glyphs ───────────────────────────────────────────
  /** Cartridge: ammunition stacks. */
  "item-ammo": icon(
    '<path d="M9 4.75h6"/>' +
    '<path d="M9.75 6.75h4.5l1.25 2.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-8.5z"/>' +
    '<path d="M8.5 10.5h7"/>',
  ),
  /** Medical cross in a field pouch. */
  "item-medical": icon(
    '<rect x="5" y="6.5" width="14" height="12" rx="2"/>' +
    '<path d="M9.25 6.5V5.25h5.5V6.5"/>' +
    '<path d="M12 9.5v6"/>' +
    '<path d="M9 12.5h6"/>',
  ),
  /** Hex sample: resources. */
  "item-resource": icon(
    '<path d="M12 3.75 19.1 8v8L12 20.25 4.9 16V8z"/>' +
    '<path d="M12 12 19.1 8M12 12v8.25M12 12 4.9 8"/>',
  ),
  /** Compact wrench: tools. */
  "item-tool": icon(
    '<path d="M15.5 4.5a4.2 4.2 0 0 0 4 5.45L10.2 19.25a2.2 2.2 0 0 1-3.1-3.1l9.3-9.3a4.2 4.2 0 0 0-.9-2.35z"/>' +
    '<path d="M7.8 16.6l1.6 1.6"/>',
  ),
  /** Shield plate: wearable gear. */
  "item-gear": icon(
    '<path d="M12 4.25 18.5 7v5.25c0 4.1-2.6 6.4-6.5 7.5-3.9-1.1-6.5-3.4-6.5-7.5V7z"/>' +
    '<path d="M9 12h6"/>' +
    '<path d="M12 9v6"/>',
  ),
  /** Coin stack: currency. */
  "item-currency": icon(
    '<ellipse cx="12" cy="7" rx="5.75" ry="2.75"/>' +
    '<path d="M6.25 7v5.75c0 1.5 2.6 2.75 5.75 2.75s5.75-1.25 5.75-2.75V7"/>' +
    '<path d="M6.25 10.75c0 1.5 2.6 2.75 5.75 2.75s5.75-1.25 5.75-2.75"/>',
  ),
  /** Field box: general items. */
  "item-item": icon(
    '<path d="M4.75 8.5 12 4.75l7.25 3.75v7L12 19.25 4.75 15.5z"/>' +
    '<path d="M4.75 8.5 12 12.25l7.25-3.75"/>' +
    '<path d="M12 12.25v7"/>',
  ),
  /** Rifle silhouette: weapons. */
  "item-weapon": icon(
    '<path d="M4.5 13.5h9.75l2.25-2.25H20"/>' +
    '<path d="M7.25 13.5 5.5 17"/>' +
    '<path d="M12 13.5l2 4"/>' +
    '<path d="M15.75 11.25l1.5 3.5"/>' +
    '<path d="M18.75 11.25v-2"/>',
  ),
  // ── Action glyphs ─────────────────────────────────────────────────────
  /** Crosshair: Attack — strike with the equipped weapon. */
  crosshair: icon(
    '<circle cx="12" cy="12" r="7"/>' +
    '<path d="M12 1.5v4.5M12 18v4.5M1.5 12h4.5M18 12h4.5"/>' +
    '<circle cx="12" cy="12" r="1.1"/>',
  ),
  /** Kneeling profile: go to a knee. */
  kneel: icon(
    '<circle cx="9" cy="6.5" r="2.3"/>' +
    '<path d="M9 8.8V14"/>' +
    '<path d="M9 14h6"/>' +
    '<path d="M15 14v5.5"/>' +
    '<path d="M9 14l-2.5 5.5"/>',
  ),
  /** Upright figure: stand up. */
  stand: icon(
    '<circle cx="12" cy="6" r="2.3"/>' +
    '<path d="M12 8.3V19"/>' +
    '<path d="M8.5 12.5h7"/>',
  ),
  /** Vial: take a resource sample. */
  sample: icon(
    '<path d="M9 3.5v11.5a3 3 0 0 0 6 0V3.5"/>' +
    '<path d="M8 3.5h8"/>' +
    '<path d="M9.4 11h5.2"/>',
  ),
  /** Circular arrow: reload the equipped weapon. */
  reload: icon(
    '<path d="M19.5 12a7.5 7.5 0 1 1-2.6-5.7"/>' +
    '<path d="M19.5 3v4.5h-4.5"/>',
  ),
  /** Overlapping plates: clone / respawn (duplicate self). */
  clone: icon(
    '<rect x="3.5" y="3.5" width="11" height="11" rx="1.5"/>' +
    '<rect x="9.5" y="9.5" width="11" height="11" rx="1.5"/>',
  ),
  /** Peace symbol: stand down (cease auto-fire). */
  peace: icon(
    '<circle cx="12" cy="12" r="8.25"/>' +
    '<path d="M12 3.75V12"/>' +
    '<path d="M12 12l-5.4 5.4"/>' +
    '<path d="M12 12l5.4 5.4"/>',
  ),
  /** 2×2 grid: the Action Browser (abilities pane). */
  actions: icon(
    '<rect x="4" y="4" width="5.5" height="5.5" rx="1"/>' +
    '<rect x="14.5" y="4" width="5.5" height="5.5" rx="1"/>' +
    '<rect x="4" y="14.5" width="5.5" height="5.5" rx="1"/>' +
    '<rect x="14.5" y="14.5" width="5.5" height="5.5" rx="1"/>',
  ),
  /** Command card: terminal prompt + verb line — the macro bench. Card is
   *  centered in the 24-box (y 5.25–18.75 → equal 5.25 top/bottom padding;
   *  outer stroke edge stays ≥3.75 from every side, so nothing crops at the
   *  dock's 22px render). */
  macro: icon(
    '<rect x="4.5" y="5.25" width="15" height="13.5" rx="1.5"/>' +
    '<path d="M7.75 9.75l2.5 2.25-2.5 2.25"/>' +
    '<path d="M12.75 14.25h3.75"/>',
  ),
  /** Hammer over anvil: the crafting bench. */
  craft: icon(
    '<path d="M13.6 4.4l6 6"/>' +
    '<path d="M15 3l6 6-2.1 2.1a1.5 1.5 0 0 1-2.1 0l-3.9-3.9a1.5 1.5 0 0 1 0-2.1z"/>' +
    '<path d="M12.9 8.2 4.5 16.6"/>' +
    '<path d="M3.4 19.5l1.1-2.9 1.8 1.8z"/>' +
    '<path d="M14.5 17.5h6"/>' +
    '<path d="M15.75 17.5v2.75h3.5V17.5"/>',
  ),
  /** Opposing arrows: the secure trade table (goods both ways). */
  trade: icon(
    '<path d="M4.5 8.5h13"/>' +
    '<path d="M14.5 5.5l3 3-3 3"/>' +
    '<path d="M19.5 15.5h-13"/>' +
    '<path d="M9.5 12.5l-3 3 3 3"/>',
  ),
  /** Double helix: the gene bench (crop-splice lab). */
  splice: icon(
    '<path d="M7 3c0 4.5 10 4.5 10 9s-10 4.5-10 9"/>' +
    '<path d="M17 3c0 4.5-10 4.5-10 9s10 4.5 10 9"/>' +
    '<path d="M8.4 6h7.2"/>' +
    '<path d="M7 12h10"/>' +
    '<path d="M8.4 18h7.2"/>',
  ),
  /** Flask with spark motes: the FX test bench (dev instrument). */
  fx: icon(
    '<path d="M9.75 4.5h4.5"/>' +
    '<path d="M10.5 4.5v4.4l-4.7 8.2a1.6 1.6 0 0 0 1.4 2.4h9.6a1.6 1.6 0 0 0 1.4-2.4l-4.7-8.2V4.5"/>' +
    '<path d="M12 13.4v.1M14.2 16l.7 1.2M9.4 16.6l-.6 1"/>',
  ),
  /** Route arc between two stops: the travel terminal. */
  travel: icon(
    '<circle cx="6.25" cy="17.75" r="2"/>' +
    '<circle cx="17.75" cy="6.25" r="2"/>' +
    '<path d="M7.9 16.1a10.4 10.4 0 0 1 8.2-8.2"/>',
  ),
  /** Opened field crate: loot salvage (corpse + cache). */
  loot: icon(
    '<rect x="4.75" y="10.75" width="14.5" height="8.5" rx="1"/>' +
    '<path d="M4.75 10.75 7 5.75h10l2.25 5"/>' +
    '<path d="M12 5.75v5"/>' +
    '<path d="M10.25 14.75h3.5"/>',
  ),
};

/** "KeyI" → "I", "Digit4" → "4"; anything else passes through uppercased. */
export function hotkeyGlyph(code: string): string {
  if (code.startsWith("Key")) return code.slice(3).toUpperCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return code.toUpperCase();
}
