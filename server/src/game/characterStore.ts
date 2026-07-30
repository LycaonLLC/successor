import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { GameActorAppearanceSnapshot, GameActorSnapshot, GameActorWornPiece } from "./protocol.js";
import { wardrobePieceById, wardrobeZoneColorAllowed, type WardrobeSlot } from "./wardrobe.gen.js";
import {
  FACE_BROW_COLORS,
  FACE_EYE_COLORS,
  FACE_LIP_COLORS,
  isFaceStyleId,
  type CharacterFaceConfig,
} from "./face.gen.js";

export type CharacterLiveState = "offline" | "online" | "linkdead";

/**
 * Character creation allocates one ordinary novice profession box. This is
 * deliberately not a permanent class: the Rust profession authority owns the
 * normal skill-point spend/refund rules after entry. The durable id remains
 * only as first-entry loadout provenance.
 */
export const initialProfessionIds = ["marksman", "scout", "craftsman", "medic", "brawler"] as const;
export type InitialProfessionId = typeof initialProfessionIds[number];
const initialProfessionIdSet = new Set<string>(initialProfessionIds);

/**
 * Hair is a character APPEARANCE property (owner ruling 2026-07-08), never an
 * inventory item: `hair` is the style id (which also names a `cranium`-slot
 * equipment GLB in the pawn pack), `null` = bald/shaved; `hairMat` is the color
 * material id. Style ids are pattern-validated, NOT an enum — new hairs added to
 * the pawn pack + creation picker work without touching this file.
 */
export interface CharacterAppearance {
  skinTone: string;
  hair: string | null;
  hairMat: string;
  /** Facial feature selection (face kit); null is an explicit blank face. */
  face: CharacterFaceConfig | null;
}

export interface CharacterWornEntry {
  item: string;
  colors: string[];
}

/** Fixed wearable starter loadout; creation no longer accepts clothing choices. */
export const DEFAULT_STARTER_WORN: readonly CharacterWornEntry[] = [
  { item: "under_bodysuit", colors: ["#89cff0"] },
  { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
];

export function defaultStarterWorn(): CharacterWornEntry[] {
  return DEFAULT_STARTER_WORN.map((entry) => ({ item: entry.item, colors: [...entry.colors] }));
}

export interface CharacterPositionSnapshot {
  areaId: string;
  x: number;
  y: number;
  facing: "front" | "right" | "back" | "left";
}

export interface CharacterVitalsSnapshot {
  health: number;
  action: number;
  spirit: number;
}

/**
 * Per-character record-kind API:
 * - CharacterRecord.recordKinds maps a kind string (for example `successor.macros.v1`)
 *   to a versioned list payload `{ version, items }`.
 * - Callers mutate list items only through CharacterStore.saveRecordKindItem/deleteRecordKindItem.
 * - A new record kind adds exactly one CharacterRecordKindDefinition row with caps and
 *   a normalizeItem validation hook; old records with an absent kind normalize to an empty list.
 */

export interface CharacterRecordKindItem {
  id: string;
}

export interface CharacterRecordKindPayload<TItem extends CharacterRecordKindItem = CharacterRecordKindItem> {
  version: number;
  items: TItem[];
}

export type CharacterRecordKindPayloads = Record<string, CharacterRecordKindPayload>;

export interface CharacterRecordKindCaps {
  maxItems: number;
  maxItemBytes: number;
  maxPayloadBytes: number;
}

export interface CharacterRecordKindNormalizeContext<TItem extends CharacterRecordKindItem> {
  mode: "load" | "save";
  nowIso: string;
  existing?: TItem | null;
}

export interface CharacterRecordKindDefinition<TItem extends CharacterRecordKindItem = CharacterRecordKindItem> {
  kind: string;
  version: number;
  caps: CharacterRecordKindCaps;
  normalizeItem(value: unknown, context: CharacterRecordKindNormalizeContext<TItem>): TItem | null;
  normalizeItemId?(value: unknown): string | null;
}

export interface SuccessorMacroRecord extends CharacterRecordKindItem {
  name: string;
  iconId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type CharacterSocialRelation = "friend" | "ignored";

/** One directed social edge owned by the character record. */
export interface CharacterSocialContact extends CharacterRecordKindItem {
  relation: CharacterSocialRelation;
}

export interface CharacterRecord {
  id: string;
  ownerRef: string;
  name: string;
  appearance: CharacterAppearance;
  /** Creator worn set (top/bottom/shoes/gloves), one entry max per slot. */
  worn: CharacterWornEntry[];
  /** Durable palette cache for owned creator clothing, including unequipped pieces. */
  wornColors: Record<string, string[]>;
  position: CharacterPositionSnapshot | null;
  vitals: CharacterVitalsSnapshot | null;
  /** The one novice allocation chosen before first world entry. */
  initialProfessionId: InitialProfessionId | null;
  professions: unknown | null;
  activeTitleId: string | null;
  careerGoalId: string | null;
  recordKinds: CharacterRecordKindPayloads;
  /** Durable one-way marker claimed before a character enters the world. */
  worldEntryClaimed: boolean;
  createdAt: string;
  lastSeenAt: string;
  lastLogoutAt: string | null;
  totalPlayMs: number;
}

export type CharacterRecordWithLiveState = CharacterRecord & { liveState: CharacterLiveState };

export type CreateCharacterResult =
  | { ok: true; record: CharacterRecord }
  | { ok: false; error: "invalid_id" | "invalid_name" | "invalid_appearance" | "invalid_worn" | "invalid_initial_profession" | "id_taken" | "name_taken" | "slots_full" };

export type SelectInitialProfessionResult =
  | { ok: true; record: CharacterRecord }
  | { ok: false; error: "character_not_found" | "invalid_initial_profession" | "initial_profession_locked" | "character_already_entered" };

export type CharacterRecordKindWriteError =
  | "character_not_found"
  | "unknown_record_kind"
  | "invalid_record"
  | "record_limit_exceeded"
  | "record_too_large"
  | "payload_too_large"
  | "etag_mismatch"
  | "etag_required";

export type SaveCharacterRecordKindItemResult<TItem extends CharacterRecordKindItem = CharacterRecordKindItem> =
  | { ok: true; item: TItem; payload: CharacterRecordKindPayload<TItem>; etag: string }
  | { ok: false; error: Exclude<CharacterRecordKindWriteError, "etag_mismatch"> }
  | { ok: false; error: "etag_mismatch"; payload: CharacterRecordKindPayload<TItem>; etag: string };

export type DeleteCharacterRecordKindItemResult<TItem extends CharacterRecordKindItem = CharacterRecordKindItem> =
  | { ok: true; deleted: boolean; payload: CharacterRecordKindPayload<TItem>; etag: string }
  | { ok: false; error: Exclude<CharacterRecordKindWriteError, "etag_mismatch"> }
  | { ok: false; error: "etag_mismatch"; payload: CharacterRecordKindPayload<TItem>; etag: string };

export interface CharacterRecordKindWriteOptions {
  atMs?: number;
  ownerRef?: string;
  global?: boolean;
  /** Canonical payload ETag precondition. Required for hosted conditional writes. */
  expectedEtag?: string | null;
  /** When true, missing/empty expectedEtag is rejected before mutation. */
  requireEtag?: boolean;
}

export interface CharacterStoreSnapshotOptions {
  atMs?: number;
  logout?: boolean;
  playMs?: number;
}

interface CharacterStoreData {
  schema: "successor.character-store.v2";
  characters: CharacterRecord[];
}

const characterStoreSchema = "successor.character-store.v2" as const;
// New character names are ASCII letter runs joined by at most single hyphens.
// Keep the total length bound explicit because the regex alone permits long names.
const characterNamePattern = /^(?=.{3,16}$)[A-Za-z]+(?:-[A-Za-z]+)*$/u;
const skinTonePattern = /^#[0-9a-f]{6}$/u;
// Hair style ids (appearance.hair) and hair color-material ids (appearance.hairMat)
// share the `hair_<token>` shape. Shape check only — the pawn pack / material
// system own existence, so new styles/colors need no change here.
const hairIdentifierPattern = /^hair_[a-z0-9_]{1,64}$/u;
/** Reserved owner reference for the offline dev/harness account (pre-ComPress accounts). */
export const LOCAL_OWNER_REF = "local";
/** Base per-account character slot cap for local dev/harness flows. */
export const BASE_CHARACTER_SLOT_CAP = 5;
/** Owner reference shape: a ComPress-profile id (prof_…), the reserved dev ref, etc. */
const ownerRefPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
// Durable ids cross the Colyseus/Rust actor boundary verbatim. Keep this in
// lockstep with normalizeActorId so no stored id can lowercase, rewrite, or
// truncate into a different authority owner at join time.
const characterIdPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;

/** Slot allowance the player's subscription tier grants. */
export interface CharacterSlotEntitlement {
  characterSlots?: number | null;
}

/**
 * Effective character-slot cap for an owner. A redeemed production entitlement
 * carries the purchased slot count directly (0 = no playable subscription);
 * absent entitlement keeps the five-slot local dev fallback.
 */
export function characterSlotCap(entitlement?: CharacterSlotEntitlement | null): number {
  if (!entitlement) return BASE_CHARACTER_SLOT_CAP;
  const granted = typeof entitlement.characterSlots === "number" && Number.isFinite(entitlement.characterSlots)
    ? Math.trunc(entitlement.characterSlots)
    : 0;
  return Math.min(10, Math.max(0, granted));
}
const defaultSkinTone = "#c78f62";
const defaultHairStyleId = "hair_mop";
const defaultHairMat = "hair_raven";
const defaultAppearance: CharacterAppearance = {
  skinTone: defaultSkinTone,
  hair: defaultHairStyleId,
  hairMat: defaultHairMat,
  face: null,
};

export const successorMacrosRecordKind = "successor.macros.v1" as const;
export const successorMacroRecordIdMaxCharacters = 64;
export const successorMacroRecordNameMaxCharacters = 48;
export const successorMacroRecordIconIdMaxCharacters = 64;
export const successorMacroRecordBodyMaxBytes = 8 * 1024;
export const successorMacrosRecordCaps = {
  maxItems: 64,
  maxItemBytes: 10 * 1024,
  maxPayloadBytes: 640 * 1024,
  maxBodyBytes: successorMacroRecordBodyMaxBytes,
  maxNameCharacters: successorMacroRecordNameMaxCharacters,
  maxIconIdCharacters: successorMacroRecordIconIdMaxCharacters,
} as const satisfies CharacterRecordKindCaps & {
  maxBodyBytes: number;
  maxNameCharacters: number;
  maxIconIdCharacters: number;
};

export const successorSocialRecordKind = "successor.social.v1" as const;
export const successorSocialRecordCaps = {
  maxItems: 512,
  maxItemBytes: 256,
  maxPayloadBytes: 128 * 1024,
} as const satisfies CharacterRecordKindCaps;

const recordItemIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const macroIconIdPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/u;
const successorMacrosRecordDefinition: CharacterRecordKindDefinition<SuccessorMacroRecord> = {
  kind: successorMacrosRecordKind,
  version: 1,
  caps: successorMacrosRecordCaps,
  normalizeItem: normalizeSuccessorMacroRecord,
};
const successorSocialRecordDefinition: CharacterRecordKindDefinition<CharacterSocialContact> = {
  kind: successorSocialRecordKind,
  version: 1,
  caps: successorSocialRecordCaps,
  normalizeItem: normalizeCharacterSocialContact,
  normalizeItemId: normalizeCharacterId,
};
const characterRecordKindDefinitions: CharacterRecordKindDefinition[] = [successorMacrosRecordDefinition, successorSocialRecordDefinition];
const characterRecordKindDefinitionsByKind = new Map<string, CharacterRecordKindDefinition>(
  characterRecordKindDefinitions.map((definition) => [definition.kind, definition]),
);

export function characterRecordKindDefinition(kind: string): CharacterRecordKindDefinition | null {
  return characterRecordKindDefinitionsByKind.get(kind) ?? null;
}

export function listCharacterRecordKindDefinitions(): CharacterRecordKindDefinition[] {
  return [...characterRecordKindDefinitions];
}

export class CharacterStore {
  private data: CharacterStoreData | null = null;

  constructor(private readonly filePath: string, private readonly clock = () => Date.now()) {}

  list(ownerRef: string = LOCAL_OWNER_REF): CharacterRecord[] {
    return this.cloneRecords(this.load().characters.filter((record) => record.ownerRef === ownerRef));
  }

  ownerRefs(): string[] {
    return [...new Set(this.load().characters.map((record) => record.ownerRef))];
  }

  get(id: string, ownerRef: string = LOCAL_OWNER_REF): CharacterRecord | null {
    const record = this.load().characters.find((character) => character.id === id && character.ownerRef === ownerRef);
    return record ? cloneRecord(record) : null;
  }

  /** Check the durable identity index without assuming an owner namespace. */
  hasId(id: string): boolean {
    return this.load().characters.some((character) => character.id === id);
  }

  /** Resolve an exact durable id or a globally unique name, without owner scoping. */
  resolveCharacter(value: unknown): CharacterRecord | null {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return null;
    const byId = this.load().characters.find((record) => record.id === raw);
    if (byId) return cloneRecord(byId);
    const name = raw.toLowerCase();
    const matches = this.load().characters.filter((record) => record.name.toLowerCase() === name);
    return matches.length === 1 ? cloneRecord(matches[0]!) : null;
  }

  listSocialContacts(characterId: string): CharacterSocialContact[] | null {
    const record = this.load().characters.find((candidate) => candidate.id === characterId);
    if (!record) return null;
    const definition = characterRecordKindDefinition(successorSocialRecordKind) as CharacterRecordKindDefinition<CharacterSocialContact>;
    return cloneUnknown(ensureRecordKindPayload(record, definition).items);
  }
  saveSocialContact(
    characterId: string,
    targetId: string,
    relation: CharacterSocialRelation,
    atMs = this.clock(),
  ): SaveCharacterRecordKindItemResult<CharacterSocialContact> {
    return this.saveRecordKindItem<CharacterSocialContact>(
      characterId,
      successorSocialRecordKind,
      { id: targetId, relation },
      { atMs, global: true },
    );
  }

  deleteSocialContact(
    characterId: string,
    targetId: string,
  ): DeleteCharacterRecordKindItemResult<CharacterSocialContact> {
    return this.deleteRecordKindItem<CharacterSocialContact>(
      characterId,
      successorSocialRecordKind,
      targetId,
      { global: true },
    );
  }

  /** True when any durable character may already own Rust world state. */
  hasEnteredWorld(): boolean {
    return this.load().characters.some((character) => character.worldEntryClaimed);
  }

  recordKindPayload<TItem extends CharacterRecordKindItem = CharacterRecordKindItem>(
    id: string,
    kind: string,
    ownerRef: string = LOCAL_OWNER_REF,
  ): CharacterRecordKindPayload<TItem> | null {
    const definition = characterRecordKindDefinition(kind) as CharacterRecordKindDefinition<TItem> | null;
    if (!definition) return null;
    const record = this.load().characters.find((character) => character.id === id && character.ownerRef === ownerRef);
    if (!record) return null;
    return cloneUnknown(ensureRecordKindPayload(record, definition)) as CharacterRecordKindPayload<TItem>;
  }

  /**
   * Canonical content-hash ETag for a character record-kind payload. Returns null
   * when the character is absent under the owner scope (non-enumerating miss).
   */
  recordKindPayloadEtag(
    id: string,
    kind: string,
    ownerRef: string = LOCAL_OWNER_REF,
  ): string | null {
    const payload = this.recordKindPayload(id, kind, ownerRef);
    return payload ? canonicalRecordKindPayloadEtag(payload) : null;
  }

  listRecordKindItems<TItem extends CharacterRecordKindItem = CharacterRecordKindItem>(
    id: string,
    kind: string,
    ownerRef: string = LOCAL_OWNER_REF,
  ): TItem[] | null {
    return this.recordKindPayload<TItem>(id, kind, ownerRef)?.items ?? null;
  }

  saveRecordKindItem<TItem extends CharacterRecordKindItem = CharacterRecordKindItem>(
    id: string,
    kind: string,
    item: unknown,
    options: CharacterRecordKindWriteOptions = {},
  ): SaveCharacterRecordKindItemResult<TItem> {
    const definition = characterRecordKindDefinition(kind) as CharacterRecordKindDefinition<TItem> | null;
    if (!definition) return { ok: false, error: "unknown_record_kind" };
    const data = this.load();
    const ownerRef = options.ownerRef ?? LOCAL_OWNER_REF;
    const record = data.characters.find((character) => character.id === id && (options.global || character.ownerRef === ownerRef));
    if (!record) return { ok: false, error: "character_not_found" };
    const payload = ensureRecordKindPayload<TItem>(record, definition);
    const currentEtag = canonicalRecordKindPayloadEtag(payload);
    const expected = normalizeExpectedEtag(options.expectedEtag);
    if (options.requireEtag && !expected) {
      return { ok: false, error: "etag_required" };
    }
    if (expected !== null && expected !== currentEtag) {
      return { ok: false, error: "etag_mismatch", payload: cloneUnknown(payload), etag: currentEtag };
    }
    const itemId = definition.normalizeItemId?.((item as { id?: unknown } | null | undefined)?.id)
      ?? normalizeRecordItemId((item as { id?: unknown } | null | undefined)?.id);
    if (!itemId) return { ok: false, error: "invalid_record" };
    const existingIndex = payload.items.findIndex((candidate) => candidate.id === itemId);
    const existing = existingIndex >= 0 ? payload.items[existingIndex] ?? null : null;
    const nowIso = new Date(options.atMs ?? this.clock()).toISOString();
    const normalized = definition.normalizeItem(item, { mode: "save", nowIso, existing });
    if (!normalized) return { ok: false, error: "invalid_record" };
    if (jsonByteLength(normalized) > definition.caps.maxItemBytes) return { ok: false, error: "record_too_large" };
    const nextItems = payload.items.slice();
    if (existingIndex >= 0) {
      nextItems[existingIndex] = normalized;
    } else {
      nextItems.push(normalized);
    }
    if (nextItems.length > definition.caps.maxItems) return { ok: false, error: "record_limit_exceeded" };
    const nextPayload: CharacterRecordKindPayload<TItem> = { version: definition.version, items: nextItems };
    if (jsonByteLength(nextPayload) > definition.caps.maxPayloadBytes) return { ok: false, error: "payload_too_large" };
    record.recordKinds[definition.kind] = nextPayload as CharacterRecordKindPayload;
    this.save(data);
    const etag = canonicalRecordKindPayloadEtag(nextPayload);
    return { ok: true, item: cloneUnknown(normalized), payload: cloneUnknown(nextPayload), etag };
  }

  deleteRecordKindItem<TItem extends CharacterRecordKindItem = CharacterRecordKindItem>(
    id: string,
    kind: string,
    itemId: unknown,
    options: CharacterRecordKindWriteOptions = {},
  ): DeleteCharacterRecordKindItemResult<TItem> {
    const definition = characterRecordKindDefinition(kind) as CharacterRecordKindDefinition<TItem> | null;
    if (!definition) return { ok: false, error: "unknown_record_kind" };
    const normalizedItemId = definition.normalizeItemId?.(itemId) ?? normalizeRecordItemId(itemId);
    if (!normalizedItemId) return { ok: false, error: "invalid_record" };
    const data = this.load();
    const ownerRef = options.ownerRef ?? LOCAL_OWNER_REF;
    const record = data.characters.find((character) => character.id === id && (options.global || character.ownerRef === ownerRef));
    if (!record) return { ok: false, error: "character_not_found" };
    const payload = ensureRecordKindPayload<TItem>(record, definition);
    const currentEtag = canonicalRecordKindPayloadEtag(payload);
    const expected = normalizeExpectedEtag(options.expectedEtag);
    if (options.requireEtag && !expected) {
      return { ok: false, error: "etag_required" };
    }
    if (expected !== null && expected !== currentEtag) {
      return { ok: false, error: "etag_mismatch", payload: cloneUnknown(payload), etag: currentEtag };
    }
    const nextItems = payload.items.filter((candidate) => candidate.id !== normalizedItemId);
    if (nextItems.length === payload.items.length) {
      return { ok: true, deleted: false, payload: cloneUnknown(payload), etag: currentEtag };
    }
    const nextPayload: CharacterRecordKindPayload<TItem> = { version: definition.version, items: nextItems };
    record.recordKinds[definition.kind] = nextPayload as CharacterRecordKindPayload;
    this.save(data);
    const etag = canonicalRecordKindPayloadEtag(nextPayload);
    return { ok: true, deleted: true, payload: cloneUnknown(nextPayload), etag };
  }

  create(input: {
    id?: unknown;
    name: unknown;
    appearance: unknown;
    worn?: unknown;
    ownerRef?: string;
    slotCap?: number;
    bypassSlotCap?: boolean;
    /** Omitted only for an explicit interrupted-creation draft. Player-facing routes require it. */
    initialProfessionId?: unknown;
  }): CreateCharacterResult {
    const requestedId = input.id === undefined ? null : normalizeCharacterId(input.id);
    if (input.id !== undefined && !requestedId) return { ok: false, error: "invalid_id" };
    const ownerRef = normalizeOwnerRef(input.ownerRef);
    const name = normalizeCharacterName(input.name);
    if (!name) return { ok: false, error: "invalid_name" };
    const appearance = normalizeCharacterAppearance(input.appearance);
    if (!appearance) return { ok: false, error: "invalid_appearance" };
    const worn = defaultStarterWorn();
    const initialProfessionId = input.initialProfessionId === undefined
      ? null
      : normalizeInitialProfessionId(input.initialProfessionId);
    if (input.initialProfessionId !== undefined && !initialProfessionId) {
      return { ok: false, error: "invalid_initial_profession" };
    }

    const data = this.load();
    const id = requestedId ?? this.nextCharacterId(data);
    if (data.characters.some((record) => record.id === id)) return { ok: false, error: "id_taken" };
    const accountCharacters = data.characters.filter((record) => record.ownerRef === ownerRef);
    if (!input.bypassSlotCap) {
      const slotCap = input.slotCap ?? characterSlotCap();
      if (accountCharacters.length >= slotCap) return { ok: false, error: "slots_full" };
    }
    const lowerName = name.toLowerCase();
    if (data.characters.some((record) => record.name.toLowerCase() === lowerName)) {
      return { ok: false, error: "name_taken" };
    }

    const now = new Date(this.clock()).toISOString();
    const record: CharacterRecord = {
      id,
      ownerRef,
      name,
      appearance,
      wornColors: wornColorsFromWorn(worn),
      worn,
      position: null,
      vitals: null,
      initialProfessionId,
      professions: initialProfessionId ? initialProfessionState(initialProfessionId) : null,
      activeTitleId: null,
      careerGoalId: null,
      recordKinds: emptyRecordKinds(),
      worldEntryClaimed: false,
      createdAt: now,
      lastSeenAt: now,
      lastLogoutAt: null,
      totalPlayMs: 0,
    };
    data.characters.push(record);
    this.save(data);
    return { ok: true, record: cloneRecord(record) };
  }

  /**
   * Resolve a pre-existing, never-entered character that predates the creation
   * picker. The same choice is retry-safe; changing it after it has been
   * committed is refused so a request retry cannot swap the eventual kit.
   */
  selectInitialProfession(
    id: string,
    professionId: unknown,
    ownerRef: string = LOCAL_OWNER_REF,
  ): SelectInitialProfessionResult {
    const normalized = normalizeInitialProfessionId(professionId);
    if (!normalized) return { ok: false, error: "invalid_initial_profession" };
    const data = this.load();
    const record = data.characters.find((character) => character.id === id && character.ownerRef === ownerRef);
    if (!record) return { ok: false, error: "character_not_found" };
    if (record.worldEntryClaimed) return { ok: false, error: "character_already_entered" };
    if (record.initialProfessionId !== null) {
      return record.initialProfessionId === normalized
        ? { ok: true, record: cloneRecord(record) }
        : { ok: false, error: "initial_profession_locked" };
    }
    record.initialProfessionId = normalized;
    record.professions = initialProfessionState(normalized);
    this.save(data);
    return { ok: true, record: cloneRecord(record) };
  }

  /** Permanently removes a character that has never entered the world. */
  delete(id: string, ownerRef: string = LOCAL_OWNER_REF): CharacterRecord | null {
    return this.remove(id, ownerRef, false);
  }

  /** Permanently removes a world-entered character after shard retirement. */
  deleteRetired(id: string, ownerRef: string = LOCAL_OWNER_REF): CharacterRecord | null {
    return this.remove(id, ownerRef, true);
  }

  private remove(id: string, ownerRef: string, retired: boolean): CharacterRecord | null {
    const data = this.load();
    const index = data.characters.findIndex((character) => character.id === id && character.ownerRef === ownerRef);
    if (index < 0) return null;
    const record = data.characters[index];
    if (!record || (retired ? record.worldEntryClaimed !== true : record.worldEntryClaimed !== false)) return null;
    const [removed] = data.characters.splice(index, 1);
    const socialDefinition = characterRecordKindDefinition(successorSocialRecordKind) as CharacterRecordKindDefinition<CharacterSocialContact>;
    for (const character of data.characters) {
      const social = ensureRecordKindPayload(character, socialDefinition);
      const nextItems = social.items.filter((contact) => contact.id !== id);
      if (nextItems.length !== social.items.length) {
        character.recordKinds[successorSocialRecordKind] = {
          version: socialDefinition.version,
          items: nextItems,
        };
      }
    }
    this.save(data);
    return removed ? cloneRecord(removed) : null;
  }

  markSeen(id: string, atMs = this.clock()): CharacterRecord | null {
    const data = this.load();
    const record = data.characters.find((character) => character.id === id);
    if (!record) return null;
    record.lastSeenAt = new Date(atMs).toISOString();
    this.save(data);
    return cloneRecord(record);
  }

  /**
   * Commits the character's one-way world-entry marker synchronously after the
   * shard has durably checkpointed the first Rust actor and inventory state.
   */
  claimWorldEntry(
    id: string,
    ownerRef: string = LOCAL_OWNER_REF,
  ): { record: CharacterRecord; returning: boolean } | null {
    const data = this.load();
    const record = data.characters.find((character) => character.id === id && character.ownerRef === ownerRef);
    if (!record) return null;
    const returning = record.worldEntryClaimed;
    record.worldEntryClaimed = true;
    this.save(data);
    return { record: cloneRecord(record), returning };
  }

  saveActorSnapshot(id: string, snapshot: GameActorSnapshot, options: CharacterStoreSnapshotOptions = {}): CharacterRecord | null {
    const data = this.load();
    const record = data.characters.find((character) => character.id === id);
    if (!record) return null;
    const atMs = options.atMs ?? this.clock();
    const at = new Date(atMs).toISOString();
    record.position = actorPositionSnapshot(snapshot);
    if (snapshot.worn) record.worn = normalizeCharacterWornLenient(snapshot.worn);
    if (snapshot.wornColors) record.wornColors = normalizeCharacterWornColors(snapshot.wornColors, record.worn);
    record.vitals = actorVitalsSnapshot(snapshot);
    record.professions = cloneUnknown(snapshot.professions ?? null);
    record.activeTitleId = snapshot.activeTitle?.id ?? null;
    record.careerGoalId = snapshot.careerGoalId ?? null;
    record.lastSeenAt = at;
    if (options.logout) record.lastLogoutAt = at;
    const playMs = Math.trunc(options.playMs ?? 0);
    if (Number.isFinite(playMs) && playMs > 0) record.totalPlayMs += playMs;
    this.save(data);
    return cloneRecord(record);
  }

  private load(): CharacterStoreData {
    if (this.data) return this.data;
    if (!fs.existsSync(this.filePath)) {
      this.data = { schema: characterStoreSchema, characters: [] };
      return this.data;
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
    const data = normalizeStoreData(parsed);
    this.data = data;
    return data;
  }

  private save(data: CharacterStoreData): void {
    const dir = path.dirname(this.filePath);
    let tmp: string | null = null;
    let fd: number | undefined;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const payload = `${JSON.stringify(data, null, 2)}\n`;
      tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, this.filePath);
      fsyncDirectory(dir);
      this.data = data;
    } catch (error) {
      // Every mutator edits the cached store before calling save. A failed
      // write must therefore discard that cache so the next read reloads the
      // actual durable file instead of exposing a mutation that never landed.
      this.data = null;
      throw error;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Preserve the persistence error; this is only best-effort cleanup.
        }
      }
      if (tmp !== null) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // Preserve the persistence error; stale temp files are never loaded.
        }
      }
    }
  }

  private nextCharacterId(data: CharacterStoreData): string {
    const existing = new Set(data.characters.map((record) => record.id));
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = `char_${randomUUID().replace(/-/gu, "").slice(0, 16)}`;
      if (!existing.has(id)) return id;
    }
    throw new Error("failed to allocate character id");
  }

  private cloneRecords(records: CharacterRecord[]): CharacterRecord[] {
    return records.map(cloneRecord);
  }
}

export function normalizeCharacterName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFKC").trim();
  return characterNamePattern.test(name) ? name : null;
}

export function normalizeInitialProfessionId(value: unknown): InitialProfessionId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return initialProfessionIdSet.has(normalized) ? normalized as InitialProfessionId : null;
}

/** Minimal seed shape consumed by characterAuthoritySeed and then Rust. */
export function initialProfessionState(professionId: InitialProfessionId): Record<string, unknown> {
  return {
    learned: [],
    trackXp: {},
    skillBoxes: [`${professionId}-novice`],
    activeTitleId: null,
    credits: 5_000,
    skillPointCap: 250,
  };
}

export function normalizeCharacterId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return characterIdPattern.test(id) ? id : null;
}

/**
 * Normalize a persisted owner reference. Accepts a ComPress-profile id or the
 * reserved dev ref; absent values use the reserved local-development owner.
 */
export function normalizeOwnerRef(value: unknown): string {
  if (typeof value !== "string") return LOCAL_OWNER_REF;
  const ref = value.trim();
  return ownerRefPattern.test(ref) ? ref : LOCAL_OWNER_REF;
}

export function isValidStandaloneOwnerRef(value: unknown): value is string {
  return typeof value === "string" && value !== LOCAL_OWNER_REF && ownerRefPattern.test(value);
}

const faceEyeColorSet = new Set(FACE_EYE_COLORS);
const faceBrowColorSet = new Set(FACE_BROW_COLORS);
const faceLipColorSet = new Set(FACE_LIP_COLORS);

/**
 * Face validation: explicit null is a blank face; a present object must be
 * fully valid or the whole appearance is rejected
 * (`undefined` sentinel, mirroring the hair rule above). Style ids and the
 * three feature colors are checked against the generated face registry so
 * the creator and the store cannot drift.
 */
function normalizeCharacterFaceAppearance(value: unknown): CharacterFaceConfig | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const { eyes, brows, nose, mouth } = input;
  if (!isFaceStyleId(eyes) || !isFaceStyleId(brows) || !isFaceStyleId(nose) || !isFaceStyleId(mouth)) return undefined;
  const eyeColor = typeof input.eyeColor === "string" ? input.eyeColor.trim().toLowerCase() : "";
  const browColor = typeof input.browColor === "string" ? input.browColor.trim().toLowerCase() : "";
  const lipColor = typeof input.lipColor === "string" ? input.lipColor.trim().toLowerCase() : "";
  if (!faceEyeColorSet.has(eyeColor) || !faceBrowColorSet.has(browColor) || !faceLipColorSet.has(lipColor)) return undefined;
  return { eyes, brows, nose, mouth, eyeColor, browColor, lipColor };
}

export function normalizeCharacterAppearance(value: unknown): CharacterAppearance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!["skinTone", "hair", "hairMat", "face"].every((key) => Object.prototype.hasOwnProperty.call(input, key))) return null;
  const rawSkinTone = typeof input.skinTone === "string" ? input.skinTone.trim().toLowerCase() : "";
  const skinTone = skinTonePattern.test(rawSkinTone) ? rawSkinTone : null;
  const rawHair = input.hair;
  const hair = rawHair === null
    ? null
    : typeof rawHair === "string" && hairIdentifierPattern.test(rawHair)
      ? rawHair
      : undefined;
  const hairMat = typeof input.hairMat === "string" ? input.hairMat.trim() : "";
  const face = normalizeCharacterFaceAppearance(input.face);
  if (!skinTone || hair === undefined || face === undefined || !hairIdentifierPattern.test(hairMat)) return null;
  return { skinTone, hair, hairMat, face };
}

export function defaultCharacterAppearance(): CharacterAppearance {
  return { ...defaultAppearance };
}

export function characterAppearanceToActorAppearance(appearance: CharacterAppearance): GameActorAppearanceSnapshot {
  return {
    skin: appearance.skinTone,
    hair: appearance.hair,
    hair_mat: appearance.hairMat,
    face: appearance.face
      ? {
        eyes: appearance.face.eyes,
        brows: appearance.face.brows,
        nose: appearance.face.nose,
        mouth: appearance.face.mouth,
        eye_color: appearance.face.eyeColor,
        brow_color: appearance.face.browColor,
        lip_color: appearance.face.lipColor,
      }
      : null,
  };
}

export function actorAppearanceToCharacterAppearance(appearance: GameActorAppearanceSnapshot | undefined): CharacterAppearance {
  if (!appearance) return defaultCharacterAppearance();
  return normalizeCharacterAppearance({
    skinTone: appearance.skin,
    hair: appearance.hair,
    hairMat: appearance.hair_mat,
    face: appearance.face
      ? {
        eyes: appearance.face.eyes,
        brows: appearance.face.brows,
        nose: appearance.face.nose,
        mouth: appearance.face.mouth,
        eyeColor: appearance.face.eye_color,
        browColor: appearance.face.brow_color,
        lipColor: appearance.face.lip_color,
      }
      : null,
  }) ?? defaultCharacterAppearance();
}

const wornColorPattern = /^#[0-9a-f]{6}$/u;

/**
 * Strict worn-set validation (creation path): array of `{ item, colors[] }`
 * against the generated wardrobe registry. Rules: known piece, at most one
 * piece per wardrobe slot, colors ≤ the piece's zone count, every color a
 * legal zone choice (family swatch or authored default). Returns null on any
 * violation — creation must not half-accept an outfit.
 */
export function normalizeCharacterWorn(value: unknown): CharacterWornEntry[] | null {
  if (!Array.isArray(value)) return null;
  const seenSlots = new Set<WardrobeSlot>();
  const worn: CharacterWornEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    const item = typeof entry.item === "string" ? entry.item.trim() : "";
    const piece = item ? wardrobePieceById(item) : null;
    if (!piece) return null;
    if (seenSlots.has(piece.slot)) return null;
    seenSlots.add(piece.slot);
    const rawColors = entry.colors === undefined ? [] : entry.colors;
    if (!Array.isArray(rawColors) || rawColors.length > piece.zones.length) return null;
    const colors: string[] = [];
    for (let index = 0; index < rawColors.length; index += 1) {
      const zone = piece.zones[index]!;
      const color = typeof rawColors[index] === "string" ? (rawColors[index] as string).trim().toLowerCase() : "";
      if (!wornColorPattern.test(color) || !wardrobeZoneColorAllowed(zone, color)) return null;
      colors.push(color);
    }
    worn.push({ item, colors });
  }
  return worn;
}

/** Lenient load-path variant: silently drops invalid entries. */
function normalizeCharacterWornLenient(value: unknown): CharacterWornEntry[] {
  if (!Array.isArray(value)) return defaultStarterWorn();
  const worn: CharacterWornEntry[] = [];
  for (const raw of value) {
    if (
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      ((raw as Record<string, unknown>).item === "under_bodysuit" ||
        (raw as Record<string, unknown>).item === "boots_canvas_ankle")
    ) {
      const item = (raw as Record<string, unknown>).item as string;
      const colors = item === "under_bodysuit" ? ["#89cff0"] : ["#303030", "#808080"];
      if (!worn.some((entry) => entry.item === item)) worn.push({ item, colors });
      continue;
    }
    const entry = normalizeCharacterWorn([raw]);
    if (entry && entry[0] && !worn.some((existing) => existing.item === entry[0]!.item)) {
      worn.push(entry[0]);
    }
  }
  return worn.length > 0 ? worn : defaultStarterWorn();
}
function normalizeCharacterWornColors(value: unknown, worn: readonly CharacterWornEntry[]): Record<string, string[]> {
  const normalized = wornColorsFromWorn(
    worn.filter((entry) => entry.item === "under_bodysuit" || entry.item === "boots_canvas_ankle"),
  );
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [item, colors] of Object.entries(value as Record<string, unknown>)) {
      const entry = normalizeCharacterWorn([{ item, colors }]);
      if (entry?.[0]) normalized[item] = [...entry[0].colors];
    }
  }
  for (const entry of worn) {
    if (!(entry.item in normalized)) normalized[entry.item] = [...entry.colors];
  }
  return normalized;
}

function normalizeStoredCharacterWornColors(
  value: unknown,
  worn: readonly CharacterWornEntry[],
): Record<string, string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized: Record<string, string[]> = {};
  for (const [item, colors] of Object.entries(value as Record<string, unknown>)) {
    const entry = normalizeCharacterWorn([{ item, colors }])?.[0];
    if (!entry || entry.item !== item) return null;
    normalized[item] = [...entry.colors];
  }
  return worn.every((entry) => Object.prototype.hasOwnProperty.call(normalized, entry.item))
    ? normalized
    : null;
}

export function wornColorsFromWorn(worn: readonly CharacterWornEntry[]): Record<string, string[]> {
  return Object.fromEntries(worn.map((entry) => [entry.item, [...entry.colors]]));
}


export function characterWornToActorWorn(worn: readonly CharacterWornEntry[]): GameActorWornPiece[] {
  return worn.map((entry) => ({ item: entry.item, colors: [...entry.colors] }));
}

function actorPositionSnapshot(snapshot: GameActorSnapshot): CharacterPositionSnapshot {
  return {
    areaId: snapshot.areaId,
    x: snapshot.x,
    y: snapshot.y,
    facing: snapshot.direction,
  };
}

function actorVitalsSnapshot(snapshot: GameActorSnapshot): CharacterVitalsSnapshot {
  return {
    health: snapshot.vitals.health,
    action: snapshot.vitals.action,
    spirit: snapshot.vitals.spirit,
  };
}

function normalizeStoreData(value: unknown): CharacterStoreData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid character-store root; expected an object");
  }
  const raw = value as { schema?: unknown; characters?: unknown };
  if (raw.schema !== characterStoreSchema) {
    throw new Error(`unsupported character-store schema ${JSON.stringify(raw.schema)}`);
  }
  if (!Array.isArray(raw.characters)) {
    throw new Error("invalid character-store characters; expected an array");
  }
  const characters = raw.characters.map((candidate, index) => {
    const record = normalizeRecord(candidate);
    if (!record) throw new Error(`invalid character-store record at characters[${index}]`);
    return record;
  });
  const seenIds = new Set<string>();
  for (const [index, record] of characters.entries()) {
    if (seenIds.has(record.id)) {
      throw new Error(`duplicate character-store id ${JSON.stringify(record.id)} at characters[${index}]`);
    }
    seenIds.add(record.id);
  }
  return { schema: characterStoreSchema, characters };
}

function fsyncDirectory(dirPath: string): void {
  const fd = fs.openSync(dirPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeRecord(value: unknown): CharacterRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const requiredFields = [
    "id",
    "ownerRef",
    "name",
    "appearance",
    "worn",
    "wornColors",
    "position",
    "vitals",
    "initialProfessionId",
    "professions",
    "activeTitleId",
    "careerGoalId",
    "recordKinds",
    "worldEntryClaimed",
    "createdAt",
    "lastSeenAt",
    "lastLogoutAt",
    "totalPlayMs",
  ];
  if (!requiredFields.every((key) => Object.prototype.hasOwnProperty.call(raw, key))) return null;
  const id = typeof raw.id === "string" && normalizeCharacterId(raw.id) === raw.id ? raw.id : null;
  const ownerRef = normalizeStoredOwnerRef(raw.ownerRef);
  const worldEntryClaimed = typeof raw.worldEntryClaimed === "boolean" ? raw.worldEntryClaimed : null;
  const name = normalizeCharacterName(raw.name);
  const appearance = normalizeCharacterAppearance(raw.appearance);
  const worn = normalizeCharacterWorn(raw.worn);
  const wornColors = worn ? normalizeStoredCharacterWornColors(raw.wornColors, worn) : null;
  const position = raw.position === null ? null : normalizePosition(raw.position);
  const vitals = raw.vitals === null ? null : normalizeVitals(raw.vitals);
  const initialProfessionId = raw.initialProfessionId === null
    ? null
    : normalizeInitialProfessionId(raw.initialProfessionId);
  const activeTitleId = raw.activeTitleId === null ? null : normalizeStoredOptionalId(raw.activeTitleId);
  const careerGoalId = raw.careerGoalId === null ? null : normalizeStoredOptionalId(raw.careerGoalId);
  const recordKinds = normalizeRecordKinds(raw.recordKinds);
  const createdAt = normalizeIso(raw.createdAt);
  const lastSeenAt = normalizeIso(raw.lastSeenAt);
  const lastLogoutAt = raw.lastLogoutAt === null ? null : normalizeIso(raw.lastLogoutAt);
  const totalPlayMs = typeof raw.totalPlayMs === "number"
    && Number.isSafeInteger(raw.totalPlayMs)
    && raw.totalPlayMs >= 0
    ? raw.totalPlayMs
    : null;
  if (
    !id
    || !ownerRef
    || worldEntryClaimed === null
    || !name
    || !appearance
    || !worn
    || !wornColors
    || (raw.position !== null && !position)
    || (raw.vitals !== null && !vitals)
    || (raw.initialProfessionId !== null && !initialProfessionId)
    || (raw.activeTitleId !== null && !activeTitleId)
    || (raw.careerGoalId !== null && !careerGoalId)
    || !recordKinds
    || !createdAt
    || !lastSeenAt
    || (raw.lastLogoutAt !== null && !lastLogoutAt)
    || totalPlayMs === null
  ) return null;
  return {
    id,
    ownerRef,
    name,
    appearance,
    worn,
    wornColors,
    position,
    vitals,
    initialProfessionId,
    professions: cloneUnknown(raw.professions ?? null),
    activeTitleId,
    careerGoalId,
    recordKinds,
    worldEntryClaimed,
    createdAt,
    lastSeenAt,
    lastLogoutAt,
    totalPlayMs,
  };
}

function normalizeStoredOwnerRef(value: unknown): string | null {
  return typeof value === "string" && ownerRefPattern.test(value) ? value : null;
}

function normalizeStoredOptionalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizePosition(value: unknown): CharacterPositionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const areaId = typeof raw.areaId === "string" && raw.areaId ? raw.areaId : null;
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  const facing = raw.facing === "front" || raw.facing === "right" || raw.facing === "back" || raw.facing === "left" ? raw.facing : null;
  return areaId && x !== null && y !== null && facing ? { areaId, x, y, facing } : null;
}

function normalizeVitals(value: unknown): CharacterVitalsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const health = finiteNumber(raw.health);
  const action = finiteNumber(raw.action);
  const spirit = finiteNumber(raw.spirit);
  return health !== null && action !== null && spirit !== null ? { health, action, spirit } : null;
}

function normalizeRecordKinds(value: unknown): CharacterRecordKindPayloads | null {
  const normalized = emptyRecordKinds();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  for (const definition of characterRecordKindDefinitions) {
    if (raw[definition.kind] === undefined) continue;
    const payload = normalizeRecordKindPayload(definition, raw[definition.kind]);
    if (!payload) return null;
    normalized[definition.kind] = payload;
  }
  return normalized;
}

function normalizeRecordKindPayload<TItem extends CharacterRecordKindItem>(
  definition: CharacterRecordKindDefinition<TItem>,
  value: unknown,
): CharacterRecordKindPayload<TItem> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== definition.version || !Array.isArray(raw.items) || raw.items.length > definition.caps.maxItems) return null;
  const items: TItem[] = [];
  for (const item of raw.items) {
    const normalized = definition.normalizeItem(item, { mode: "load", nowIso: new Date(0).toISOString(), existing: null });
    if (!normalized || jsonByteLength(normalized) > definition.caps.maxItemBytes) return null;
    items.push(normalized);
  }
  const payload: CharacterRecordKindPayload<TItem> = { version: definition.version, items };
  return jsonByteLength(payload) <= definition.caps.maxPayloadBytes ? payload : null;
}

function ensureRecordKindPayload<TItem extends CharacterRecordKindItem>(
  record: CharacterRecord,
  definition: CharacterRecordKindDefinition<TItem>,
): CharacterRecordKindPayload<TItem> {
  record.recordKinds = record.recordKinds ?? emptyRecordKinds();
  const existing = record.recordKinds[definition.kind];
  if (!existing || existing.version !== definition.version || !Array.isArray(existing.items)) {
    const payload = emptyRecordKindPayload(definition);
    record.recordKinds[definition.kind] = payload as CharacterRecordKindPayload;
    return payload;
  }
  return existing as CharacterRecordKindPayload<TItem>;
}

function emptyRecordKinds(): CharacterRecordKindPayloads {
  const payloads: CharacterRecordKindPayloads = {};
  for (const definition of characterRecordKindDefinitions) {
    payloads[definition.kind] = emptyRecordKindPayload(definition);
  }
  return payloads;
}

function emptyRecordKindPayload<TItem extends CharacterRecordKindItem>(
  definition: CharacterRecordKindDefinition<TItem>,
): CharacterRecordKindPayload<TItem> {
  return { version: definition.version, items: [] };
}

function normalizeSuccessorMacroRecord(
  value: unknown,
  context: CharacterRecordKindNormalizeContext<SuccessorMacroRecord>,
): SuccessorMacroRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = normalizeRecordItemId(raw.id);
  const name = normalizeMacroName(raw.name);
  const iconId = normalizeMacroIconId(raw.iconId);
  const body = normalizeMacroBody(raw.body);
  if (!id || !name || !iconId || body === null) return null;
  const createdAt = context.mode === "save"
    ? context.existing?.createdAt ?? context.nowIso
    : normalizeIso(raw.createdAt);
  const updatedAt = context.mode === "save" ? context.nowIso : normalizeIso(raw.updatedAt);
  if (!createdAt || !updatedAt) return null;
  return { id, name, iconId, body, createdAt, updatedAt };
}

function normalizeCharacterSocialContact(
  value: unknown,
  _context: CharacterRecordKindNormalizeContext<CharacterSocialContact>,
): CharacterSocialContact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = normalizeCharacterId(raw.id);
  const relation = raw.relation === "friend" || raw.relation === "ignored" ? raw.relation : null;
  return id && relation ? { id, relation } : null;
}

function normalizeRecordItemId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return recordItemIdPattern.test(id) ? id : null;
}

function normalizeMacroName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > successorMacroRecordNameMaxCharacters || hasControlCharacters(name)) return null;
  return name;
}

function normalizeMacroIconId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const iconId = value.trim();
  return macroIconIdPattern.test(iconId) ? iconId : null;
}

function normalizeMacroBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Buffer.byteLength(value, "utf8") <= successorMacroRecordBodyMaxBytes ? value : null;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Strong ETag for a record-kind payload. Hash covers version + items in durable
 * order with stable field order so byte-identical meaning yields one token.
 */
export function canonicalRecordKindPayloadEtag(payload: CharacterRecordKindPayload): string {
  const body = canonicalRecordKindPayloadBytes(payload);
  return createHash("sha256").update(body).digest("hex");
}

export function normalizeExpectedEtag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const unquoted = trimmed.startsWith("W/")
    ? trimmed.slice(2).trim()
    : trimmed;
  const bare = unquoted.length >= 2 && unquoted.startsWith('"') && unquoted.endsWith('"')
    ? unquoted.slice(1, -1)
    : unquoted;
  return /^[A-Za-z0-9._:/-]{8,128}$/u.test(bare) ? bare : null;
}

function canonicalRecordKindPayloadBytes(payload: CharacterRecordKindPayload): string {
  const items = payload.items.map((item) => canonicalRecordKindItem(item));
  return JSON.stringify({ version: payload.version, items });
}

function canonicalRecordKindItem(item: CharacterRecordKindItem): Record<string, unknown> {
  const row = item as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = { id: row.id };
  for (const key of Object.keys(row).sort()) {
    if (key === "id") continue;
    ordered[key] = row[key];
  }
  return ordered;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeIso(value: unknown): string | null {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return null;
}

function cloneRecord(record: CharacterRecord): CharacterRecord {
  return cloneUnknown(record) as CharacterRecord;
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
