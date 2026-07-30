/**
 * Loot drag contract — shared between the LOOT window (drag source) and the
 * inventory window (drop target). Lives outside both modules so neither
 * imports the other (shell exports grid vocabulary the loot window reuses).
 *
 * The MIME type is deliberately NOT the inventory/toolbar item type: loot
 * tiles must never be accepted by the toolbar or stackOps merge — only the
 * inventory window's loot-drop zone understands this payload, and dropping
 * it enqueues the authoritative per-stack `TakeLootItem` command.
 */
export const LOOT_DRAG_MIME = "text/x-sc3d-loot";

export interface LootDragPayload {
  container: string;
  itemId: number;
  variantId: number;
  quantity: number;
  label: string;
}

export function parseLootDragPayload(raw: string): LootDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LootDragPayload>;
    if (
      typeof parsed.container !== "string" || parsed.container.length === 0
      || typeof parsed.itemId !== "number" || !Number.isInteger(parsed.itemId) || parsed.itemId < 0
      || typeof parsed.variantId !== "number" || !Number.isInteger(parsed.variantId)
      || typeof parsed.quantity !== "number" || !Number.isInteger(parsed.quantity) || parsed.quantity <= 0
    ) {
      return null;
    }
    return {
      container: parsed.container,
      itemId: parsed.itemId,
      variantId: parsed.variantId,
      quantity: parsed.quantity,
      label: typeof parsed.label === "string" ? parsed.label : "",
    };
  } catch {
    return null;
  }
}
