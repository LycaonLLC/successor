import { getLaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import { characterStorageKeyFromLaunchIdentity, launchActorIdFromSearch } from "../boot/launch";

export type CachedCharacterBody = "male" | "female";

export interface CachedWornPiece {
  item: string;
  colors: string[];
}

export interface CachedFaceConfig {
  eyes: string;
  brows: string;
  nose: string;
  mouth: string;
  eyeColor: string;
  browColor: string;
  lipColor: string;
}

export interface CachedCharacterAppearance {
  version: 1;
  body: CachedCharacterBody;
  skinTone: string;
  hair: string | null;
  hairMat: string;
  equipmentIds: string[];
  /** Creator worn set with zone colors (palette application on cached dolls). */
  worn: CachedWornPiece[];
  /** Face-kit selection (record/camel shape); null = blank legacy face. */
  face: CachedFaceConfig | null;
  appearanceKey: string;
  updatedAtMs: number;
}

export interface CharacterAppearanceCacheInput {
  body?: CachedCharacterBody | null | undefined;
  skinTone: string;
  hair: string | null;
  hairMat: string;
  equipmentIds: readonly string[];
  worn?: readonly { item: string; colors: readonly string[] }[];
  face?: CachedFaceConfig | null;
}

const storageKeyPrefix = "successor3d.appearance.";
const skinTonePattern = /^#[0-9a-f]{6}$/iu;
const hairMaterialPattern = /^hair_[a-z0-9_]{1,64}$/u;
const equipmentIdPattern = /^[a-z0-9][a-z0-9_-]{0,95}$/u;
const fallbackSkinTone = "#cc9978";
// Canonical default hair color (wardrobe.gen HAIR_COLORS[0] / store defaultHairMat) —
// a real material; hair_black is retired and resolves to none.
const fallbackHairMaterial = "hair_raven";

export function characterAppearanceCacheStorageKey(characterKey: string): string {
  return `${storageKeyPrefix}${normalizeCharacterKey(characterKey) ?? "observer"}`;
}

export function currentCharacterAppearanceKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const launchIdentity = getLaunchIdentity();
    const launchActorId = launchActorIdFromSearch(launchIdentity, window.location.search);
    return normalizeCharacterKey(characterStorageKeyFromLaunchIdentity(launchIdentity, launchActorId));
  } catch {
    return null;
  }
}

export function readCachedCharacterAppearance(characterKey: string | null | undefined): CachedCharacterAppearance | null {
  const normalizedKey = normalizeCharacterKey(characterKey);
  if (!normalizedKey) return null;
  const storage = localStorageOrNull();
  if (!storage) return null;
  const storageKey = `${storageKeyPrefix}${normalizedKey}`;
  const raw = storage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const cached = parseCachedAppearance(parsed);
    if (cached) return cached;
  } catch {
    // fall through to key removal
  }
  storage.removeItem(storageKey);
  return null;
}

export function writeCurrentCharacterAppearanceCache(input: CharacterAppearanceCacheInput): boolean {
  const characterKey = currentCharacterAppearanceKey();
  return characterKey ? writeCachedCharacterAppearance(characterKey, input) : false;
}

export function writeCachedCharacterAppearance(
  characterKey: string | null | undefined,
  input: CharacterAppearanceCacheInput,
): boolean {
  const normalizedKey = normalizeCharacterKey(characterKey);
  if (!normalizedKey) return false;
  const storage = localStorageOrNull();
  if (!storage) return false;

  const next = normalizeCacheInput(input);
  const previous = readCachedCharacterAppearance(normalizedKey);
  if (previous?.appearanceKey === next.appearanceKey) return false;

  try {
    storage.setItem(`${storageKeyPrefix}${normalizedKey}`, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

function normalizeCacheInput(input: CharacterAppearanceCacheInput): CachedCharacterAppearance {
  const body = input.body === "female" ? "female" : "male";
  const skinTone = normalizeSkinTone(input.skinTone);
  const hair = normalizeEquipmentId(input.hair);
  const hairMat = normalizeHairMaterial(input.hairMat);
  const equipmentIds = normalizeEquipmentIds(input.equipmentIds);
  const worn = normalizeWorn(input.worn ?? []);
  const face = normalizeFace(input.face ?? null);
  const appearanceKey = appearanceSignature({ body, skinTone, hair, hairMat, equipmentIds, worn, face });
  return {
    version: 1,
    body,
    skinTone,
    hair,
    hairMat,
    equipmentIds,
    worn,
    face,
    appearanceKey,
    updatedAtMs: Date.now(),
  };
}

function parseCachedAppearance(value: unknown): CachedCharacterAppearance | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<CachedCharacterAppearance>;
  if (record.version !== 1) return null;
  const body = record.body === "female" ? "female" : record.body === "male" ? "male" : null;
  if (!body) return null;
  if (typeof record.skinTone !== "string" || !skinTonePattern.test(record.skinTone)) return null;
  if (record.hair !== null && typeof record.hair !== "string") return null;
  const hair = normalizeEquipmentId(record.hair);
  if (record.hair && !hair) return null;
  if (typeof record.hairMat !== "string" || !hairMaterialPattern.test(record.hairMat)) return null;
  if (!Array.isArray(record.equipmentIds)) return null;
  const equipmentIds = normalizeEquipmentIds(record.equipmentIds);
  const worn = normalizeWorn(Array.isArray(record.worn) ? record.worn : []);
  const face = normalizeFace(record.face ?? null);
  if (typeof record.appearanceKey !== "string" || record.appearanceKey.length === 0) return null;
  const expectedKey = appearanceSignature({
    body,
    skinTone: record.skinTone,
    hair,
    hairMat: record.hairMat,
    equipmentIds,
    worn,
    face,
  });
  if (record.appearanceKey !== expectedKey) return null;
  return {
    version: 1,
    body,
    skinTone: record.skinTone,
    hair,
    hairMat: record.hairMat,
    equipmentIds,
    worn,
    face,
    appearanceKey: record.appearanceKey,
    updatedAtMs: typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs) ? record.updatedAtMs : 0,
  };
}

const wornColorPattern = /^#[0-9a-f]{6}$/iu;

function normalizeWorn(entries: readonly unknown[]): CachedWornPiece[] {
  const out: CachedWornPiece[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = normalizeEquipmentId((raw as { item?: unknown }).item);
    if (!item || out.some((existing) => existing.item === item)) continue;
    const rawColors = (raw as { colors?: unknown }).colors;
    const colors = Array.isArray(rawColors)
      ? rawColors
        .filter((color): color is string => typeof color === "string" && wornColorPattern.test(color.trim()))
        .map((color) => color.trim().toLowerCase())
        .slice(0, 3)
      : [];
    out.push({ item, colors });
  }
  return out;
}

const faceStyleTokenPattern = /^[a-z][a-z0-9_]{0,32}$/u;

function normalizeFace(value: unknown): CachedFaceConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<CachedFaceConfig>;
  const styles = [raw.eyes, raw.brows, raw.nose, raw.mouth];
  if (styles.some((style) => typeof style !== "string" || !faceStyleTokenPattern.test(style))) return null;
  const colors = [raw.eyeColor, raw.browColor, raw.lipColor]
    .map((color) => (typeof color === "string" && wornColorPattern.test(color.trim()) ? color.trim().toLowerCase() : null));
  if (colors.some((color) => color === null)) return null;
  return {
    eyes: raw.eyes as string,
    brows: raw.brows as string,
    nose: raw.nose as string,
    mouth: raw.mouth as string,
    eyeColor: colors[0]!,
    browColor: colors[1]!,
    lipColor: colors[2]!,
  };
}

function appearanceSignature(input: Omit<CachedCharacterAppearance, "version" | "appearanceKey" | "updatedAtMs">): string {
  return [
    input.body,
    input.skinTone,
    input.hair ?? "",
    input.hairMat,
    input.equipmentIds.join(","),
    input.worn.map((piece) => `${piece.item}:${piece.colors.join("+")}`).join(","),
    input.face
      ? `${input.face.eyes},${input.face.brows},${input.face.nose},${input.face.mouth},${input.face.eyeColor},${input.face.browColor},${input.face.lipColor}`
      : "",
  ].join("|");
}

function normalizeCharacterKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return normalized || "observer";
}

function normalizeSkinTone(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return skinTonePattern.test(normalized) ? normalized : fallbackSkinTone;
}

function normalizeHairMaterial(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  return hairMaterialPattern.test(normalized) ? normalized : fallbackHairMaterial;
}

function normalizeEquipmentIds(ids: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = normalizeEquipmentId(raw);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function normalizeEquipmentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return equipmentIdPattern.test(normalized) ? normalized : null;
}

function localStorageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
