import {
  authorityIssuedAtServerTick,
  enqueueAuthorityPlaceCampCommand,
  enqueueAuthorityPlaceExtractorCommand,
  enqueueAuthorityRedeemCreditChipCommand,
  enqueueAuthoritySetEquippedClothingCommand,
  enqueueAuthorityUseConsumableCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import { getLaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import { inventoryItemDisplay } from "@successor/client/src/slice-core/inventoryDisplaySystem";
import { setEquippedWeaponAuthoritative } from "@successor/client/src/slice-core/loadoutSystem";
import { isWeaponId, type WeaponId } from "@successor/client/src/slice-core/weaponSystem";
import { CAMP_KIT_ITEM_ID } from "@successor/client/src/slice-core/campSystem";
import { CREDIT_CHIP_ITEM_ID } from "../trade/types";
import type { InventoryRow, PlayState, ServerAuthorityActorAppearanceState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  createInventoryScope,
  isDatapadInventoryRowInScope,
  isLocalInventoryContainerInScope,
  refreshInventoryScope,
  type InventoryOwnerIdentity,
} from "@successor/client/src/slice-core/inventoryScope";
import type { InventoryCategory, InventoryItemVM, InventoryViewModel, PaperDollVM } from "./types";
import itemModelsJson from "./itemModels.json";
import { ITEM_DESCRIPTION_BY_ID, itemDescriptionFor } from "./itemCopy";
import { isResourceRow, resourceInfoForRow } from "./resourceInfo";
import { setActiveSurveyCategory } from "../survey/store";
import {
  extractorCategoryForItemId,
  isExtractorToolItemId,
  isSurveyToolItemId,
  surveyFamilyForCategory,
  surveyToolCategoryForItemId,
} from "@successor/client/src/slice-core/resourceCategories";
import { FIELD_MULTITOOL_ITEM_ID } from "../crafting/types";
import {
  equipmentIdForInventoryText,
  get as getEquippedGear,
  has as hasEquippedGear,
  setEquippedGearPlayerId,
  subscribe as subscribeEquippedGearStore,
  toggle as toggleEquippedGear,
} from "./equippedGearStore";
import { travelTicketDataForRow, type TravelTicketData } from "../travel/travelSystem";
import { useTravelTicket } from "../travel/travelActions";
import { currentCharacterAppearanceKey, readCachedCharacterAppearance } from "../appearanceCache";
import { WARDROBE_PIECES } from "../../assets/wardrobe.gen";
import { LEGACY_WEARABLE_WORN_IDS, pawnPackEquipmentIds, resolveAuthoritativeActorEquipmentIds } from "../../render/equipmentSlots";

interface InventoryUiState {
  open: boolean;
  selectedKey: string | null;
  hoveredKey: string | null;
}

export interface InventoryDisplayMetadata {
  label: string;
  description: string;
  category: InventoryCategory;
}

interface ReusableInventoryItemVM extends InventoryItemVM {
  seenAtBuild: number;
}

interface ItemModelFile {
  _comment?: string;
  [itemId: string]: string | undefined;
}

const itemModels = itemModelsJson as ItemModelFile;
/** Durable 3D safety model for unknown/future inventory item ids. */
export const UNKNOWN_ITEM_MODEL_PATH = "/assets/world-items/supply_cache.glb";
const staticDisplayItemIds = new Set<number>();
for (const [itemId, modelPath] of Object.entries(itemModels)) {
  if (itemId === "_comment") continue;
  if (typeof modelPath !== "string") continue;
  const numericItemId = Number(itemId);
  if (Number.isInteger(numericItemId)) staticDisplayItemIds.add(numericItemId);
}

/** Canonical base item per authority weapon — the row marked equipped for legacy zero-item snapshots. */
const canonicalItemIdByWeaponId: Partial<Record<WeaponId, number>> = {
  slugthrower: 3101,
  "wpn-pistol": 3122,
  "wpn-smg": 3111,
  "wpn-carbine": 3112,
  "lightning-carbine": 3121,
  "wpn-assault": 3123,
  "wpn-shotgun": 3124,
  "wpn-sniper": 3125,
  "wpn-heavy": 3126,
  "wpn-launcher": 3127,
  vibrosword: 3103,
  "scrapline-machete": 3105,
  "field-saber": 3106,
  "quarry-chopper": 3107,
};

const weaponIdByItemId: Partial<Record<number, WeaponId>> = {
  3101: "slugthrower",
  3103: "vibrosword",
  // Plasma sword shares Vibrosword authority behavior; weaponItemId drives presentation.
  3104: "vibrosword",
  3105: "scrapline-machete",
  3106: "field-saber",
  3107: "quarry-chopper",
  3111: "wpn-smg",
  3112: "wpn-carbine",
  3121: "lightning-carbine",
  3122: "wpn-pistol",
  3123: "wpn-assault",
  3124: "wpn-shotgun",
  3125: "wpn-sniper",
  3126: "wpn-heavy",
  3127: "wpn-launcher",
};

const consumableCommandIdByItemId: Partial<Record<number, string>> = {
  1001: "stimpak_a",
  1002: "field_bandage",
  1005: "body_enhancement_pack_a",
  1006: "spirit_enhancement_pack_a",
  // MEDIC WAVE consumables (open-use):
  1007: "advanced_stimpak",
  1008: "anti_dizzy_stim",
  1009: "anti_blind_stim",
};

const localEquipmentIdByItemId: Partial<Record<number, string>> = {
  // Non-clothing pawn-pack attachment surfaced from an authority row; equip
  // state stays a client-local gear-store toggle (no authority route yet).
  1004: "armor_harness",
};

/**
 * Legacy humanoid wearable aliases (shared eight-item contract): loot rows in
 * the 71xx/72xx range are authority-owned CLOTHING. Each id resolves to its
 * shipped pawn-pack worn key, equips through SetEquippedClothing, and renders
 * equipped truth from the authority row/worn set — never a client-local
 * gear-store toggle. Keys must stay in LEGACY_WEARABLE_WORN_IDS
 * (render/equipmentSlots.ts) so the doll and world pawns accept them.
 */
interface LegacyWearableAlias {
  /** Shared pawn-pack worn/equipment key (SetEquippedClothing contract). */
  key: string;
  /** Display name when the key is not a creator wardrobe piece (headwear). */
  label?: string;
}
const legacyWearableAliasByItemId: Partial<Record<number, LegacyWearableAlias>> = {
  7101: { key: "top_plated_rig_vest" },
  7102: { key: "top_scrap_plate_tunic" },
  7103: { key: "helmet_s2", label: "Combat Helm" },
  7104: { key: "legs_gaitered_cargo_pants" },
  7201: { key: "top_frayed_tunic" },
  7202: { key: "legs_padded_canvas_trousers" },
  7203: { key: "hat_field_cap", label: "Field Cap" },
  7204: { key: "top_padded_leather_vest" },
  9900001: { key: "under_bodysuit" },
};

/**
 * Local gear catalog — pawn-pack equipment surfaced as always-present,
 * client-local inventory items (spinning GLB thumbnails + equip/unequip via
 * the gear store). Registered by loadPawnPack() once the equipment manifest
 * resolves. This is the seed of the ITEM REGISTRY pattern: crafting output
 * definitions will extend this same table rather than inventing a new one.
 */
export interface LocalGearCatalogEntry {
  id: string;
  label: string;
  description: string;
  glb: string;
}
const AUTHORITY_CLOTHING_MIN_ID = 7301;
const AUTHORITY_CLOTHING_MAX_ID = 7335;
const wardrobePieceById = new Map(WARDROBE_PIECES.map((piece) => [piece.id, piece] as const));
const clothingDescriptionBySlot: Readonly<Record<string, string>> = {
  under_torso: "Clothing · No stats",
  under_legs: "Clothing · No stats",
  under_feet: "Clothing · No stats",
  under_hands: "Clothing · No stats",
};

function authorityClothingKeyForRow(row: InventoryRow): string | null {
  const alias = legacyWearableAliasByItemId[row.itemId];
  if (alias) return alias.key;
  if (row.itemId < AUTHORITY_CLOTHING_MIN_ID || row.itemId > AUTHORITY_CLOTHING_MAX_ID) return null;
  const key = String(row.item ?? "").trim();
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(key) ? key : null;
}

function isAuthorityClothingRow(row: InventoryRow): boolean {
  return authorityClothingKeyForRow(row) !== null;
}

const LOCAL_GEAR_KEY_PREFIX = "local:gear:";

const localGearAvailableIds = new Set<string>();
const paperDollCreatorAvailableIds = new Set(WARDROBE_PIECES.map((piece) => piece.id));
const localGearCatalog: LocalGearCatalogEntry[] = [];
const localGearRows = new Map<string, InventoryRow>();

export function registerLocalGearCatalog(entries: readonly LocalGearCatalogEntry[]): void {
  localGearCatalog.length = 0;
  localGearRows.clear();
  localGearAvailableIds.clear();
  for (const entry of entries) {
    localGearCatalog.push(entry);
    localGearAvailableIds.add(entry.id);
    // Stable synthetic authority-row stand-in (never sent anywhere).
    localGearRows.set(entry.id, {
      container: "local:gear",
      item: entry.label,
      itemId: -1,
      variantId: 0,
      quantity: 1,
      reserved: 0,
      available: 1,
    });
  }
}

/**
 * Local gear/player owner scope. The authority may key the player's containers
 * by the fixture ACTOR id ("player") or by the session IDENTITY id ("observer",
 * from ?player=): the sim migrates fixture rows to the identity at join. Match
 * both families or the pane goes empty depending on shard age. The predicate
 * lives in slice-core so HUD query verbs and the 3D inventory never drift.
 *
 * Real persistent-character launches (`characterId` or ticket) DO NOT surface
 * client-local gear rows: their inventory truth is the authority rows only.
 * Auto-enter fixtures keep the classic local gear catalog for harness/lab flows.
 */
const localInventoryScope = createInventoryScope();
const cachedInventoryIdentity: InventoryOwnerIdentity = { playerId: null, characterId: null };
let cachedIdentityPlayerId: string | null = null;
let cachedIdentityCharacterId: string | null = null;
let cachedIdentityKey: string | null = null;

function resolveIdentityIds(): void {
  if (typeof window === "undefined") return;
  const selected = (window as Window & { __successorSelectedCharacter?: { id?: unknown } }).__successorSelectedCharacter;
  const selectedId = typeof selected?.id === "string" ? selected.id : "";
  const identityKey = `${window.location.search}\u0000${selectedId}`;
  if (cachedIdentityKey === identityKey) return;
  cachedIdentityKey = identityKey;
  cachedIdentityPlayerId = null;
  cachedIdentityCharacterId = null;
  try {
    const identity = getLaunchIdentity();
    cachedIdentityPlayerId = identity.playerId || null;
    cachedIdentityCharacterId = identity.characterId ?? null;
  } catch {
    // identity unavailable (tests) — actor ids still match
  }
}

function refreshLocalOwners(state: PlayState): void {
  resolveIdentityIds();
  cachedInventoryIdentity.playerId = cachedIdentityPlayerId;
  cachedInventoryIdentity.characterId = cachedIdentityCharacterId;
  refreshInventoryScope(localInventoryScope, state, cachedInventoryIdentity);
}

function isLocalContainer(container: string): boolean {
  return isLocalInventoryContainerInScope(localInventoryScope, container);
}

function isPersistentCharacterInventory(): boolean {
  if (cachedIdentityCharacterId) return true;
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return Boolean(params.get("characterId")?.trim() || params.get("ticket")?.trim());
}

/**
 * Player-owned container check for surfaces outside the main inventory VM
 * (tool-GUI gating): resolves identity and refreshes the owner cache first,
 * so corpse/NPC/exchange rows never pass as "carried".
 */
export function isLocalInventoryContainer(state: PlayState, container: string): boolean {
  refreshLocalOwners(state);
  return isLocalContainer(container);
}

const displayMetadataByItemId = new Map<number, InventoryDisplayMetadata>();
const itemVmByKey = new Map<string, ReusableInventoryItemVM>();
const reusedItems: ReusableInventoryItemVM[] = [];
const reusedDoll: PaperDollVM = { body: "male", equipmentIds: getEquippedGear(), weaponId: null };
const reusedViewModel: InventoryViewModel = {
  open: false,
  items: reusedItems,
  selectedKey: null,
  hoveredKey: null,
  doll: reusedDoll,
};
let buildGeneration = 0;
let cachedLaunchIdentityBody: PaperDollVM["body"] | null | undefined;
/** Last-known appearance snapshot mapped to wire shape; undefined = unread. */
let cachedFallbackAppearance: ServerAuthorityActorAppearanceState | null | undefined;

/**
 * earlier sandbox design semantics: before the first authority snapshot lands (fixture slices,
 * reconnects, examine-while-loading) the doll renders the PRECISE last-known
 * clientside appearance — the localStorage snapshot the world pawn renderer
 * writes on every equipment attach — never the clay-default template. Read
 * once per session: by the time it could change, live authority appearance
 * outranks it anyway.
 */
function fallbackDollAppearance(): ServerAuthorityActorAppearanceState | null {
  if (cachedFallbackAppearance !== undefined) return cachedFallbackAppearance;
  const cached = readCachedCharacterAppearance(currentCharacterAppearanceKey());
  cachedFallbackAppearance = cached
    ? {
      skin: cached.skinTone,
      hair: cached.hair,
      hair_mat: cached.hairMat,
      face: cached.face
        ? {
          eyes: cached.face.eyes,
          brows: cached.face.brows,
          nose: cached.face.nose,
          mouth: cached.face.mouth,
          eye_color: cached.face.eyeColor,
          brow_color: cached.face.browColor,
          lip_color: cached.face.lipColor,
        }
        : null,
    }
    : null;
  return cachedFallbackAppearance ?? null;
}

function cachedFallbackDollBody(): PaperDollVM["body"] | null {
  const cached = readCachedCharacterAppearance(currentCharacterAppearanceKey());
  return cached?.body ?? null;
}

/**
 * Reuse contract: buildInventoryViewModel mutates and returns the same
 * InventoryViewModel object, the same items array, and stable item objects keyed
 * by `${container}:${itemId}:${variantId}`. Consumers must treat a returned VM as
 * valid only until the next buildInventoryViewModel call and copy anything they
 * need to retain across frames.
 */
export function buildInventoryViewModel(state: PlayState, ui: InventoryUiState): InventoryViewModel {
  resolveIdentityIds();
  refreshLocalOwners(state);
  // Gear-store namespace keys on the STABLE session identity (survives shard
  // restarts and actor-id remapping), falling back to the actor id.
  setEquippedGearPlayerId(cachedIdentityPlayerId ?? (state.serverAuthority.playerActorId ?? state.playerActorId));
  const activeWeaponId = activeWeaponIdForState(state);
  const dollActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const dollActor = state.serverAuthority.actors[dollActorId];
  const dollAppearance = dollActor?.appearance ?? fallbackDollAppearance();
  // The loaded pawn-pack manifest is the allowlist for authority worn ids.
  // Keep the legacy union only before pack registration (tests/early boot).
  const registeredEquipmentIds = pawnPackEquipmentIds();
  const availableDollEquipmentIds = new Set(
    registeredEquipmentIds.size > 0 ? registeredEquipmentIds : paperDollCreatorAvailableIds,
  );
  if (registeredEquipmentIds.size === 0) {
    for (const itemId of localGearAvailableIds) availableDollEquipmentIds.add(itemId);
    for (const key of Object.keys(LEGACY_WEARABLE_WORN_IDS)) availableDollEquipmentIds.add(key);
  }
  if (typeof dollAppearance?.hair === "string"
    && (registeredEquipmentIds.size === 0 || registeredEquipmentIds.has(dollAppearance.hair))) {
    availableDollEquipmentIds.add(dollAppearance.hair);
  }
  const equipmentIds = resolveAuthoritativeActorEquipmentIds({
    availableIds: availableDollEquipmentIds,
    authorityWornIds: dollActor?.worn?.map((piece) => piece.item) ?? [],
    savedHairId: dollAppearance?.hair ?? null,
  });
  buildGeneration += 1;
  reusedItems.length = 0;

  for (const row of state.inventory) {
    if (row.available <= 0 || !isLocalContainer(row.container)) continue;
    const key = stackKey(row);
    let vm = itemVmByKey.get(key);
    if (!vm) {
      vm = {
        key,
        itemId: row.itemId,
        label: "",
        description: "",
        category: "item",
        count: 0,
        equipped: false,
        glb: UNKNOWN_ITEM_MODEL_PATH,
        resource: null,
        row,
        local: false,
        equipmentId: null,
        seenAtBuild: buildGeneration,
      };
      itemVmByKey.set(key, vm);
    }

    const display = displayMetadataForRow(row);
    const weaponId = weaponIdByItemId[row.itemId];
    const equipmentId = equipmentIdForInventoryRow(row);
    vm.itemId = row.itemId;
    vm.label = display.label;
    vm.description = display.description;
    vm.category = display.category;
    vm.count = stackCount(row);
    const authorityEquippedItemId = equippedWeaponItemIdFor(state);
    const authorityEquippedVariantId = equippedWeaponVariantIdFor(state);
    const authorityClothing = isAuthorityClothingRow(row);
    vm.equipped = authorityClothing
      ? row.equipped === true
      : Boolean(
        (weaponId && activeWeaponId === weaponId
          && (authorityEquippedItemId > 0
            ? authorityEquippedItemId === row.itemId && authorityEquippedVariantId === row.variantId
            : canonicalItemIdByWeaponId[weaponId] === row.itemId && row.variantId === 0))
        || (equipmentId && hasEquippedGear(equipmentId)),
      );
    vm.glb = authorityClothing ? modelPathForAuthorityClothing(row) : modelPathForItemId(row.itemId);
    vm.resource = resourceInfoForRow(row, { category: display.category, fallbackName: display.label });
    vm.row = row;
    vm.equipmentId = equipmentId;
    vm.local = false;
    vm.seenAtBuild = buildGeneration;
    reusedItems.push(vm);
  }

  // Client-local equipment rows (wardrobe/lab gear) are only a fixture/lab
  // affordance. Real persistent characters render authority inventory exactly;
  // their creator-selected clothes live on actor.worn, not in the item bag.
  if (!isPersistentCharacterInventory()) {
    for (const entry of localGearCatalog) {
      const key = `local:gear:${entry.id}`;
      const row = localGearRows.get(entry.id)!;
      let vm = itemVmByKey.get(key);
      if (!vm) {
        vm = {
          key,
          itemId: -1,
          label: "",
          description: "",
          category: "gear",
          count: 1,
          equipped: false,
          glb: UNKNOWN_ITEM_MODEL_PATH,
          resource: null,
          row,
          equipmentId: entry.id,
          local: true,
          seenAtBuild: buildGeneration,
        };
        itemVmByKey.set(key, vm);
      }
      vm.label = entry.label;
      vm.description = entry.description;
      vm.category = "gear";
      vm.count = 1;
      vm.equipped = hasEquippedGear(entry.id);
      vm.glb = entry.glb;
      vm.resource = null;
      vm.equipmentId = entry.id;
      vm.local = true;
      vm.seenAtBuild = buildGeneration;
      reusedItems.push(vm);
    }
  }

  for (const [key, vm] of itemVmByKey) {
    if (vm.seenAtBuild !== buildGeneration) itemVmByKey.delete(key);
  }

  reusedDoll.body = paperDollBodyForState(state);
  reusedDoll.equipmentIds = equipmentIds;
  reusedDoll.weaponId = activeWeaponId;
  reusedDoll.weaponItemId = equippedWeaponItemIdFor(state);
  // Wire appearance reference for the doll's skin tint + appearance hair —
  // same actor the body/sprite resolution uses. Worn set rides along for the
  // creator-outfit palette (zone colors on attached pieces).
  reusedDoll.appearance = dollAppearance;
  reusedDoll.worn = dollActor?.worn ?? null;
  reusedViewModel.open = ui.open;
  reusedViewModel.selectedKey = ui.selectedKey;
  reusedViewModel.hoveredKey = ui.hoveredKey;
  return reusedViewModel;
}

export function toolbarItemIdForInventoryItem(vm: InventoryItemVM): string {
  // Toolbar item refs intentionally store the stable catalog/type id, not the
  // volatile InventoryItemVM.key (`container:itemId:variant[:stack]`). Authority
  // rows use InventoryRow.itemId (e.g. Stimpak A = "1001"), so a split/merge or
  // restart can still resolve the current carried stack. Client-local wardrobe
  // gear has a synthetic row.itemId of -1, so it uses the local gear catalog id
  // under the existing `local:gear:` namespace (e.g. Harness equipment ids).
  if (vm.local) return vm.equipmentId ? `${LOCAL_GEAR_KEY_PREFIX}${vm.equipmentId}` : vm.key;
  return String(vm.itemId);
}

/**
 * Authoritative backing item id of the equipped weapon (weaponItemId snapshot
 * field), 0 when absent/legacy. Disambiguates presentation-variant items that
 * share one authority weapon id (vibrosword 3103 vs plasma sword 3104).
 */
function equippedWeaponItemIdFor(state: PlayState): number {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const weapon = state.serverAuthority.actors[actorId]?.weapon;
  return weapon && typeof weapon === "object" && "weaponItemId" in weapon
    ? Number((weapon as { weaponItemId?: unknown }).weaponItemId ?? 0)
    : 0;
}
function equippedWeaponVariantIdFor(state: PlayState): number {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const weapon = state.serverAuthority.actors[actorId]?.weapon;
  if (!weapon || typeof weapon !== "object" || !("weaponVariantId" in weapon)) return 0;
  const value = weapon.weaponVariantId;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function applyInventoryAction(
  state: PlayState,
  slice: SliceSnapshot,
  vm: InventoryItemVM,
): "equipped" | "unequipped" | "unsupported" {
  const clothingKey = authorityClothingKeyForRow(vm.row);
  if (clothingKey) {
    const queued = enqueueAuthoritySetEquippedClothingCommand(
      state.authorityCommands,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
      vm.itemId,
      !vm.equipped,
      vm.row.stackId !== undefined ? String(vm.row.stackId) : undefined,
      vm.row.variantId,
      vm.row.container,
    );
    if (!queued) return "unsupported";
    state.status = `${vm.equipped ? "unequipping" : "equipping"} ${vm.label}`;
    return vm.equipped ? "unequipped" : "equipped";
  }
  resolveIdentityIds();
  setEquippedGearPlayerId(cachedIdentityPlayerId ?? (state.serverAuthority.playerActorId ?? state.playerActorId));
  const weaponId = weaponIdByItemId[vm.itemId];
  if (vm.category === "weapon" && weaponId) {
    const result = setEquippedWeaponAuthoritative(
      state,
      slice,
      vm.equipped ? null : weaponId,
      vm.equipped ? undefined : vm.itemId,
      vm.equipped ? undefined : vm.row.variantId,
    );
    if (!result) return "unsupported";
    return vm.equipped ? "unequipped" : "equipped";
  }
  if (vm.category !== "gear" && vm.category !== "weapon") return "unsupported";
  const equipmentId = vm.equipmentId ?? equipmentIdForInventoryRow(vm.row);
  if (!equipmentId) return "unsupported";
  return toggleEquippedGear(equipmentId);
}

/**
 * Context-menu action registry. Computed per item from category + provenance;
 * crafting/use/destroy grow here as their BE routes land — the menu renders
 * whatever this returns, so new verbs are data, not new UI code. Disabled
 * actions carry an HONEST note (no fake affordances).
 */
export type InventoryActionId = "examine" | "equip" | "unequip" | "use" | "place" | "destroy" | "open-tool" | "craft" | "splice-bench" | "split" | "redeem";

export type InventoryActionResult = "equipped" | "unequipped" | "used" | "placed" | "examined" | "opened" | "redeemed" | "unsupported";

export function defaultInventoryActionFor(vm: InventoryItemVM, _state: PlayState): InventoryActionId | null {
  if (vm.category === "gear") return vm.equipped ? "unequip" : "equip";
  if (vm.category === "weapon") return vm.equipped ? "unequip" : "equip";
  if (vm.category === "medical") return "use";
  if (vm.itemId === CREDIT_CHIP_ITEM_ID && vm.row.stackId !== undefined) return "redeem";
  if (isExtractorToolItemId(vm.itemId)) return "place";
  if (vm.itemId === CAMP_KIT_ITEM_ID) return "place";
  if (travelTicketDataForRow(vm.row)) return "use";
  return null;
}

/**
 * EXAMINE sink — injected by boot wiring (sets the examine window's item and
 * opens it). Lives here so `dispatchInventoryAction` owns the route: any
 * action path (radial today, future verbs tomorrow) opens examine without
 * UI modules special-casing it. Module-level by design, mirroring
 * equippedGearStore's store pattern; data code never imports the window
 * manager.
 */
let examineOpener: ((key: string) => void) | null = null;

export function registerExamineOpener(open: ((key: string) => void) | null): void {
  examineOpener = open;
}

/**
 * Honest verb affordance for gated item actions (travel tickets, extractor
 * placement): enabled or a player-readable reason, never a fake button.
 */
export interface ActionGateResult {
  enabled: boolean;
  note: string | null;
}

/**
 * TRAVEL-GATE sink — injected by boot wiring with live state/slice closure.
 * Returns the honest affordance for a ticket's TRAVEL NOW verb (in range of
 * its origin terminal or not). Module-level by the examine-opener pattern.
 */
let travelTicketGate: ((data: TravelTicketData) => ActionGateResult) | null = null;

export function registerTravelTicketGate(gate: ((data: TravelTicketData) => ActionGateResult) | null): void {
  travelTicketGate = gate;
}

/**
 * SURVEY-TOOL sink — injected by boot wiring (opens the survey tool window).
 * Same module-level pattern as the examine sink: tools open FROM their
 * inventory item (owner ruling — no hotkeys, no dock button for tools).
 */
let surveyToolOpener: (() => void) | null = null;

export function registerSurveyToolOpener(open: (() => void) | null): void {
  surveyToolOpener = open;
}

/**
 * EXTRACTOR-PLACEMENT gate — injected by boot wiring with live state closure.
 * Honest affordance for the deployable's PLACE verb (standing + no unit
 * already down); the sim re-validates every gate on submit regardless.
 */
let extractorPlacementGate: (() => ActionGateResult) | null = null;

export function registerExtractorPlacementGate(gate: (() => ActionGateResult) | null): void {
  extractorPlacementGate = gate;
}

/**
 * CAMP-PLACEMENT gate — injected by boot wiring with live state closure.
 * Honest affordance for the camp kit's PITCH verb (standing + one camp per
 * player); the sim re-validates every gate on submit regardless.
 */
let campPlacementGate: (() => ActionGateResult) | null = null;

export function registerCampPlacementGate(gate: (() => ActionGateResult) | null): void {
  campPlacementGate = gate;
}

/**
 * CRAFT sink — injected by boot wiring (opens the CRAFT window). The bench is
 * context-only (no dock button or global hotkey): carried raw-resource rows,
 * the Field Multitool, and device/station routes are the player entries.
 */
let craftToolOpener: (() => void) | null = null;

export function registerCraftToolOpener(open: (() => void) | null): void {
  craftToolOpener = open;
}

/**
 * SPLICE-BENCH sink — injected by boot wiring (opens the GENE BENCH window).
 * Context-only like craft: the Splice Bench row (6_202) and station routes
 * are the player entries (no dock button, no global hotkey).
 */
let spliceBenchOpener: (() => void) | null = null;

export function registerSpliceBenchOpener(open: (() => void) | null): void {
  spliceBenchOpener = open;
}

export interface InventoryContextAction {
  id: InventoryActionId;
  label: string;
  enabled: boolean;
  note: string | null;
}

const scratchActions: InventoryContextAction[] = [];

export function contextActionsFor(vm: InventoryItemVM): readonly InventoryContextAction[] {
  scratchActions.length = 0;
  // EXAMINE leads for every item — the universal, always-enabled verb.
  scratchActions.push({ id: "examine", label: "EXAMINE", enabled: true, note: null });
  if (isSurveyToolItemId(vm.itemId)) {
    scratchActions.push({
      id: "open-tool",
      label: "OPEN",
      enabled: surveyToolOpener !== null,
      note: surveyToolOpener ? null : "TOOL GUI NOT WIRED",
    });
  }
  if (isExtractorToolItemId(vm.itemId)) {
    const gate = extractorPlacementGate
      ? extractorPlacementGate()
      : { enabled: false, note: "DEPLOY GATE NOT WIRED" };
    scratchActions.push({ id: "place", label: "PLACE", enabled: gate.enabled, note: gate.note });
  }
  if (vm.itemId === CAMP_KIT_ITEM_ID) {
    const gate = campPlacementGate
      ? campPlacementGate()
      : { enabled: false, note: "CAMP GATE NOT WIRED" };
    // PITCH, not PLACE: a camp is raised, and the label carries the sim's
    // single-use ruling where the player decides (consumed on placement).
    scratchActions.push({ id: "place", label: "PITCH CAMP · KIT IS SPENT", enabled: gate.enabled, note: gate.note });
  }
  if (vm.itemId === FIELD_MULTITOOL_ITEM_ID) {
    scratchActions.push({
      id: "craft",
      label: "CRAFT",
      enabled: craftToolOpener !== null,
      note: craftToolOpener ? null : "BENCH GUI NOT WIRED",
    });
  }
  // Splice Bench (6_202, design §0.5) — opens the GENE BENCH window.
  if (vm.itemId === 6_202) {
    scratchActions.push({
      id: "splice-bench",
      label: "OPEN BENCH",
      enabled: spliceBenchOpener !== null,
      note: spliceBenchOpener ? null : "BENCH GUI NOT WIRED",
    });
  }
  // Raw materials teach the bench too — a carried resource stack names the
  // door to CRAFT (opener injected by boot wiring; absent = no dead verb).
  if (vm.category === "resource" && craftToolOpener !== null && isLocalContainer(vm.row.container)) {
    scratchActions.push({ id: "craft", label: "OPEN CRAFTING", enabled: true, note: null });
  }
  if (vm.row.stackId !== undefined && vm.row.available > 1 && isLocalContainer(vm.row.container)) {
    // SPLIT is handled by the inventory shell (it owns the slider dialog);
    // the registry only advertises it for splittable, carried stacks.
    scratchActions.push({ id: "split", label: "SPLIT", enabled: true, note: null });
  }
  const equippable = vm.category === "gear" || vm.category === "weapon";
  if (equippable) {
    scratchActions.push({
      id: vm.equipped ? "unequip" : "equip",
      label: vm.equipped ? "UNEQUIP" : "EQUIP",
      enabled: true,
      note: null,
    });
  }
  const travelTicket = travelTicketDataForRow(vm.row);
  if (travelTicket) {
    const gate = travelTicketGate
      ? travelTicketGate(travelTicket)
      : { enabled: false, note: "TRANSIT LINK NOT WIRED" };
    scratchActions.push({ id: "use", label: "TRAVEL NOW", enabled: gate.enabled, note: gate.note });
  } else if (vm.category === "medical") {
    const enabled = consumableCommandIdForItem(vm.itemId) !== null;
    scratchActions.push({
      id: "use",
      label: "USE",
      enabled,
      note: enabled ? null : "NO FIELD USE PROTOCOL · BE ROUTE PENDING",
    });
  } else if (vm.itemId === CREDIT_CHIP_ITEM_ID) {
    const enabled = vm.row.stackId !== undefined && isLocalContainer(vm.row.container) && vm.row.available > 0;
    scratchActions.push({
      id: "redeem",
      label: "REDEEM",
      enabled,
      note: enabled ? null : "TAKE THE CHIP FIRST",
    });
  } else if (vm.category === "item") {
    scratchActions.push({
      id: "use",
      label: "USE",
      enabled: false,
      note: "NO FIELD USE PROTOCOL · BE ROUTE PENDING",
    });
  }
  // DISCARD STACK — the authority DiscardStack route deletes the exact
  // carried stack. Only owned, server-backed stacks advertise it; synthetic
  // local gear and foreign rows stay silent. The inventory shell owns the
  // two-step arm/confirm (stackOps).
  if (!vm.local && vm.row.stackId !== undefined && isLocalContainer(vm.row.container)) {
    scratchActions.push({ id: "destroy", label: "DISCARD STACK", enabled: true, note: null });
  }
  return scratchActions;
}

export function dispatchInventoryAction(
  state: PlayState,
  slice: SliceSnapshot,
  vm: InventoryItemVM,
  actionId: InventoryActionId,
): InventoryActionResult {
  if (actionId === "open-tool") {
    if (!surveyToolOpener) return "unsupported";
    // The category tool that opened the window sets its active survey category.
    setActiveSurveyCategory(surveyToolCategoryForItemId(vm.itemId) ?? "mineral");
    surveyToolOpener();
    return "opened";
  }
  if (actionId === "craft") {
    if (!craftToolOpener) return "unsupported";
    craftToolOpener();
    return "opened";
  }
  if (actionId === "splice-bench") {
    if (!spliceBenchOpener) return "unsupported";
    spliceBenchOpener();
    return "opened";
  }
  if (actionId === "equip" || actionId === "unequip") return applyInventoryAction(state, slice, vm);
  if (actionId === "use") {
    const travelTicket = travelTicketDataForRow(vm.row);
    if (travelTicket) {
      // Hotbar/default paths bypass the context menu's disabled state — re-run
      // the gate here so an out-of-range press never queues a doomed command.
      if (travelTicketGate && !travelTicketGate(travelTicket).enabled) return "unsupported";
      return useTravelTicket(state, slice, { row: vm.row, data: travelTicket }) ? "used" : "unsupported";
    }
    return useInventoryItem(state, slice, vm);
  }
  if (actionId === "place") {
    // Hotbar/default paths bypass the context menu's disabled state — re-run
    // the gate here so a doomed deploy never leaves the client.
    if (isExtractorToolItemId(vm.itemId)) {
      if (extractorPlacementGate && !extractorPlacementGate().enabled) return "unsupported";
      const category = extractorCategoryForItemId(vm.itemId) ?? "mineral";
      const queued = enqueueAuthorityPlaceExtractorCommand(
        state.authorityCommands,
        surveyFamilyForCategory(category),
        authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
      );
      if (!queued) return "unsupported";
      state.status = `${vm.label} deployed at your feet`;
      return "placed";
    }
    if (vm.itemId === CAMP_KIT_ITEM_ID) {
      if (campPlacementGate && !campPlacementGate().enabled) return "unsupported";
      const queued = enqueueAuthorityPlaceCampCommand(
        state.authorityCommands,
        authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
      );
      if (!queued) return "unsupported";
      state.status = "camp pitched at your feet — the kit is spent";
      return "placed";
    }
    return "unsupported";
  }
  if (actionId === "redeem") {
    if (vm.itemId !== CREDIT_CHIP_ITEM_ID || vm.row.stackId === undefined || !isLocalContainer(vm.row.container)) {
      return "unsupported";
    }
    const queued = enqueueAuthorityRedeemCreditChipCommand(
      state.authorityCommands,
      vm.row.container,
      String(vm.row.stackId),
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    if (!queued) return "unsupported";
    // Optimistic HUD toast; the authoritative balance follows on the actor snapshot.
    state.status = `redeeming credit chip — +${vm.count.toLocaleString()} credits`;
    return "redeemed";
  }
  if (actionId === "examine") {
    if (!examineOpener) return "unsupported";
    examineOpener(vm.key);
    return "examined";
  }
  return "unsupported";
}

function useInventoryItem(state: PlayState, slice: SliceSnapshot, vm: InventoryItemVM): InventoryActionResult {
  const commandId = consumableCommandIdForItem(vm.itemId);
  if (!commandId) return "unsupported";
  const queued = enqueueAuthorityUseConsumableCommand(
    state.authorityCommands,
    commandId,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    vm.itemId,
    vm.row.variantId,
  );
  if (!queued) return "unsupported";
  state.status = vm.label;
  return "used";
}

function consumableCommandIdForItem(itemId: number): string | null {
  const commandId = consumableCommandIdByItemId[itemId];
  return commandId && commandId.length > 0 ? commandId : null;
}

/**
 * Inventory item resolution — a PRIVATE scratch VM, deliberately separate from
 * the inventory window's reused VM (that one goes stale the moment the
 * inventory window is closed). `resolveInventoryItem` resolves exact VM keys
 * for examine panes; `resolveInventoryItemByCatalogId` resolves stable toolbar
 * item refs (`InventoryRow.itemId` or `local:gear:<id>`) against the current
 * carried inventory. Returns null when the item is no longer held.
 * The returned VM is valid until the next resolver call in this module.
 */

const examineScratchRow: InventoryRow = {
  container: "",
  item: "",
  itemId: -1,
  variantId: 0,
  quantity: 0,
  reserved: 0,
  available: 0,
};

const examineScratchVm: InventoryItemVM = {
  key: "",
  itemId: -1,
  label: "",
  description: "",
  category: "item",
  count: 0,
  equipped: false,
  glb: UNKNOWN_ITEM_MODEL_PATH,
  resource: null,
  local: false,
  equipmentId: null,
  row: examineScratchRow,
};

export function resolveInventoryItemByCatalogId(state: PlayState, itemId: string): InventoryItemVM | null {
  resolveIdentityIds();
  refreshLocalOwners(state);
  setEquippedGearPlayerId(cachedIdentityPlayerId ?? (state.serverAuthority.playerActorId ?? state.playerActorId));
  const ref = itemId.trim();
  if (!ref) return null;
  if (ref.startsWith(LOCAL_GEAR_KEY_PREFIX)) return isPersistentCharacterInventory() ? null : resolveLocalGearRef(ref);
  const numericItemId = Number(ref);
  if (!Number.isInteger(numericItemId) || numericItemId < 0) return null;
  const activeWeaponId = activeWeaponIdForState(state);
  let bestRow: InventoryRow | null = null;
  let totalCount = 0;
  for (const row of state.inventory) {
    if (row.itemId !== numericItemId || row.available <= 0 || !isLocalContainer(row.container)) continue;
    const count = stackCount(row);
    if (count <= 0) continue;
    totalCount += count;
    if (!bestRow || isBetterCatalogRow(row, bestRow)) bestRow = row;
  }
  return bestRow ? fillScratchVmFromRow(stackKey(bestRow), bestRow, activeWeaponId, equippedWeaponItemIdFor(state), totalCount) : null;
}

export function resolveInventoryItem(state: PlayState, key: string): InventoryItemVM | null {
  resolveIdentityIds();
  refreshLocalOwners(state);
  setEquippedGearPlayerId(cachedIdentityPlayerId ?? (state.serverAuthority.playerActorId ?? state.playerActorId));
  if (key.startsWith(LOCAL_GEAR_KEY_PREFIX)) return isPersistentCharacterInventory() ? null : resolveLocalGearRef(key);
  const activeWeaponId = activeWeaponIdForState(state);
  for (const row of state.inventory) {
    if (stackKey(row) !== key) continue;
    if (row.available <= 0) return null;
    return fillScratchVmFromRow(key, row, activeWeaponId, equippedWeaponItemIdFor(state));
  }
  return null;
}

function resolveLocalGearRef(key: string): InventoryItemVM | null {
  const gearId = key.slice(LOCAL_GEAR_KEY_PREFIX.length);
  for (const entry of localGearCatalog) {
    if (entry.id !== gearId) continue;
    return fillScratchVmFromLocalGear(key, entry);
  }
  return null;
}

function fillScratchVmFromLocalGear(key: string, entry: LocalGearCatalogEntry): InventoryItemVM | null {
  const row = localGearRows.get(entry.id);
  if (!row) return null;
  examineScratchVm.key = key;
  examineScratchVm.itemId = -1;
  examineScratchVm.label = entry.label;
  examineScratchVm.description = entry.description;
  examineScratchVm.category = "gear";
  examineScratchVm.count = 1;
  examineScratchVm.equipped = hasEquippedGear(entry.id);
  examineScratchVm.glb = entry.glb;
  examineScratchVm.resource = null;
  examineScratchVm.row = row;
  examineScratchVm.equipmentId = entry.id;
  examineScratchVm.local = true;
  return examineScratchVm;
}
function fillScratchVmFromRow(
  key: string,
  row: InventoryRow,
  activeWeaponId: WeaponId | null,
  equippedItemId: number,
  countOverride?: number,
): InventoryItemVM {
  const display = displayMetadataForRow(row);
  const weaponId = weaponIdByItemId[row.itemId];
  const equipmentId = equipmentIdForInventoryRow(row);
  examineScratchVm.key = key;
  examineScratchVm.itemId = row.itemId;
  examineScratchVm.label = display.label;
  examineScratchVm.description = display.description;
  examineScratchVm.category = display.category;
  examineScratchVm.count = countOverride ?? stackCount(row);
  const authorityClothing = isAuthorityClothingRow(row);
  examineScratchVm.equipped = authorityClothing
    ? row.equipped === true
    : Boolean(
      (weaponId && activeWeaponId === weaponId
        && (equippedItemId > 0
          ? equippedItemId === row.itemId
          : canonicalItemIdByWeaponId[weaponId] === row.itemId))
      || (equipmentId && hasEquippedGear(equipmentId)),
    );
  examineScratchVm.glb = authorityClothing ? modelPathForAuthorityClothing(row) : modelPathForItemId(row.itemId);
  examineScratchVm.resource = resourceInfoForRow(row, { category: display.category, fallbackName: display.label });
  examineScratchVm.row = row;
  examineScratchVm.equipmentId = equipmentId;
  examineScratchVm.local = false;
  return examineScratchVm;
}

function isBetterCatalogRow(candidate: InventoryRow, best: InventoryRow): boolean {
  const candidateVariant = String(candidate.variantId);
  const bestVariant = String(best.variantId);
  if (candidateVariant !== bestVariant) return candidateVariant > bestVariant;
  return stackCount(candidate) > stackCount(best);
}

/**
 * Filtered item collection for secondary grids (datapad). Own VM map + own
 * generation counter, deliberately SEPARATE from buildInventoryViewModel's
 * reuse pool — two builders sharing one keyed pool would evict each other's
 * entries every alternating frame. Same reuse contract: the returned array
 * and VMs are valid until the next collect call on the same scratch.
 */
export interface CollectedItemsScratch {
  vmByKey: Map<string, ReusableInventoryItemVM>;
  items: InventoryItemVM[];
  generation: number;
}

export function createCollectedItemsScratch(): CollectedItemsScratch {
  return { vmByKey: new Map(), items: [], generation: 0 };
}

export function collectInventoryItems(
  state: PlayState,
  filter: (row: InventoryRow) => boolean,
  scratch: CollectedItemsScratch,
): InventoryItemVM[] {
  resolveIdentityIds();
  refreshLocalOwners(state);
  setEquippedGearPlayerId(cachedIdentityPlayerId ?? (state.serverAuthority.playerActorId ?? state.playerActorId));
  const activeWeaponId = activeWeaponIdForState(state);
  scratch.generation += 1;
  scratch.items.length = 0;
  for (const row of state.inventory) {
    if (row.available <= 0 || !filter(row)) continue;
    const key = stackKey(row);
    let vm = scratch.vmByKey.get(key);
    if (!vm) {
      vm = {
        key,
        itemId: row.itemId,
        label: "",
        description: "",
        category: "item",
        count: 0,
        equipped: false,
        glb: UNKNOWN_ITEM_MODEL_PATH,
        resource: null,
        row,
        local: false,
        equipmentId: null,
        seenAtBuild: scratch.generation,
      };
      scratch.vmByKey.set(key, vm);
    }
    const display = displayMetadataForRow(row);
    const weaponId = weaponIdByItemId[row.itemId];
    const equipmentId = equipmentIdForInventoryRow(row);
    vm.itemId = row.itemId;
    vm.label = display.label;
    vm.description = display.description;
    vm.category = display.category;
    vm.count = stackCount(row);
    const authorityEquippedItemId = equippedWeaponItemIdFor(state);
    const authorityClothing = isAuthorityClothingRow(row);
    vm.equipped = authorityClothing
      ? row.equipped === true
      : Boolean(
        (weaponId && activeWeaponId === weaponId
          && (authorityEquippedItemId > 0
            ? authorityEquippedItemId === row.itemId
            : canonicalItemIdByWeaponId[weaponId] === row.itemId))
        || (equipmentId && hasEquippedGear(equipmentId)),
      );
    vm.glb = authorityClothing ? modelPathForAuthorityClothing(row) : modelPathForItemId(row.itemId);
    vm.resource = resourceInfoForRow(row, { category: display.category, fallbackName: display.label });
    vm.row = row;
    vm.equipmentId = equipmentId;
    vm.local = false;
    vm.seenAtBuild = scratch.generation;
    scratch.items.push(vm);
  }
  for (const [key, vm] of scratch.vmByKey) {
    if (vm.seenAtBuild !== scratch.generation) scratch.vmByKey.delete(key);
  }
  return scratch.items;
}

/** Datapad rows: exchange-stored stacks + mission chits held by the player. */
export function isDatapadRow(row: InventoryRow): boolean {
  return isDatapadInventoryRowInScope(row, localInventoryScope);
}

export function modelPathForItemId(itemId: number): string {
  const value = itemModels[String(itemId)];
  return typeof value === "string" && value.length > 0 ? value : UNKNOWN_ITEM_MODEL_PATH;
}
function modelPathForAuthorityClothing(row: InventoryRow): string {
  // Legacy humanoid wearables ship explicit runtime assets (Armor helmets,
  // custom accessories) — the static model table is their path truth.
  if (legacyWearableAliasByItemId[row.itemId]) return modelPathForItemId(row.itemId);
  const key = authorityClothingKeyForRow(row);
  return key ? `/assets/pawn-pack/equipment/Under/${key}.glb` : UNKNOWN_ITEM_MODEL_PATH;
}

export function weaponIdForInventoryItemId(itemId: number): WeaponId | null {
  return weaponIdByItemId[itemId] ?? null;
}

export function equipmentIdForInventoryRow(row: InventoryRow): string | null {
  const authorityClothing = authorityClothingKeyForRow(row);
  if (authorityClothing) return authorityClothing;
  const mapped = localEquipmentIdByItemId[row.itemId];
  if (mapped) return mapped;
  const byItemName = equipmentIdForInventoryText(row.item);
  if (byItemName) return byItemName;
  return equipmentIdForInventoryText(String(row.itemId));
}

export const subscribeEquippedGear = subscribeEquippedGearStore;

/** Shared display metadata (label/description/category) for an
 * authority row — exported for surfaces that render item lines they don't
 * hold locally (the TRADE window's partner column synthesizes rows). */
export function displayMetadataForRow(row: InventoryRow): InventoryDisplayMetadata {
  if (staticDisplayItemIds.has(row.itemId) && !isResourceRow(row)) {
    const cached = displayMetadataByItemId.get(row.itemId);
    if (cached) return cached;
    const created = createDisplayMetadata(row);
    displayMetadataByItemId.set(row.itemId, created);
    return created;
  }
  return createDisplayMetadata(row);
}

function createDisplayMetadata(row: InventoryRow): InventoryDisplayMetadata {
  const display = inventoryItemDisplay(row);
  const resource = resourceInfoForRow(row, { category: display.category, fallbackName: display.name });
  const weaponId = weaponIdByItemId[row.itemId];
  const equipmentId = equipmentIdForInventoryRow(row);
  const clothing = wardrobePieceById.get(authorityClothingKeyForRow(row) ?? "");
  let category: InventoryCategory = resource ? "resource" : display.category;
  if (weaponId) category = "weapon";
  else if (equipmentId) category = "gear";
  // Copy principle: NAMES pass through when plain nouns; resource variants
  // use the authority's player-facing variant label, lead with taxonomy in
  // the description channel, and keep the itemCopy PURPOSE line ("what is
  // this for") when one exists — discoverability must survive the resource
  // presentation.
  const purposeCopy = ITEM_DESCRIPTION_BY_ID[row.itemId];
  return {
    label: clothing?.name ?? legacyWearableAliasByItemId[row.itemId]?.label ?? resource?.displayName ?? display.name,
    description: clothing
      ? clothingDescriptionBySlot[clothing.slot] ?? "Worn clothing."
      : resource
        ? purposeCopy ? `${resource.taxonomySubtitle} · ${purposeCopy}` : resource.taxonomySubtitle
        : itemDescriptionFor(row.itemId),
    category,
  };
}


function activeWeaponIdForState(state: PlayState): WeaponId | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const authorityActor = state.serverAuthority.actors[actorId];
  if (authorityActor) {
    const authorityWeaponId = authorityActor.weapon?.weaponId;
    return authorityWeaponId && isWeaponId(authorityWeaponId) ? authorityWeaponId : null;
  }
  const loadoutWeaponId = state.loadout.activeWeaponId;
  return loadoutWeaponId && isWeaponId(loadoutWeaponId) ? loadoutWeaponId : null;
}

function paperDollBodyForState(state: PlayState): PaperDollVM["body"] {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const sprite = state.serverAuthority.actors[actorId]?.sprite ?? null;
  if (sprite) return sprite.includes("female") ? "female" : "male";
  const launchBody = launchIdentityBodyFallback();
  if (launchBody) return launchBody;
  // Last-known snapshot beats the hash guess (last-recorded semantics).
  const cachedBody = cachedFallbackDollBody();
  if (cachedBody) return cachedBody;
  return hashId(actorId) % 4 === 0 ? "female" : "male";
}

function launchIdentityBodyFallback(): PaperDollVM["body"] | null {
  if (cachedLaunchIdentityBody !== undefined) return cachedLaunchIdentityBody;
  cachedLaunchIdentityBody = null;
  if (typeof window === "undefined") return cachedLaunchIdentityBody;

  const selectedCharacter = (window as Window & { __successorSelectedCharacter?: { variantId?: string } }).__successorSelectedCharacter;
  const params = new URLSearchParams(window.location.search);
  const variantId = selectedCharacter?.variantId ?? params.get("variant") ?? params.get("sprite");
  if (variantId) cachedLaunchIdentityBody = variantId.includes("female") ? "female" : "male";
  return cachedLaunchIdentityBody;
}

function hashId(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stackKey(row: InventoryRow): string {
  // stackId joins the identity so two stacks of the same item render as
  // two slots (split/merge era); rows without stackId keep legacy keys.
  return row.stackId === undefined
    ? `${row.container}:${row.itemId}:${row.variantId}`
    : `${row.container}:${row.itemId}:${row.variantId}:${row.stackId}`;
}

function stackCount(row: InventoryRow): number {
  const available = Number(row.available);
  if (Number.isFinite(available)) return Math.max(0, Math.trunc(available));
  const quantity = Number(row.quantity);
  return Number.isFinite(quantity) ? Math.max(0, Math.trunc(quantity)) : 0;
}
