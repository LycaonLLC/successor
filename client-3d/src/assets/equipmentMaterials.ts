// equipmentMaterials.ts — shared apparel material resolution.
//
// Blender material SLOTS are now the authoring surface. For each exported
// source material/slot, runtime resolution is:
//   1. hair item override preset supplied by appearance (`hair_mat`);
//   2. source material NAME matching a material preset (slot-authored preset);
//   3. explicit manifest `mat` fallback for the piece;
//   4. inline material from the source material's baked base color; then
//   5. legacy piece-id fallback (the pre-slot behavior).
//
// Baked-color fallback is intentionally guarded. Old single-slot exports often
// carry non-authorial names (`Material`, `Material.001`, piece/body names, and
// legacy PawnForge placeholders such as `PF_Hard`, `PF_Soft`, `HairTint`).
// Those names do NOT opt into baked color; they fall through to manifest/legacy
// presets so existing harness, tank, and hair pieces stay visually unchanged.
// Authoring contract: name a slot after a preset, or give a custom meaningful
// slot name and leave its color baked into the Blender material.

import { installPawnRim } from "../render/pawnRim";
import {
  BufferAttribute,
  Color,
  Material,
  Mesh,
  MeshMatcapMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  type Object3D,
} from "three";
import type { PawnEquipmentLayer } from "./pawnRigTypes";
import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";

const EQUIPMENT_BASE_URL = "/assets/pawn-pack/equipment";
const ARMOR_MATERIALS_URL = `${EQUIPMENT_BASE_URL}/Materials/materials.json`;
const CLOTHING_MATERIALS_URL = `${EQUIPMENT_BASE_URL}/ClothingMaterials/clothing_materials.json`;
const EQUIPMENT_MANIFEST_URL = `${EQUIPMENT_BASE_URL}/manifest.json`;
const ARMOR_DEFAULT_MATERIAL = "smooth_steel";
const UNDER_DEFAULT_MATERIAL = "cotton_jersey";
const FALLBACK_COLOR = "#767880";
const GLTF_DEFAULT_MATERIAL_NAME_PATTERN = /^Material(?:\.\d{3})?$/u;
const LEGACY_NON_AUTHORIAL_SOURCE_NAMES = new Set([
  "pfhard",
  "pfsoft",
  "hairtint",
  "armorprimary",
  "armorsecondary",
  "armorglow",
  "armortrim",
  "hair",
  "body",
  "skin",
  "default",
]);

type EquipmentTextureMapName = "baseColor" | "normal" | "roughness" | "metalness";

type EquipmentTextureMaps = Partial<Record<EquipmentTextureMapName, string>>;

export interface EquipmentMaterialPreset {
  id: string;
  name?: string;
  color?: string;
  maps?: EquipmentTextureMaps;
  metalness?: number;
  roughness?: number;
  normalScale?: number;
  envMapIntensity?: number;
  repeat?: readonly number[];
  shading?: string;
}

export interface EquipmentMaterialConfig {
  schemaVersion: number;
  purpose?: string;
  default?: string;
  materials: readonly EquipmentMaterialPreset[];
}

export interface EquipmentPieceMaterialAssignment {
  pieceId: string;
  layer: PawnEquipmentLayer;
  materialName: string;
  explicit?: boolean;
}

export interface EquipmentMaterialSets {
  armor: EquipmentMaterialConfig;
  clothing: EquipmentMaterialConfig;
  armorById: ReadonlyMap<string, EquipmentMaterialPreset>;
  clothingById: ReadonlyMap<string, EquipmentMaterialPreset>;
  pieceMaterials: ReadonlyMap<string, EquipmentPieceMaterialAssignment>;
  assignments: readonly EquipmentPieceMaterialAssignment[];
}

interface EquipmentManifestItem {
  id: string;
  layer: PawnEquipmentLayer;
  mat?: string;
}

interface EquipmentManifestConfig {
  items: readonly EquipmentManifestItem[];
}

export interface EquipmentSlotMaterialPaletteZone {
  key: string;
  family: string;
  slots: readonly string[];
  default: string;
}

export interface EquipmentSlotMaterialItem {
  id: string;
  name?: string;
  layer: PawnEquipmentLayer;
  slot?: string;
  glb?: string;
  /** Dye zones (wardrobe pieces): atlas slots -> player/zone-default colors. */
  palette?: { zones: readonly EquipmentSlotMaterialPaletteZone[] };
}

export interface EquipmentSourceMaterialIdentity {
  name: string | null;
  baseColorHex: string | null;
}

export type EquipmentSlotMaterialSource =
  | Material
  | Material[]
  | EquipmentSourceMaterialIdentity
  | EquipmentSourceMaterialIdentity[]
  | null;

export type EquipmentMaterialFamily =
  | { kind: "world"; matcap?: Texture | null }
  | { kind: "lit" };

const staticPieceMaterials: Readonly<Record<string, EquipmentPieceMaterialAssignment>> = {
  armor_harness: { pieceId: "armor_harness", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  armor_nape_reinforcement: { pieceId: "armor_nape_reinforcement", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  armor_reinforcement: { pieceId: "armor_reinforcement", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  armor_gorget: { pieceId: "armor_gorget", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  armor_bicep_l: { pieceId: "armor_bicep_l", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  armor_bicep_r: { pieceId: "armor_bicep_r", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  helmet_a: { pieceId: "helmet_a", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  helmet_b: { pieceId: "helmet_b", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  helmet_c: { pieceId: "helmet_c", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  helmet_d: { pieceId: "helmet_d", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  helmet_v1port: { pieceId: "helmet_v1port", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  helmet_s1: { pieceId: "helmet_s1", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  helmet_s2: { pieceId: "helmet_s2", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  helmet_s3: { pieceId: "helmet_s3", layer: "Armor", materialName: ARMOR_DEFAULT_MATERIAL },
  hat_warm: { pieceId: "hat_warm", layer: "Under", materialName: "wool_felt" },
  under_tank: { pieceId: "under_tank", layer: "Under", materialName: UNDER_DEFAULT_MATERIAL },
  under_shorts: { pieceId: "under_shorts", layer: "Under", materialName: UNDER_DEFAULT_MATERIAL },
};

const fallbackArmorConfig: EquipmentMaterialConfig = {
  schemaVersion: 1,
  default: ARMOR_DEFAULT_MATERIAL,
  materials: [],
};

const fallbackClothingConfig: EquipmentMaterialConfig = {
  schemaVersion: 1,
  default: UNDER_DEFAULT_MATERIAL,
  materials: [],
};

const textureLoader = new TextureLoader();
const textureCache = new Map<string, Texture>();
const worldMaterialCache = new Map<string, MeshMatcapMaterial>();
const litMaterialCache = new Map<string, MeshStandardMaterial>();
const bakedWorldMaterialCache = new Map<string, MeshMatcapMaterial>();
const bakedLitMaterialCache = new Map<string, MeshStandardMaterial>();
let cachedSets: EquipmentMaterialSets | null = null;
let setsPromise: Promise<EquipmentMaterialSets> | null = null;

export function getEquipmentMaterialSets(): Promise<EquipmentMaterialSets> {
  if (!setsPromise) {
    setsPromise = loadEquipmentMaterialSets().then((sets) => {
      cachedSets = sets;
      refreshCachedMaterials();
      return sets;
    }).catch((error: unknown) => {
      console.warn("equipment material sets failed; using flat fallbacks", error);
      const fallback = buildFallbackSets();
      cachedSets = fallback;
      refreshCachedMaterials();
      return fallback;
    });
  }
  return setsPromise;
}

export function cachedEquipmentMaterialSets(): EquipmentMaterialSets | null {
  return cachedSets;
}

export function stashEquipmentSourceMaterialIdentity(
  object: Object3D,
  source: Material | Material[] | null,
): void {
  if (
    object.userData.successorSourceMaterialName !== undefined
    || object.userData.successorSourceBaseColorHex !== undefined
  ) {
    return;
  }
  if (Array.isArray(source)) {
    const identities = source.map(sourceIdentityFromMaterial);
    object.userData.successorSourceMaterialName = identities.map((identity) => identity.name);
    object.userData.successorSourceBaseColorHex = identities.map((identity) => identity.baseColorHex);
    return;
  }
  const identity = source ? sourceIdentityFromMaterial(source) : { name: null, baseColorHex: null };
  object.userData.successorSourceMaterialName = identity.name;
  object.userData.successorSourceBaseColorHex = identity.baseColorHex;
}

export function equipmentSourceMaterialFromUserData(object: Object3D): EquipmentSlotMaterialSource {
  const names = object.userData.successorSourceMaterialName as unknown;
  const colors = object.userData.successorSourceBaseColorHex as unknown;
  if (Array.isArray(names) || Array.isArray(colors)) {
    const nameList = Array.isArray(names) ? names : [];
    const colorList = Array.isArray(colors) ? colors : [];
    const count = Math.max(nameList.length, colorList.length);
    const identities: EquipmentSourceMaterialIdentity[] = [];
    for (let i = 0; i < count; i += 1) {
      const name = nameList[i];
      const color = colorList[i];
      identities.push({
        name: typeof name === "string" ? name : null,
        baseColorHex: typeof color === "string" ? color : null,
      });
    }
    return identities;
  }
  if (names === undefined && colors === undefined) return null;
  return {
    name: typeof names === "string" ? names : null,
    baseColorHex: typeof colors === "string" ? colors : null,
  };
}

export function resolveEquipmentSlotMaterial(
  source: EquipmentSlotMaterialSource,
  item: EquipmentSlotMaterialItem,
  manifestMat: string | null | undefined,
  family: EquipmentMaterialFamily,
  wornColors?: readonly string[] | null,
): Material | Material[] {
  void getEquipmentMaterialSets();
  if (Array.isArray(source)) {
    return source.map((slotSource) => resolveSingleEquipmentSlotMaterial(slotSource, item, manifestMat, family, wornColors));
  }
  return resolveSingleEquipmentSlotMaterial(source, item, manifestMat, family, wornColors);
}

export function equipmentLayerFor(pieceOrMaterialName: string): PawnEquipmentLayer | null {
  const assignment = assignmentFor(pieceOrMaterialName);
  if (assignment) return assignment.layer;
  const sets = cachedSets;
  if (sets?.clothingById.has(pieceOrMaterialName)) return "Under";
  if (sets?.armorById.has(pieceOrMaterialName)) return "Armor";
  if (pieceOrMaterialName.startsWith("under_") || pieceOrMaterialName.startsWith("hat_")) return "Under";
  if (pieceOrMaterialName.startsWith("armor_") || pieceOrMaterialName.startsWith("helmet_")) return "Armor";
  return null;
}

export function worldMaterialFor(pieceOrMaterialName: string, matcap?: Texture | null): MeshMatcapMaterial {
  void getEquipmentMaterialSets();
  const materialName = materialNameFor(pieceOrMaterialName);
  let material = worldMaterialCache.get(materialName);
  if (!material) {
    material = new MeshMatcapMaterial();
    installPawnRim(material);
    material.name = `successor-world-equipment:${materialName}`;
    worldMaterialCache.set(materialName, material);
  }
  if (matcap && material.matcap !== matcap) {
    material.matcap = matcap;
    material.needsUpdate = true;
  }
  applyWorldPreset(material, materialName);
  return material;
}

export function litMaterialFor(pieceOrMaterialName: string): MeshStandardMaterial {
  void getEquipmentMaterialSets();
  const materialName = materialNameFor(pieceOrMaterialName);
  let material = litMaterialCache.get(materialName);
  if (!material) {
    material = new MeshStandardMaterial();
    material.name = `successor-lit-equipment:${materialName}`;
    litMaterialCache.set(materialName, material);
  }
  applyLitPreset(material, materialName);
  return material;
}

const atlasSlotSuffixPattern = /_(c\d+)(?:\.\d{3})?$/u;
const wornColorHexPattern = /^#[0-9a-f]{6}$/iu;

/** Atlas color-slot suffix ("c3") from a refit material name, or null. */
function atlasSlotSuffix(materialName: string): string | null {
  const match = atlasSlotSuffixPattern.exec(materialName);
  return match ? match[1]! : null;
}

/** Palette-zone resolution: a dyed zone renders the player's worn color (or
 * the authored zone default) as a flat matcap color. Zones address source
 * material slots either by atlas suffix ("c3" from "<piece>_c3") or by the
 * full authored slot name (single-material pieces like the issue bodysuit
 * whose one Blender slot is "PF2_Cloth"). Slots outside every zone are FIXED
 * and fall through to the baked atlas color path below. */
function paletteZoneMaterial(
  identityName: string | null,
  item: EquipmentSlotMaterialItem,
  family: EquipmentMaterialFamily,
  wornColors: readonly string[] | null | undefined,
): Material | null {
  const zones = item.palette?.zones;
  if (!zones || zones.length === 0 || !identityName) return null;
  const suffix = atlasSlotSuffix(identityName);
  const cleanName = identityName.replace(/\.\d{3}$/u, "");
  for (let index = 0; index < zones.length; index += 1) {
    const zone = zones[index]!;
    if (!(suffix !== null && zone.slots.includes(suffix)) && !zone.slots.includes(cleanName)) continue;
    const worn = wornColors?.[index];
    const hex = typeof worn === "string" && wornColorHexPattern.test(worn) ? worn.toLowerCase() : zone.default;
    return bakedMaterialFor(hex, family);
  }
  return null;
}

function resolveSingleEquipmentSlotMaterial(
  source: Material | EquipmentSourceMaterialIdentity | null,
  item: EquipmentSlotMaterialItem,
  manifestMat: string | null | undefined,
  family: EquipmentMaterialFamily,
  wornColors?: readonly string[] | null,
): Material {
  const identity = sourceIdentity(source);
  const explicitManifestMat = cleanMaterialName(manifestMat) ?? explicitManifestMaterialNameFor(item.id);
  if (isHairEquipmentId(item.id) && explicitManifestMat) return materialForFamily(explicitManifestMat, family);

  const zoned = paletteZoneMaterial(identity.name, item, family, wornColors);
  if (zoned) return zoned;

  const sourcePreset = identity.name ? presetNameForSource(identity.name) : null;
  if (sourcePreset) return materialForFamily(sourcePreset, family);

  if (explicitManifestMat) return materialForFamily(explicitManifestMat, family);

  if (
    identity.baseColorHex
    && identity.name
    && isAuthorialBakedSourceMaterialName(identity.name, item)
  ) {
    return bakedMaterialFor(identity.baseColorHex, family);
  }

  return materialForFamily(item.id, family);
}

function materialForFamily(materialName: string, family: EquipmentMaterialFamily): Material {
  if (family.kind === "world") return worldMaterialFor(materialName, family.matcap);
  return litMaterialFor(materialName);
}

function bakedMaterialFor(hex: string, family: EquipmentMaterialFamily): Material {
  if (family.kind === "world") {
    let material = bakedWorldMaterialCache.get(hex);
    if (!material) {
      material = new MeshMatcapMaterial({ color: hex });
      installPawnRim(material);
      material.name = `successor-world-equipment:baked:${hex}`;
      bakedWorldMaterialCache.set(hex, material);
    }
    if (family.matcap && material.matcap !== family.matcap) {
      material.matcap = family.matcap;
      material.needsUpdate = true;
    }
    material.map = null;
    material.color.set(hex);
    return material;
  }
  let material = bakedLitMaterialCache.get(hex);
  if (!material) {
    material = new MeshStandardMaterial({ color: hex, roughness: 0.78, metalness: 0.05 });
    material.name = `successor-lit-equipment:baked:${hex}`;
    bakedLitMaterialCache.set(hex, material);
  }
  material.color.set(hex);
  material.map = null;
  material.normalMap = null;
  material.roughnessMap = null;
  material.metalnessMap = null;
  material.needsUpdate = true;
  return material;
}

function sourceIdentity(source: Material | EquipmentSourceMaterialIdentity | null): EquipmentSourceMaterialIdentity {
  if (!source) return { name: null, baseColorHex: null };
  if (source instanceof Material) return sourceIdentityFromMaterial(source);
  return {
    name: cleanMaterialName(source.name),
    baseColorHex: cleanHexColor(source.baseColorHex),
  };
}

function sourceIdentityFromMaterial(material: Material): EquipmentSourceMaterialIdentity {
  return {
    name: cleanMaterialName(material.name),
    baseColorHex: materialBaseColorHex(material),
  };
}

function materialBaseColorHex(material: Material): string | null {
  const color = "color" in material && material.color instanceof Color ? material.color : null;
  return color ? `#${color.getHexString()}` : null;
}

function cleanMaterialName(value: string | null | undefined): string | null {
  const cleaned = value?.normalize("NFKC").trim();
  return cleaned ? cleaned : null;
}

function cleanHexColor(value: string | null | undefined): string | null {
  const cleaned = value?.trim().toLowerCase();
  return cleaned && /^#[0-9a-f]{6}$/u.test(cleaned) ? cleaned : null;
}

function presetNameForSource(sourceName: string): string | null {
  const name = cleanMaterialName(sourceName);
  if (!name) return null;
  return presetFor(name) ? name : null;
}

function isHairEquipmentId(itemId: string): boolean {
  return itemId.startsWith("hair_");
}

function isAuthorialBakedSourceMaterialName(sourceName: string, item: EquipmentSlotMaterialItem): boolean {
  const name = cleanMaterialName(sourceName);
  if (!name || GLTF_DEFAULT_MATERIAL_NAME_PATTERN.test(name)) return false;
  const token = normalizedMaterialToken(name);
  if (!token || LEGACY_NON_AUTHORIAL_SOURCE_NAMES.has(token)) return false;
  const candidates = [
    item.id,
    item.name,
    item.slot,
    item.glb ? item.glb.split("/").pop()?.replace(/\.glb$/iu, "") : null,
    item.id.replace(/^(armor|under|helmet|hat|hair)_/u, ""),
  ];
  for (const candidate of candidates) {
    if (candidate && token === normalizedMaterialToken(candidate)) return false;
  }
  return true;
}

function normalizedMaterialToken(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\.\d{3}$/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

export function ensureEquipmentUv(object: Object3D, layer: PawnEquipmentLayer | null): void {
  if (layer !== "Armor") return;
  const mesh = object instanceof Mesh ? object : null;
  if (!mesh?.geometry || mesh.geometry.attributes.uv || !mesh.geometry.attributes.position) return;
  const geometry = mesh.geometry;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const position = geometry.attributes.position;
  if (!bounds || !position) return;
  const uv = new Float32Array(position.count * 2);
  const sx = Math.max(1e-5, bounds.max.x - bounds.min.x);
  const sy = Math.max(1e-5, bounds.max.y - bounds.min.y);
  const sz = Math.max(1e-5, bounds.max.z - bounds.min.z);
  const useY = sz < sy * 0.35;
  for (let i = 0; i < position.count; i += 1) {
    uv[i * 2] = (position.getX(i) - bounds.min.x) / sx;
    uv[i * 2 + 1] = useY
      ? (position.getY(i) - bounds.min.y) / sy
      : (position.getZ(i) - bounds.min.z) / sz;
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  geometry.attributes.uv.needsUpdate = true;
}

function refreshCachedMaterials(): void {
  for (const [materialName, material] of worldMaterialCache) applyWorldPreset(material, materialName);
  for (const [materialName, material] of litMaterialCache) applyLitPreset(material, materialName);
}

function applyWorldPreset(material: MeshMatcapMaterial, materialName: string): void {
  const preset = presetFor(materialName);
  const maps = preset?.maps;
  const baseColor = maps?.baseColor ? textureFor(maps.baseColor, true, preset?.repeat) : null;
  material.name = `successor-world-equipment:${materialName}`;
  material.map = baseColor;
  material.color.set(baseColor ? 0xffffff : (preset?.color ?? FALLBACK_COLOR));
  material.needsUpdate = true;
}

function applyLitPreset(material: MeshStandardMaterial, materialName: string): void {
  const preset = presetFor(materialName);
  const maps = preset?.maps;
  const baseColor = maps?.baseColor ? textureFor(maps.baseColor, true, preset?.repeat) : null;
  const normal = maps?.normal ? textureFor(maps.normal, false, preset?.repeat) : null;
  material.name = `successor-lit-equipment:${materialName}`;
  material.color.set(baseColor ? 0xffffff : (preset?.color ?? FALLBACK_COLOR));
  material.map = baseColor;
  material.normalMap = normal;
  material.roughnessMap = maps?.roughness ? textureFor(maps.roughness, false, preset?.repeat) : null;
  material.metalnessMap = maps?.metalness ? textureFor(maps.metalness, false, preset?.repeat) : null;
  material.metalness = preset?.metalness ?? 0.1;
  material.roughness = preset?.roughness ?? 0.75;
  const scale = normal ? preset?.normalScale ?? 0.6 : 1;
  material.normalScale.set(scale, scale);
  material.envMapIntensity = preset?.envMapIntensity ?? 1;
  material.needsUpdate = true;
}

function textureFor(path: string, color: boolean, repeat: readonly number[] | undefined): Texture {
  const url = `${EQUIPMENT_BASE_URL}/${path}`;
  let texture = textureCache.get(url);
  if (!texture) {
    texture = textureLoader.load(requireRuntimePublicPath(url));
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    textureCache.set(url, texture);
  }
  texture.repeat.set(repeat?.[0] ?? 1, repeat?.[1] ?? 1);
  if (color) texture.colorSpace = SRGBColorSpace;
  return texture;
}

function materialNameFor(pieceOrMaterialName: string): string {
  const assignment = assignmentFor(pieceOrMaterialName);
  if (assignment) return assignment.materialName;
  const sets = cachedSets;
  if (sets?.armorById.has(pieceOrMaterialName) || sets?.clothingById.has(pieceOrMaterialName)) return pieceOrMaterialName;
  const layer = equipmentLayerFor(pieceOrMaterialName);
  if (layer === "Under") return sets?.clothing.default ?? UNDER_DEFAULT_MATERIAL;
  if (layer === "Armor") return sets?.armor.default ?? ARMOR_DEFAULT_MATERIAL;
  return pieceOrMaterialName;
}

function assignmentFor(pieceId: string): EquipmentPieceMaterialAssignment | null {
  return cachedSets?.pieceMaterials.get(pieceId) ?? staticPieceMaterials[pieceId] ?? null;
}

function explicitManifestMaterialNameFor(pieceId: string): string | null {
  const assignment = cachedSets?.pieceMaterials.get(pieceId);
  return assignment?.explicit ? assignment.materialName : null;
}

function presetFor(materialName: string): EquipmentMaterialPreset | null {
  const sets = cachedSets;
  return sets?.armorById.get(materialName) ?? sets?.clothingById.get(materialName) ?? null;
}

async function loadEquipmentMaterialSets(): Promise<EquipmentMaterialSets> {
  const [armor, clothing, manifest] = await Promise.all([
    fetchMaterialConfig(ARMOR_MATERIALS_URL),
    fetchMaterialConfig(CLOTHING_MATERIALS_URL),
    fetchEquipmentManifest(EQUIPMENT_MANIFEST_URL),
  ]);
  return buildSets(armor, clothing, manifest);
}

async function fetchMaterialConfig(url: string): Promise<EquipmentMaterialConfig> {
  const response = await fetch(requireRuntimePublicPath(url));
  if (!response.ok) throw new Error(`equipment materials fetch failed: ${url} (${response.status})`);
  const parsed: unknown = await response.json();
  if (!isMaterialConfig(parsed)) throw new Error(`equipment materials schema mismatch: ${url}`);
  return parsed;
}

async function fetchEquipmentManifest(url: string): Promise<EquipmentManifestConfig> {
  const response = await fetch(requireRuntimePublicPath(url));
  if (!response.ok) throw new Error(`equipment manifest fetch failed: ${url} (${response.status})`);
  const parsed: unknown = await response.json();
  if (!isManifestConfig(parsed)) throw new Error(`equipment manifest schema mismatch: ${url}`);
  return parsed;
}

function buildFallbackSets(): EquipmentMaterialSets {
  const items = Object.values(staticPieceMaterials).map((assignment): EquipmentManifestItem => ({
    id: assignment.pieceId,
    layer: assignment.layer,
    mat: assignment.materialName,
  }));
  const manifest: EquipmentManifestConfig = { items };
  return buildSets(fallbackArmorConfig, fallbackClothingConfig, manifest);
}

function buildSets(
  armor: EquipmentMaterialConfig,
  clothing: EquipmentMaterialConfig,
  manifest: EquipmentManifestConfig,
): EquipmentMaterialSets {
  const armorById = new Map<string, EquipmentMaterialPreset>();
  for (const preset of armor.materials) armorById.set(preset.id, preset);
  const clothingById = new Map<string, EquipmentMaterialPreset>();
  for (const preset of clothing.materials) clothingById.set(preset.id, preset);

  const pieceMaterials = new Map<string, EquipmentPieceMaterialAssignment>();
  const assignments: EquipmentPieceMaterialAssignment[] = [];
  for (const item of manifest.items) {
    const materialName = item.mat
      ?? (item.layer === "Under"
        ? clothing.default ?? UNDER_DEFAULT_MATERIAL
        : armor.default ?? ARMOR_DEFAULT_MATERIAL);
    const assignment = { pieceId: item.id, layer: item.layer, materialName, explicit: item.mat !== undefined };
    pieceMaterials.set(item.id, assignment);
    assignments.push(assignment);
  }
  return { armor, clothing, armorById, clothingById, pieceMaterials, assignments };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMaterialConfig(value: unknown): value is EquipmentMaterialConfig {
  return isRecord(value)
    && typeof value.schemaVersion === "number"
    && (value.default === undefined || typeof value.default === "string")
    && Array.isArray(value.materials)
    && value.materials.every(isMaterialPreset);
}

function isMaterialPreset(value: unknown): value is EquipmentMaterialPreset {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (value.maps !== undefined && !isTextureMaps(value.maps)) return false;
  if (value.repeat !== undefined && !isNumberArray(value.repeat)) return false;
  return true;
}

function isTextureMaps(value: unknown): value is EquipmentTextureMaps {
  if (!isRecord(value)) return false;
  return optionalString(value.baseColor)
    && optionalString(value.normal)
    && optionalString(value.roughness)
    && optionalString(value.metalness);
}

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isManifestConfig(value: unknown): value is EquipmentManifestConfig {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every((item) => isRecord(item)
      && typeof item.id === "string"
      && (item.layer === "Armor" || item.layer === "Under")
      && (item.mat === undefined || typeof item.mat === "string"));
}

if (typeof window !== "undefined") {
  void getEquipmentMaterialSets();
}
