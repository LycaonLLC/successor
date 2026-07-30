import type { InventoryRow, ServerAuthorityActorAppearanceState, ServerAuthorityActorWornPiece } from "@successor/client/src/slice-core/gameState";
import type { ResourceDisplayInfo } from "./resourceInfo";

/**
 * Inventory UI shared contract — the three inventory modules (data adapter,
 * DOM shell, 3D model/paper-doll renderer) meet ONLY through these types.
 *
 * Data flow per frame while the pane is open:
 *   buildInventoryViewModel(state) -> InventoryViewModel
 *     -> shell reconciles DOM slots + description panel
 *     -> model renderer paints rotating item models into slot rects and the
 *        paper doll into the doll rect (one overlay canvas, scissor viewports).
 */

export type InventoryCategory = "ammo" | "medical" | "resource" | "tool" | "gear" | "currency" | "item" | "weapon";

export interface InventoryItemVM {
  /** Stable slot key: `${container}:${itemId}:${variantId}`. */
  key: string;
  itemId: number;
  label: string;
  description: string;
  category: InventoryCategory;
  /** Stack count shown on the slot badge. */
  count: number;
  /** Item currently equipped by the player (weapon/gear highlight). */
  equipped: boolean;
  /** Required GLB asset path for the rotating 3D thumbnail. */
  glb: string;
  /** True for client-local wardrobe items (pawn-pack gear), false for authority rows. */
  local: boolean;
  /** Pawn-pack equipment id when this item is wearable gear, else null. */
  equipmentId: string | null;
  /** Parsed resource taxonomy/variant/stat presentation, or null for non-resources. */
  resource: ResourceDisplayInfo | null;
  /** Raw authority row backing this VM entry (synthetic stand-in for local items). */
  row: InventoryRow;
}

export interface PaperDollVM {
  /** Pawn body to clone for the doll. */
  body: "male" | "female";
  /** Equipment item ids (pawn-pack equipment manifest ids) to attach. */
  equipmentIds: readonly string[];
  /** Equipped weapon id (slugthrower rig shown when "slugthrower"), or null. */
  weaponId: string | null;
  /** Backing item id of the equipped weapon (0/absent = legacy). Presentation
   * variants (plasma sword 3104 over the vibrosword authority id) key off this. */
  weaponItemId?: number;
  /** Local pawn wire appearance (skin tint + appearance hair); null until the
   * first authority snapshot lands. Direct wire reference — never mutated. */
  appearance?: ServerAuthorityActorAppearanceState | null;
  /** Local pawn worn set (creator outfit; item ids + zone colors). Direct
   * wire reference — never mutated. */
  worn?: readonly ServerAuthorityActorWornPiece[] | null;
  inCombat?: boolean | undefined;
}

export interface InventoryViewModel {
  open: boolean;
  items: InventoryItemVM[];
  selectedKey: string | null;
  hoveredKey: string | null;
  doll: PaperDollVM;
}

/** Rects the shell publishes each layout pass for the model renderer. */
export interface InventoryLayoutRects {
  /** Canvas-space rect per item key (device pixels, y-down from canvas top). */
  slots: ReadonlyMap<string, DOMRectReadOnly>;
  /** Right-hand paper-doll pane rect, or null while the pane is closed. */
  doll: DOMRectReadOnly | null;
  /** Scrollable grid viewport in canvas space — slot previews are scissored
   * to it so scrolled-out rows never paint over the chrome (DEF-13b). */
  gridClip: DOMRectReadOnly | null;
}
