import { WARDROBE_PIECES } from "../assets/wardrobe.gen";

const creatorWardrobeIds = new Set(WARDROBE_PIECES.map((piece) => piece.id));
const registeredPawnPackEquipmentIds = new Set<string>();
const warnedUnavailableAuthorityIds = new Set<string>();
const hairEquipmentIdPattern = /^hair_[a-z0-9_]{1,64}$/u;

/**
 * Register the ids from the loaded pawn-pack equipment manifest. The manifest
 * is the runtime allowlist: creator wardrobe ids are only a legacy fallback
 * for tests/early boot, never the authority wearability contract.
 */
export function registerPawnPackEquipmentIds(ids: readonly string[]): void {
  registeredPawnPackEquipmentIds.clear();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) registeredPawnPackEquipmentIds.add(id);
  }
}

export function pawnPackEquipmentIds(): ReadonlySet<string> {
  return registeredPawnPackEquipmentIds;
}

function warnUnavailableAuthorityId(itemId: string): void {
  if (warnedUnavailableAuthorityIds.has(itemId)) return;
  warnedUnavailableAuthorityIds.add(itemId);
  console.warn(`pawn equipment: authority worn id "${itemId}" has no loaded runtime asset; skipped safely`);
}

/** Legacy authority aliases still used by the inventory paper doll catalog. */
export const LEGACY_WEARABLE_WORN_IDS: Readonly<Record<string, true>> = {
  top_plated_rig_vest: true,
  top_scrap_plate_tunic: true,
  helmet_s2: true,
  legs_gaitered_cargo_pants: true,
  top_frayed_tunic: true,
  legs_padded_canvas_trousers: true,
  hat_field_cap: true,
  top_padded_leather_vest: true,
};

export interface LocalActorEquipmentResolution {
  availableIds: ReadonlySet<string>;
  /** Legacy inventory-paper-doll local gear input. Pawn renderers must not use it. */
  localStoreIds: readonly string[];
  authorityWornIds: readonly string[];
  savedHairId?: string | null;
}

/**
 * Legacy inventory paper-doll resolver. World pawn and actor-preview renderers
 * use resolveAuthoritativeActorEquipmentIds instead, so persisted local gear
 * cannot resurrect clothing in player-role visuals.
 */
export function resolveLocalActorEquipmentIds(input: LocalActorEquipmentResolution): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  const push = (itemId: string): void => {
    if (!input.availableIds.has(itemId) || seen.has(itemId)) return;
    seen.add(itemId);
    resolved.push(itemId);
  };

  for (const itemId of input.localStoreIds) {
    if (creatorWardrobeIds.has(itemId) || hairEquipmentIdPattern.test(itemId)) continue;
    push(itemId);
  }
  for (const itemId of input.authorityWornIds) {
    if (input.availableIds.has(itemId)) push(itemId);
    else warnUnavailableAuthorityId(itemId);
  }
  if (input.savedHairId && hairEquipmentIdPattern.test(input.savedHairId)) push(input.savedHairId);
  return resolved;
}

export interface AuthoritativeActorEquipmentResolution {
  /** Equipment ids that the loaded pawn pack can actually attach. */
  availableIds: ReadonlySet<string>;
  /** Server-authoritative worn ids, in slot-resolution order. */
  authorityWornIds: readonly string[];
  /** Saved appearance hair, independent from inventory headwear. */
  savedHairId?: string | null;
}

/**
 * Resolve a player actor's visible equipment from authoritative worn state.
 *
 * Client-local gear is deliberately not an input: stale localStorage must never
 * resurrect clothing after authority publishes a different outfit (including
 * an explicitly empty worn set). Missing assets are dropped before attachment
 * and insertion order is retained so later authority slot entries
 * deterministically win in attachPawnEquipmentSet.
 */
export function resolveAuthoritativeActorEquipmentIds(
  input: AuthoritativeActorEquipmentResolution,
): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  const push = (itemId: string): void => {
    if (!input.availableIds.has(itemId) || seen.has(itemId)) return;
    seen.add(itemId);
    resolved.push(itemId);
  };

  for (const itemId of input.authorityWornIds) {
    if (input.availableIds.has(itemId)) push(itemId);
    else warnUnavailableAuthorityId(itemId);
  }
  if (input.savedHairId && hairEquipmentIdPattern.test(input.savedHairId)) push(input.savedHairId);
  return resolved;
}

/** Stable value key for authority worn ids and all zone colors. */
export function authoritativeWornKey(
  worn: readonly { item: string; colors: readonly string[] }[] | null | undefined,
): string {
  if (!worn || worn.length === 0) return "";
  let key = "";
  for (const piece of worn) key += `${piece.item}:${piece.colors.join("+")};`;
  return key;
}

export interface EquipmentSlotIdentity {
  id: string;
  slot?: string;
}

/** Appearance hair is not inventory headwear. Its source mesh may attach at the
 * cranium, but hats and helmets must not overwrite the saved character hair. */
export function equipmentExclusivitySlot(
  items: readonly EquipmentSlotIdentity[],
  itemId: string,
): string {
  if (itemId.startsWith("hair_")) return "appearance_hair";
  return items.find((item) => item.id === itemId)?.slot ?? `__raw:${itemId}`;
}
