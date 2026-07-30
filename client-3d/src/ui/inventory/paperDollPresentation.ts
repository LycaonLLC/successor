import { isMeleeWeaponPresentation } from "@successor/client/src/slice-core/weaponSystem";
import { weaponModelAssetKey } from "../../assets/weaponModelRegistry";

export type PaperDollWeaponLane = "none" | "rifle" | "melee";

export interface PaperDollWeaponPresentation {
  lane: PaperDollWeaponLane;
  modelKey: string | null;
  visible: boolean;
}

/**
 * Resolve the inventory mannequin's weapon exactly like the world/examine
 * renderers: authority weapon id chooses the animation lane and catalog item
 * id chooses the authored model. "unarmed" is a melee combat presentation,
 * but deliberately has no held or stowed model.
 */
export function resolvePaperDollWeaponPresentation(
  weaponId: string | null,
  weaponItemId = 0,
): PaperDollWeaponPresentation {
  const visible = Boolean(weaponId && weaponId !== "unarmed");
  if (!visible) return { lane: "none", modelKey: null, visible: false };
  return {
    lane: isMeleeWeaponPresentation(weaponId) ? "melee" : "rifle",
    modelKey: weaponModelAssetKey(weaponItemId, weaponId),
    visible: true,
  };
}
