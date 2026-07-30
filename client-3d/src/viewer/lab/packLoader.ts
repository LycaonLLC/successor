// packLoader.ts — Asset Lab data loading. VIEWER PLUMBING ONLY.
//
// The lab consumes the REAL runtime pack (assets/pawnPack.loadPawnPack): bodies,
// clips, masks, weapons registry, equipment scenes, special bodies — the exact
// objects the game renders with. This module only ADDS lab-side data on top:
//   - anim-lab clip GLBs (melee lab + mixamo lab) merged into copies of the
//     pack's clip maps (the runtime pack object itself is never mutated),
//   - catalog rows (weapon labels, clip grouping, wave-prop library index).
// NO equipment attach / material / animation logic lives here — that is the
// fork disease this rewrite exists to kill.
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadPawnPack, type PawnPack } from "../../assets/pawnPack";
import { sane, toClipLayer, type ClipLayer, type PawnClipMeta } from "../../assets/pawnRigTypes";

export const PACK_BASE = "/assets/pawn-pack";
const ANIM_LAB_MANIFEST_URLS = [
  `${PACK_BASE}/anim_lab_melee.json`,
  `${PACK_BASE}/anim_lab_mixamo.json`,
] as const;
const WEAPONS_MANIFEST_URL = `${PACK_BASE}/weapons/weapons_manifest.json`;
const WAVE_PROPS_MANIFEST_URL = "/assets/wave-props/manifest.json";

export interface ClipGroup {
  label: string;
  clips: readonly string[];
}

export interface LabWeaponEntry {
  id: string;
  label: string;
  /** weapons_manifest class; "melee" routes the melee lane, everything else the rifle lane. */
  weaponClass: string;
  /** true for the two pack-baked legacy weapons (slugthrower / vibrosword). */
  legacy: boolean;
}

export interface WavePropEntry {
  id: string;
  label: string;
  url: string;
  category: string;
  searchText: string;
}

export interface LabData {
  pack: PawnPack;
  /** Ordered clip rail groups: game-pack layers first, then the lab packs. */
  clipGroups: readonly ClipGroup[];
  weapons: readonly LabWeaponEntry[];
  waveProps: readonly WavePropEntry[];
}

interface GamePackClipJson {
  name: string;
  layer: string;
  mask: string | null;
  loop: boolean;
  duration_s: number;
  move_speed_mps: number;
  clamp_when_finished?: boolean;
}

interface AnimLabManifestJson {
  schema: string;
  file: string;
  group: string;
  clips: GamePackClipJson[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGamePackClipJson(value: unknown): value is GamePackClipJson {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.layer === "string"
    && (typeof value.mask === "string" || value.mask === null)
    && typeof value.loop === "boolean"
    && typeof value.duration_s === "number"
    && typeof value.move_speed_mps === "number"
    && (value.clamp_when_finished === undefined || typeof value.clamp_when_finished === "boolean");
}

function isAnimLabManifestJson(value: unknown): value is AnimLabManifestJson {
  return isRecord(value)
    && typeof value.schema === "string"
    && typeof value.file === "string"
    && typeof value.group === "string"
    && Array.isArray(value.clips)
    && value.clips.every(isGamePackClipJson);
}

/**
 * Optional-manifest fetch: 404 → null, and — the Vite dev-server trap — an
 * index.html fallback (200 text/html for an absent public file) → null too.
 * Real JSON still schema-gates.
 */
async function fetchOptionalJson<T>(url: string, guard: (value: unknown) => value is T): Promise<T | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`fetch failed: ${url} (${response.status})`);
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return null;
  const parsed: unknown = await response.json();
  if (!guard(parsed)) throw new Error(`schema mismatch: ${url}`);
  return parsed;
}

type THREEAnimationClip = GLTF["animations"][number];

function unknownClipTrackTargets(clip: THREEAnimationClip, boneNames: ReadonlySet<string>): string[] {
  const unknown = new Set<string>();
  for (const track of clip.tracks) {
    const targetName = sane(track.name.split(".")[0]?.split("/").pop() ?? "");
    if (targetName && !boneNames.has(targetName)) unknown.add(targetName);
  }
  return [...unknown].sort();
}

async function fetchOptionalAnimLabManifests(): Promise<AnimLabManifestJson[]> {
  const manifests = await Promise.all(
    ANIM_LAB_MANIFEST_URLS.map((url) => fetchOptionalJson(url, isAnimLabManifestJson)),
  );
  return manifests.filter((manifest): manifest is AnimLabManifestJson => manifest !== null);
}

interface WeaponsCatalogJson {
  items: Array<{ id: string; label?: string; class: string }>;
}

function isWeaponsCatalogJson(value: unknown): value is WeaponsCatalogJson {
  return isRecord(value) && Array.isArray(value.items) && value.items.every((item) => isRecord(item)
    && typeof item.id === "string"
    && typeof item.class === "string"
    && (item.label === undefined || typeof item.label === "string"));
}

interface WavePropsManifestJson {
  assetBase: string;
  entries: Array<{ id: string; label: string; glb: string; category?: string; kind?: string }>;
}

function isWavePropsManifestJson(value: unknown): value is WavePropsManifestJson {
  return isRecord(value)
    && typeof value.assetBase === "string"
    && Array.isArray(value.entries)
    && value.entries.every((entry) => isRecord(entry)
      && typeof entry.id === "string"
      && typeof entry.label === "string"
      && typeof entry.glb === "string"
      && (entry.category === undefined || typeof entry.category === "string")
      && (entry.kind === undefined || typeof entry.kind === "string"));
}


const LAYER_GROUP_ORDER: readonly ClipLayer[] = ["base", "upper", "hand", "montage", "arm"];
const LAYER_GROUP_LABELS: Readonly<Record<ClipLayer, string>> = {
  base: "BASE",
  upper: "UPPER",
  hand: "HAND",
  montage: "MONTAGE",
  arm: "ARM",
};

export async function loadLabData(): Promise<LabData> {
  // The lab must browse fit-trial (viewerOnly) garments — opt in BEFORE the
  // runtime pack load reads the equipment manifest.
  (window as Window & { __successorIncludeViewerOnlyEquipment?: boolean }).__successorIncludeViewerOnlyEquipment = true;

  const [runtimePack, labManifests, weaponsCatalog, wavePropsManifest] = await Promise.all([
    loadPawnPack(),
    fetchOptionalAnimLabManifests(),
    fetchOptionalJson(WEAPONS_MANIFEST_URL, isWeaponsCatalogJson),
    fetchOptionalJson(WAVE_PROPS_MANIFEST_URL, isWavePropsManifestJson),
  ]);

  // Merge anim-lab clips into COPIES of the runtime clip maps.
  const clips = new Map(runtimePack.clips);
  const clipMeta = new Map<string, PawnClipMeta>(runtimePack.clipMeta);
  const labGroups: ClipGroup[] = [];
  const loader = new GLTFLoader();
  for (const lab of labManifests) {
    const gltf = await loader.loadAsync(`${PACK_BASE}/${lab.file}`);
    const byName = new Map(gltf.animations.map((clip) => [clip.name, clip]));
    const accepted: string[] = [];
    for (const declared of lab.clips) {
      const clip = byName.get(declared.name);
      if (!clip) throw new Error(`anim lab clip missing from GLB: ${declared.name} (${lab.file})`);
      const unknownTargets = unknownClipTrackTargets(clip, runtimePack.boneNames);
      if (unknownTargets.length > 0) {
        throw new Error(`anim lab clip ${declared.name} targets unknown bones: ${unknownTargets.join(", ")}`);
      }
      if (!(clip.duration > 0)) throw new Error(`anim lab clip ${declared.name} has non-positive duration`);
      clips.set(clip.name, clip);
      clipMeta.set(declared.name, {
        name: declared.name,
        layer: toClipLayer(declared.layer, declared.name),
        mask: declared.mask,
        loop: declared.loop,
        durationS: declared.duration_s,
        moveSpeedMps: declared.move_speed_mps,
        clampWhenFinished: declared.clamp_when_finished ?? false,
        events: {},
      });
      accepted.push(declared.name);
    }
    labGroups.push({ label: lab.group, clips: accepted });
  }
  const pack: PawnPack = { ...runtimePack, clips, clipMeta };

  // Clip rail groups: game-pack clips by layer (pack order), then the labs.
  const labClipNames = new Set(labGroups.flatMap((group) => group.clips));
  const byLayer = new Map<ClipLayer, string[]>(LAYER_GROUP_ORDER.map((layer) => [layer, []]));
  for (const meta of runtimePack.clipMeta.values()) {
    if (labClipNames.has(meta.name)) continue;
    byLayer.get(meta.layer)?.push(meta.name);
  }
  const clipGroups: ClipGroup[] = [];
  for (const layer of LAYER_GROUP_ORDER) {
    const names = byLayer.get(layer) ?? [];
    if (names.length > 0) clipGroups.push({ label: LAYER_GROUP_LABELS[layer], clips: names });
  }
  clipGroups.push(...labGroups);

  // Weapon catalog: pack-baked legacy pair + every registry weapon the runtime
  // actually loaded (scenes/specs come from pack.weapons, never re-fetched).
  const weapons: LabWeaponEntry[] = [
    { id: "slugthrower", label: "Slugthrower (legacy)", weaponClass: "rifle", legacy: true },
    { id: "vibrosword", label: "Vibrosword (legacy)", weaponClass: "melee", legacy: true },
  ];
  for (const item of weaponsCatalog?.items ?? []) {
    if (!pack.weapons.has(item.id)) continue;
    weapons.push({
      id: item.id,
      label: item.label ?? item.id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      weaponClass: pack.weapons.get(item.id)!.silhouetteClass,
      legacy: false,
    });
  }

  const waveProps: WavePropEntry[] = (wavePropsManifest?.entries ?? []).map((entry) => {
    const category = entry.category ?? entry.kind ?? "misc";
    return {
      id: entry.id,
      label: entry.label,
      url: `${wavePropsManifest!.assetBase}${entry.glb}`,
      category,
      searchText: `${entry.label} ${entry.id} ${category}`.toLowerCase(),
    };
  });

  return { pack, clipGroups, weapons, waveProps };
}
