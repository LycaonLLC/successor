/**
 * Build catalog model — the UI-side view of homebuilder catalog entries.
 *
 * Mirrors the runtime contract (successor.homebuilder-runtime-contract.v1):
 * grid cell = 1000 milli, one level, rotations 0=N 1=E 2=S 3=W, tile modules
 * anchor on the cell min corner, edge modules occupy the edge of their anchor
 * cell. The authority owns validation and material consumption — this module
 * only names, groups and prices things for the panel.
 */

export type BuildCategory = "floors" | "walls" | "openings" | "roofs" | "furniture";

export type BuildKind = "floor" | "wall" | "door" | "window" | "roof" | "furniture";

export type BuildRotation = 0 | 1 | 2 | 3;

export type BuildTool = "place" | "remove";

export interface BuildCatalogItem {
  /** Authority catalog_id (BuildPlace.catalog_id). */
  readonly id: string;
  /** Short display noun, already uppercase-stencil friendly. */
  readonly label: string;
  readonly category: BuildCategory;
  readonly kind: BuildKind;
  /** Footprint in cells; edge modules are [1, 0]. */
  readonly span: readonly [number, number];
  /** Material id → units consumed on place. */
  readonly cost: Readonly<Record<string, number>>;
}

export interface BuildPalette {
  primary: string | null;
  secondary: string | null;
  accent: string | null;
}

export const BUILD_CATEGORIES: readonly { id: BuildCategory; label: string }[] = [
  { id: "floors", label: "FLOORS" },
  { id: "walls", label: "WALLS" },
  { id: "openings", label: "OPENINGS" },
  { id: "roofs", label: "ROOFS" },
  { id: "furniture", label: "FURNITURE" },
];

/** Contract catalog_minimum, grouped for the palette. Controllers may extend. */
export const DEFAULT_BUILD_CATALOG: readonly BuildCatalogItem[] = [
  { id: "floor_1x1", label: "FLOOR PANEL", category: "floors", kind: "floor", span: [1, 1], cost: { structural: 2 } },
  { id: "wall_1m", label: "WALL SEGMENT", category: "walls", kind: "wall", span: [1, 0], cost: { structural: 2 } },
  { id: "door_slide_1m", label: "SLIDE DOOR", category: "openings", kind: "door", span: [1, 0], cost: { structural: 3, mechanical: 1 } },
  { id: "window_1m", label: "WINDOW", category: "openings", kind: "window", span: [1, 0], cost: { structural: 2, glass: 1 } },
  { id: "roof_1x1", label: "ROOF PANEL", category: "roofs", kind: "roof", span: [1, 1], cost: { structural: 2 } },
];

const MATERIAL_SHORT: Record<string, string> = {
  structural: "STRUCT",
  mechanical: "MECH",
  glass: "GLASS",
};

/** "structural" → "STRUCT"; unknown ids fall back to a trimmed uppercase tag. */
export function materialShortName(materialId: string): string {
  return MATERIAL_SHORT[materialId] ?? materialId.toUpperCase().slice(0, 6);
}

/** "2 STRUCT · 1 MECH" — stable order: structural first, then alphabetical. */
export function costText(cost: Readonly<Record<string, number>>): string {
  const ids = Object.keys(cost).sort((a, b) =>
    a === "structural" ? -1 : b === "structural" ? 1 : a.localeCompare(b),
  );
  return ids.map((id) => `${cost[id]} ${materialShortName(id)}`).join(" · ");
}

/** True when every cost line is covered by owned materials. */
export function affordable(
  cost: Readonly<Record<string, number>>,
  owned: Readonly<Record<string, number>>,
): boolean {
  return Object.entries(cost).every(([id, units]) => (owned[id] ?? 0) >= units);
}

/** Edge modules snap to a cell edge; tile modules cover whole cells. */
export function isEdgeItem(item: BuildCatalogItem): boolean {
  return item.span[1] === 0;
}

/** "1×1 CELL · CELL SNAP" or "1 m EDGE · EDGE SNAP". */
export function dimensionText(item: BuildCatalogItem): string {
  if (isEdgeItem(item)) return `${item.span[0]} m EDGE · EDGE SNAP`;
  return `${item.span[0]}×${item.span[1]} CELL · CELL SNAP`;
}

const ROTATION_LETTERS = ["N", "E", "S", "W"] as const;

/** Cardinal letter for a rotation quarter (0=N 1=E 2=S 3=W). */
export function rotationLetter(q: BuildRotation): string {
  return ROTATION_LETTERS[q];
}
