/**
 * Purpose-icon registry — generalized component-type / fill-slot-purpose
 * glyphs (owner mandate 2026-07-08: one icon vocabulary for "the general type
 * of component / the purpose the resource fill slot fulfills").
 *
 * The vector set is composed in purposeIconSvgs.ts from the original 30-glyph
 * vocabulary and its generated crafting extension. Every SVG uses
 * fill="currentColor"; provenance lives in each generated header.
 * This module owns the SEMANTIC maps: which server string / category / window
 * id resolves to which glyph. Registry = this lane; the full adoption sweep
 * across every surface belongs to the FE-polish phase-2 pass.
 *
 * Every map is deliberately partial: unknown keys return null and callers keep
 * their existing rendering (UI_ICONS line glyph, text chip, …) — server-driven
 * vocabularies (craft slot symbols, item ids) must never break the UI.
 */

import type { InventoryCategory } from "./inventory/types";
import type { ResourceGlyphId } from "./inventory/resourceGlyphs";
import type { UiIconId } from "./icons";
import { PURPOSE_ICON_SVGS, type PurposeIconKey } from "./purposeIconSvgs";

/** Craft window fill-slot purposes (authority crafting.rs slot `symbol`). */
const CRAFT_SLOT_ICONS: Record<string, PurposeIconKey> = {
  casing: "purpose.casing",
  conductor: "purpose.conductor",
  structural: "purpose.structural",
  barrel: "purpose.barrel",
  propellant: "purpose.propellant",
  grip: "purpose.grip",
  blade: "purpose.structural",
  receiver: "purpose.housing",
  insulator: "purpose.dielectric",
  arc_medium: "purpose.conductor",
  // Coil-slug ammunition slots (authority crafting.rs): forged body + pressed charge.
  body: "purpose.body",
  charge: "purpose.charge",
  // Wave-3 resource-processing slots (authority crafting.rs): the battery's
  // fuel charge plus the fuel/polymer feedstock inputs.
  fuel: "purpose.propellant",
  feedstock: "resource.chemical",
  carbon: "resource.mineral",
  housing: "purpose.housing",
  dielectric: "purpose.dielectric",
  shell: "purpose.shell",
  agent: "purpose.agent",
  reagent: "purpose.reagent",
  solvent: "purpose.solvent",
  regulator: "purpose.regulator",
  frame: "purpose.frame",
  biogel: "purpose.biogel",
  salts: "purpose.salts",
  controller: "purpose.controller",
  suspension: "purpose.suspension",
  stimulant: "purpose.stimulant",
  binder: "purpose.binder",
  inhalant: "purpose.inhalant",
  neuro: "purpose.neuro",
  counter: "purpose.counter",
  eyewash: "purpose.eyewash",
};

/** Gene-bench slot purposes (authority splice.rs slot kind + reagent label). */
const SPLICE_SLOT_ICONS: Record<string, PurposeIconKey> = {
  parent: "item.seed",
  culture: "resource.flora",
  mutagen: "resource.chemical",
  stabilizer: "purpose.structural",
  serum: "resource.creature",
};

/** Inventory item kinds with a purpose glyph (rest keep the text-only chip). */
const ITEM_KIND_ICONS: Partial<Record<InventoryCategory, PurposeIconKey>> = {
  weapon: "item.weapon",
  gear: "item.armor",
  tool: "item.tool",
  medical: "item.kit",
};

/** Resource plate glyph family -> fill-slot resource-family icon. */
const RESOURCE_FAMILY_ICONS: Record<ResourceGlyphId, PurposeIconKey> = {
  iron: "resource.mineral",
  copper: "resource.mineral",
  powder: "resource.mineral",
  carbon: "resource.mineral",
  chemical: "resource.chemical",
  fuel: "resource.chemical",
  polymer: "resource.chemical",
  gas: "resource.gas",
  liquid: "resource.water",
  flora: "resource.flora",
  meat: "resource.creature",
  bone: "resource.creature",
  hide: "resource.creature",
  tissue: "resource.creature",
};

/** Window-header glyphs (windowManager defs) covered by the purpose set. */
const WINDOW_ICONS: Partial<Record<UiIconId, PurposeIconKey>> = {
  inventory: "window.inventory",
  character: "window.character",
  survey: "window.survey",
  craft: "window.craft",
  trade: "window.trade",
  datapad: "window.datapad",
  skills: "system.skills",
  macro: "system.macro",
  travel: "system.travel",
};

// The exported resolvers below are the registry's public seam: the phase-2
// adoption sweep calls them from additional surfaces; each hides a
// partial-map + fallback contract (null -> caller keeps existing rendering).

/** Craft fill-slot purpose symbol ("casing", …) -> svg markup, else null. */
export function craftSlotIconSvg(symbol: string): string | null {
  const key = CRAFT_SLOT_ICONS[symbol];
  return key ? PURPOSE_ICON_SVGS[key] : null;
}
/**
 * Hand-authored generic component-stock silhouette (hex billet). The craft
 * window's fail-closed fallback: unknown future authority slot vocabulary
 * renders THIS coherent vector — never a raw server token, letter, or
 * Unicode stand-in (Field Bench icon law).
 */
const GENERIC_CRAFT_STOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
  + '<path d="M12 2.2 20.2 7v10L12 21.8 3.8 17V7Zm0 2.3L5.8 8.15v7.7L12 19.5l6.2-3.65v-7.7Z"/>'
  + '<path d="M12 8.1l3.4 2v3.8l-3.4 2-3.4-2v-3.8Z"/>'
  + '</svg>';

/**
 * Craft fill-slot purpose symbol -> svg markup, ALWAYS an inline vector.
 * Mapped symbols get their purpose silhouette; anything else fails closed
 * to the generic stock glyph.
 */
export function craftSlotIconOrGenericSvg(symbol: string): string {
  return craftSlotIconSvg(symbol) ?? GENERIC_CRAFT_STOCK_SVG;
}

/** Gene-bench slot purpose token ("parent" | "culture" | …) -> svg, else null. */
export function spliceSlotIconSvg(token: string): string | null {
  const key = SPLICE_SLOT_ICONS[token];
  return key ? PURPOSE_ICON_SVGS[key] : null;
}

/** Inventory kind chip glyph. Resource rows resolve their FAMILY icon. */
export function itemKindIconSvg(
  category: InventoryCategory,
  resourceGlyph?: ResourceGlyphId,
): string | null {
  if (category === "resource" && resourceGlyph) {
    return PURPOSE_ICON_SVGS[RESOURCE_FAMILY_ICONS[resourceGlyph]];
  }
  const key = ITEM_KIND_ICONS[category];
  return key ? PURPOSE_ICON_SVGS[key] : null;
}

/** Window-header glyph for a window def icon id, else null (UI_ICONS keeps it). */
export function windowIconSvg(icon: UiIconId): string | null {
  const key = WINDOW_ICONS[icon];
  return key ? PURPOSE_ICON_SVGS[key] : null;
}
