import type { CraftSlotFillVM } from "./types";

export type SlotRequirementDisplaySource = Pick<
  CraftSlotFillVM,
  "resourceKindLabel" | "requiredQty" | "requiredFamily" | "requirementKind" | "requiredItemName"
>;

function slotRequirementKind(slot: SlotRequirementDisplaySource): "material_family" | "item" {
  if (
    slot.requirementKind === "item"
    || slot.requiredFamily === null
    || slot.requiredFamily === "component"
  ) {
    return "item";
  }
  return "material_family";
}

function slotRequiredItemName(slot: SlotRequirementDisplaySource): string {
  const name = slot.requiredItemName?.trim();
  if (name) return name;
  const family = slot.requiredFamily?.trim();
  if (family) return family.charAt(0).toUpperCase() + family.slice(1).replaceAll("_", " ");
  return slot.resourceKindLabel;
}

export function slotRequirementLabel(slot: SlotRequirementDisplaySource): string {
  return slotRequirementKind(slot) === "item"
    ? slotRequiredItemName(slot)
    : slot.resourceKindLabel;
}

export function slotMaterialLine(slot: SlotRequirementDisplaySource): string | null {
  if (slotRequirementKind(slot) !== "material_family") return null;
  return `${slotRequiredItemName(slot)} (×${slot.requiredQty})`;
}

export function slotQtyText(slot: SlotRequirementDisplaySource): string {
  return `×${slot.requiredQty}`;
}
