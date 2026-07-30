import { RESOURCE_GLYPH_SILHOUETTE_SVGS } from "./resourceGlyphSilhouettes.gen";

/**
 * Generated monochrome filled-silhouette glyphs for standardized 3D container
 * plates.
 *
 * Each glyph is an inline SVG (viewBox 0 0 512 512, fill="currentColor")
 * traced from the resource-containers-v1 sheet in
 * source-assets/ui/successor-purpose-icons. SlotVisualKit parses it
 * synchronously and triangulates the paths into filled mesh geometry. Glyphs
 * are content identity, not theme chrome, and never load a sprite/image URL.
 */
export type ResourceGlyphId =
  | "meat"
  | "bone"
  | "hide"
  | "tissue"
  | "iron"
  | "copper"
  | "chemical"
  | "flora"
  | "gas"
  | "liquid"
  | "powder"
  | "carbon"
  | "fuel"
  | "polymer";

export type ContainerGlyphId = ResourceGlyphId | "ammo";

/** itemId → exact resource glyph. */
export const RESOURCE_GLYPH_BY_ITEM_ID: Record<number, ResourceGlyphId> = {
  2001: "iron",
  2002: "chemical",
  2003: "flora",
  2004: "gas",
  2005: "liquid",
  2006: "powder",
  2007: "copper",
  2008: "carbon",
  2009: "fuel",
  2010: "polymer",
  2101: "hide",
  2102: "meat",
  2103: "bone",
  2104: "tissue",
};

/**
 * Inline SVG silhouette markup per glyph. Subpaths carry negative-space
 * cutouts (holes); the renderer builds filled shapes, never stroked lines,
 * so disconnected subpaths can never leak connector segments.
 */
export const RESOURCE_GLYPH_SILHOUETTES: Record<ContainerGlyphId, string> =
  RESOURCE_GLYPH_SILHOUETTE_SVGS;
