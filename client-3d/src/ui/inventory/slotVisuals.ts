import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  SkinnedMesh,
  Texture,
  Vector3,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  ensureEquipmentUv,
  equipmentLayerFor,
  equipmentSourceMaterialFromUserData,
  getEquipmentMaterialSets,
  resolveEquipmentSlotMaterial,
  stashEquipmentSourceMaterialIdentity,
} from "../../assets/equipmentMaterials";
import { createPawnMatcapTexture } from "../../render/pawns";
import type { ContainerSpec } from "./containers";
import { RESOURCE_GLYPH_SILHOUETTES, type ContainerGlyphId } from "./resourceGlyphs";

/** Shared turntable vocabulary for normalized GLB models and procedural stack containers. */
export const SLOT_TURN_RADIANS_PER_SECOND = 0.6;
export const SLOT_MODEL_TARGET_MAX_DIMENSION = 1.35;
export const SLOT_ROOT_TILT_X = -0.12;
const TWO_PI = Math.PI * 2;
/** Traced silhouette SVG viewBox edge and its world-space plate envelope. */
const GLYPH_VIEWBOX = 512;
const GLYPH_WORLD_SPAN = 0.36;
const GLYPH_DARK_INK = "#15191c";
const GLYPH_LIGHT_INK = "#ffffff";

function linearSrgbChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hexColor: string): number {
  const value = Number.parseInt(hexColor.slice(1), 16);
  const red = linearSrgbChannel((value >> 16) & 0xff);
  const green = linearSrgbChannel((value >> 8) & 0xff);
  const blue = linearSrgbChannel(value & 0xff);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Pick the higher-contrast monochrome ink for a semantic plate colour. */
export function glyphInkColorForPlate(plateColor: string): string {
  const plateLuminance = relativeLuminance(plateColor);
  const darkLuminance = relativeLuminance(GLYPH_DARK_INK);
  const darkContrast = (plateLuminance + 0.05) / (darkLuminance + 0.05);
  const lightContrast = 1.05 / (plateLuminance + 0.05);
  return lightContrast > darkContrast ? GLYPH_LIGHT_INK : GLYPH_DARK_INK;
}

export interface SlotRotationEuler {
  x: number;
  y: number;
  z: number;
}

export function slotVisualRotation(
  _assetKey: string,
  phase: number,
  timeMs: number,
  dragYaw: number | undefined,
  out: SlotRotationEuler,
): SlotRotationEuler {
  out.x = SLOT_ROOT_TILT_X;
  out.y = dragYaw ?? phase + timeMs * 0.001 * SLOT_TURN_RADIANS_PER_SECOND;
  out.z = 0;
  return out;
}

export interface ModelAsset {
  source: Group | null;
  promise: Promise<void> | null;
  error: boolean;
  sourceMaxDimension: number;
  normalizedScale: number;
}

interface GlyphVisual {
  geometry: ShapeGeometry;
}

/** Clockwise (viewed from +Y) regular polygon profile in the XZ plane. */
function regularProfile(sides: number, radius: number, startDeg: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = ((startDeg - (i * 360) / sides) * Math.PI) / 180;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return points;
}

/** Octagonal jerry-can section for the gable canister (clockwise). */
const GABLE_BODY_PROFILE: readonly (readonly [number, number])[] = [
  [-0.19, 0.33], [0.19, 0.33], [0.34, 0.18], [0.34, -0.18],
  [0.19, -0.33], [-0.19, -0.33], [-0.34, -0.18], [-0.34, 0.18],
];
/** Triangular gable ridge profile (clockwise). */
const GABLE_ROOF_PROFILE: readonly (readonly [number, number])[] = [[0, 0.16], [0.25, 0], [-0.25, 0]];
/** Chamfered-square footprint for the grain sack (clockwise). */
const SACK_PROFILE: readonly (readonly [number, number])[] = [
  [-0.17, 0.3], [0.17, 0.3], [0.3, 0.17], [0.3, -0.17],
  [0.17, -0.3], [-0.17, -0.3], [-0.3, -0.17], [-0.3, 0.17],
];

/**
 * Flat-shaded convex prism/frustum: profile in XZ (clockwise from +Y),
 * extruded along Y with independent top/bottom scaling. Every standardized
 * container body is built from these polygonal prisms — the contract bans
 * cylinder bodies for resource containers.
 */
function prismGeometry(
  profile: readonly (readonly [number, number])[],
  height: number,
  topScale = 1,
  bottomScale = 1,
): BufferGeometry {
  const half = height / 2;
  const count = profile.length;
  const positions: number[] = [];
  const point = (index: number, top: boolean): [number, number, number] => {
    const [u, v] = profile[index % count]!;
    const scale = top ? topScale : bottomScale;
    return [u * scale, top ? half : -half, v * scale];
  };
  for (let i = 0; i < count; i += 1) {
    const b0 = point(i, false);
    const b1 = point(i + 1, false);
    const t0 = point(i, true);
    const t1 = point(i + 1, true);
    positions.push(...b0, ...b1, ...t1, ...b0, ...t1, ...t0);
  }
  for (let i = 1; i + 1 < count; i += 1) {
    positions.push(...point(0, true), ...point(i, true), ...point(i + 1, true));
    positions.push(...point(0, false), ...point(i + 1, false), ...point(i, false));
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export class SlotVisualKit {
  private readonly loader = new GLTFLoader();
  private readonly matcap = createPawnMatcapTexture();
  private readonly modelAssets = new Map<string, ModelAsset>();
  private readonly containerBodyMaterials = new Map<string, MeshStandardMaterial>();
  private readonly containerPlateMaterials = new Map<string, MeshBasicMaterial>();
  private readonly darkGlyphMaterial = new MeshBasicMaterial({ color: GLYPH_DARK_INK, side: DoubleSide });
  private readonly lightGlyphMaterial = new MeshBasicMaterial({ color: GLYPH_LIGHT_INK, side: DoubleSide });
  private readonly glyphVisuals = new Map<ContainerGlyphId, GlyphVisual>();

  // Polygonal container bodies (contract: no cylinder bodies, ever).
  private readonly hexCrateBodyGeometry = prismGeometry(regularProfile(6, 0.42, 120), 0.56);
  private readonly hexCrateShoulderGeometry = prismGeometry(regularProfile(6, 0.42, 120), 0.1, 0.76, 1);
  private readonly hexCrateSkirtGeometry = prismGeometry(regularProfile(6, 0.42, 120), 0.1, 1, 0.81);
  private readonly gableBodyGeometry = prismGeometry(GABLE_BODY_PROFILE, 0.34).rotateX(-Math.PI / 2);
  private readonly gableRoofGeometry = prismGeometry(GABLE_ROOF_PROFILE, 0.3).rotateX(-Math.PI / 2);
  private readonly bioPodBodyGeometry = prismGeometry(regularProfile(8, 0.28, 112.5), 0.78).rotateZ(Math.PI / 2);
  private readonly bioPodStrapGeometry = prismGeometry(regularProfile(8, 0.305, 112.5), 0.07).rotateZ(Math.PI / 2);
  private readonly sackBodyGeometry = prismGeometry(SACK_PROFILE, 0.5);
  private readonly sackSkirtGeometry = prismGeometry(SACK_PROFILE, 0.16, 1, 1.12);
  private readonly sackCinchGeometry = prismGeometry(SACK_PROFILE, 0.14, 0.32, 0.5);
  private readonly ammoBodyGeometry = new BoxGeometry(0.9, 0.4, 0.55);
  private readonly ammoLidGeometry = new BoxGeometry(0.94, 0.08, 0.59);
  // Shared hardware grammar: lugs/sockets, fork runners, strap channels, handles, brace arms.
  private readonly lugGeometry = new BoxGeometry(0.12, 0.07, 0.12);
  private readonly forkRunnerGeometry = new BoxGeometry(0.14, 0.08, 0.62);
  private readonly strapChannelGeometry = new BoxGeometry(0.1, 0.4, 0.61);
  private readonly handleGeometry = new BoxGeometry(0.26, 0.06, 0.09);
  private readonly podKeyGeometry = new BoxGeometry(0.46, 0.05, 0.2);
  private readonly braceArmGeometry = new BoxGeometry(0.46, 0.045, 0.02);
  private readonly plateGeometry = new PlaneGeometry(0.4, 0.4);

  /** Load (once) and normalize a GLB into a slot-scale source. */
  modelAsset(glbPath: string): ModelAsset {
    const url = requireRuntimePublicPath(glbPath.startsWith("/") ? glbPath : `/${glbPath}`);
    let asset = this.modelAssets.get(url);
    if (asset) return asset;
    const created: ModelAsset = { source: null, promise: null, error: false, sourceMaxDimension: 0, normalizedScale: 1 };
    created.promise = this.loader.loadAsync(url).then((gltf) => {
      const normalized = normalizeModelScene(gltf.scene, url);
      created.source = normalized.root;
      created.sourceMaxDimension = normalized.sourceMaxDimension;
      created.normalizedScale = normalized.normalizedScale;
    }).catch((error: unknown) => {
      created.error = true;
      console.warn(`inventory model thumbnail failed: ${url}`, error);
    });
    this.modelAssets.set(url, created);
    return created;
  }

  createModelRoot(source: Group, equipmentId: string | null, isCurrent: (root: Object3D) => boolean): Object3D {
    const root = containsSkinnedMesh(source) ? cloneSkeleton(source) : source.clone(true);
    if (equipmentId) {
      applyWorldEquipmentMaterials(root, equipmentId, this.matcap);
      void getEquipmentMaterialSets().then(() => {
        if (!isCurrent(root)) return;
        applyWorldEquipmentMaterials(root, equipmentId, this.matcap);
      });
    }
    // Props keep their authored PBR/material graph. Only wearable equipment
    // enters the pawn material harness above.
    return root;
  }

  /** Build a real 3D standardized polygonal container with a synchronous plate glyph. */
  createContainerRoot(spec: ContainerSpec): Group {
    const root = new Group();
    const body = this.containerBodyMaterial(spec.bodyColor);
    const plate = new Mesh(this.plateGeometry, this.containerPlateMaterial(spec.plateColor));
    const glyphVisual = this.glyphVisual(spec.lineGlyph);
    const glyph = new Mesh(
      glyphVisual.geometry,
      glyphInkColorForPlate(spec.plateColor) === GLYPH_LIGHT_INK
        ? this.lightGlyphMaterial
        : this.darkGlyphMaterial,
    );

    if (spec.shape === "hex-crate") {
      // Vertical hex prism, chamfered shoulder/skirt, stack lugs, fork runners.
      root.add(new Mesh(this.hexCrateBodyGeometry, body));
      const shoulder = new Mesh(this.hexCrateShoulderGeometry, body);
      shoulder.position.y = 0.33;
      const skirt = new Mesh(this.hexCrateSkirtGeometry, body);
      skirt.position.y = -0.33;
      root.add(shoulder, skirt);
      for (const x of [-0.18, 0.18]) {
        const lug = new Mesh(this.lugGeometry, body);
        lug.position.set(x, 0.415, 0);
        const runner = new Mesh(this.forkRunnerGeometry, body);
        runner.position.set(x, -0.42, 0);
        root.add(lug, runner);
      }
      plate.position.set(0, 0, 0.368);
      glyph.position.set(0, 0, 0.374);
      plate.scale.setScalar(0.8);
      glyph.scale.setScalar(0.8);
    } else if (spec.shape === "gable-canister") {
      // Octagonal jerry-can slab, top gable, fold-flat handle, guarded bosses, X brace.
      const shell = new Mesh(this.gableBodyGeometry, body);
      shell.position.y = -0.06;
      root.add(shell);
      const roof = new Mesh(this.gableRoofGeometry, body);
      roof.position.y = 0.27;
      root.add(roof);
      const handle = new Mesh(this.handleGeometry, body);
      handle.position.y = 0.44;
      root.add(handle);
      for (const x of [-0.14, 0.14]) {
        const boss = new Mesh(this.lugGeometry, body);
        boss.position.set(x, 0.305, 0);
        root.add(boss);
      }
      for (const roll of [Math.PI / 4, -Math.PI / 4]) {
        const arm = new Mesh(this.braceArmGeometry, body);
        arm.position.set(0, -0.06, 0.172);
        arm.rotation.z = roll;
        root.add(arm);
      }
      plate.position.set(0, -0.06, 0.185);
      glyph.position.set(0, -0.06, 0.191);
      plate.scale.setScalar(0.62);
      glyph.scale.setScalar(0.62);
    } else if (spec.shape === "bio-pod") {
      // Horizontal long-octagon cold vessel: strap channels, end handles, keyed top, vents.
      root.add(new Mesh(this.bioPodBodyGeometry, body));
      for (const x of [-0.2, 0.2]) {
        const strap = new Mesh(this.bioPodStrapGeometry, body);
        strap.position.x = x;
        root.add(strap);
      }
      const key = new Mesh(this.podKeyGeometry, body);
      key.position.y = 0.28;
      root.add(key);
      for (const x of [-0.41, 0.41]) {
        const handle = new Mesh(this.handleGeometry, body);
        handle.rotation.z = Math.PI / 2;
        handle.position.set(x, 0, 0);
        root.add(handle);
      }
      for (const x of [-0.1, 0.1]) {
        const vent = new Mesh(this.lugGeometry, body);
        vent.position.set(x, 0.335, 0);
        root.add(vent);
      }
      plate.position.set(0, 0, 0.266);
      glyph.position.set(0, 0, 0.272);
      plate.scale.setScalar(0.6);
      glyph.scale.setScalar(0.6);
    } else if (spec.shape === "grain-sack") {
      // Slumped chamfered-cube sack: bulged skirt, cinched neck, tie knob, sewn plate patch.
      root.add(new Mesh(this.sackBodyGeometry, body));
      const skirt = new Mesh(this.sackSkirtGeometry, body);
      skirt.position.y = -0.22;
      root.add(skirt);
      const cinch = new Mesh(this.sackCinchGeometry, body);
      cinch.position.y = 0.3;
      root.add(cinch);
      const knob = new Mesh(this.lugGeometry, body);
      knob.position.y = 0.395;
      root.add(knob);
      plate.position.set(0, -0.02, 0.306);
      glyph.position.set(0, -0.02, 0.312);
      plate.scale.setScalar(0.5);
      glyph.scale.setScalar(0.5);
    } else {
      // Ammo box aligned to the shared lug and strap-channel grammar.
      root.add(new Mesh(this.ammoBodyGeometry, body));
      const lid = new Mesh(this.ammoLidGeometry, body);
      lid.position.y = 0.24;
      root.add(lid);
      for (const x of [-0.28, 0.28]) {
        const strap = new Mesh(this.strapChannelGeometry, body);
        strap.position.x = x;
        root.add(strap);
      }
      for (const x of [-0.18, 0.18]) {
        const lug = new Mesh(this.lugGeometry, body);
        lug.position.set(x, 0.315, 0);
        root.add(lug);
      }
      plate.position.set(0, 0, 0.285);
      glyph.position.set(0, 0, 0.291);
      plate.scale.setScalar(0.72);
      glyph.scale.setScalar(0.72);
    }

    root.add(plate, glyph);
    return root;
  }

  dispose(): void {
    for (const asset of this.modelAssets.values()) {
      if (asset.source) disposeObjectResources(asset.source);
    }
    this.modelAssets.clear();
    for (const material of this.containerBodyMaterials.values()) material.dispose();
    this.containerBodyMaterials.clear();
    for (const material of this.containerPlateMaterials.values()) material.dispose();
    this.containerPlateMaterials.clear();
    for (const glyph of this.glyphVisuals.values()) glyph.geometry.dispose();
    this.glyphVisuals.clear();
    this.darkGlyphMaterial.dispose();
    this.lightGlyphMaterial.dispose();
    this.hexCrateBodyGeometry.dispose();
    this.hexCrateShoulderGeometry.dispose();
    this.hexCrateSkirtGeometry.dispose();
    this.gableBodyGeometry.dispose();
    this.gableRoofGeometry.dispose();
    this.bioPodBodyGeometry.dispose();
    this.bioPodStrapGeometry.dispose();
    this.sackBodyGeometry.dispose();
    this.sackSkirtGeometry.dispose();
    this.sackCinchGeometry.dispose();
    this.ammoBodyGeometry.dispose();
    this.ammoLidGeometry.dispose();
    this.lugGeometry.dispose();
    this.forkRunnerGeometry.dispose();
    this.strapChannelGeometry.dispose();
    this.handleGeometry.dispose();
    this.podKeyGeometry.dispose();
    this.braceArmGeometry.dispose();
    this.plateGeometry.dispose();
    this.matcap.dispose();
  }

  private containerBodyMaterial(bodyColor: string): MeshStandardMaterial {
    let material = this.containerBodyMaterials.get(bodyColor);
    if (!material) {
      material = new MeshStandardMaterial({ color: bodyColor, roughness: 0.82, metalness: 0.25 });
      this.containerBodyMaterials.set(bodyColor, material);
    }
    return material;
  }

  private containerPlateMaterial(plateColor: string): MeshBasicMaterial {
    let material = this.containerPlateMaterials.get(plateColor);
    if (!material) {
      material = new MeshBasicMaterial({ color: plateColor, side: DoubleSide });
      this.containerPlateMaterials.set(plateColor, material);
    }
    return material;
  }

  /**
   * Triangulated filled silhouette for a plate glyph. The traced SVG space is
   * a 512-unit y-down viewBox; shapes (with negative-space holes) are
   * triangulated, centered, and flipped into the plate's y-up local frame at
   * the shared 0.36-unit glyph envelope. Filling shapes instead of stroking
   * sampled points keeps disconnected subpaths from leaking connector
   * segments.
   */
  private glyphVisual(glyphId: ContainerGlyphId): GlyphVisual {
    const existing = this.glyphVisuals.get(glyphId);
    if (existing) return existing;
    // The registry keeps the theme-neutral fill="currentColor" convention;
    // substitute a concrete colour so SVGLoader's style parsing stays silent
    // (the glyph material below owns the rendered colour anyway).
    const markup = RESOURCE_GLYPH_SILHOUETTES[glyphId].replace('fill="currentColor"', 'fill="#000"');
    const shapes: Shape[] = [];
    for (const path of new SVGLoader().parse(markup).paths) {
      shapes.push(...path.toShapes());
    }
    const geometry = new ShapeGeometry(shapes);
    geometry.translate(-GLYPH_VIEWBOX / 2, -GLYPH_VIEWBOX / 2, 0);
    const scale = GLYPH_WORLD_SPAN / GLYPH_VIEWBOX;
    geometry.scale(scale, -scale, 1);
    const visual = { geometry };
    this.glyphVisuals.set(glyphId, visual);
    return visual;
  }
}

export function containsSkinnedMesh(root: Object3D): boolean {
  let found = false;
  root.traverse((object) => {
    if (object instanceof SkinnedMesh) found = true;
  });
  return found;
}

export function applyWorldEquipmentMaterials(root: Object3D, equipmentId: string, matcap: Texture): void {
  const layer = equipmentLayerFor(equipmentId) ?? "Armor";
  const item = { id: equipmentId, layer };
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    ensureEquipmentUv(object, layer);
    stashEquipmentSourceMaterialIdentity(object, object.material);
    object.material = resolveEquipmentSlotMaterial(
      equipmentSourceMaterialFromUserData(object),
      item,
      null,
      { kind: "world", matcap },
    );
  });
}


const normalizeBoxScratch = new Box3();
const normalizeSizeScratch = new Vector3();
const normalizeCenterScratch = new Vector3();

/** Center a loaded scene and scale it to the shared slot-model envelope. */
export function normalizeModelScene(
  source: Group,
  url: string,
): { root: Group; sourceMaxDimension: number; normalizedScale: number } {
  // Wardrobe glove GLBs contain left + right skinned meshes at their world
  // hand sockets. A bag tile represents the pair with one full-size glove.
  if (url.includes("/gloves_")) {
    const gloveMeshes: SkinnedMesh[] = [];
    source.traverse((object) => {
      if (object instanceof SkinnedMesh) gloveMeshes.push(object);
    });
    for (let index = 1; index < gloveMeshes.length; index += 1) gloveMeshes[index]!.removeFromParent();
  }
  source.updateMatrixWorld(true);
  normalizeBoxScratch.setFromObject(source);
  normalizeBoxScratch.getSize(normalizeSizeScratch);
  normalizeBoxScratch.getCenter(normalizeCenterScratch);
  const sourceMaxDimension = Math.max(normalizeSizeScratch.x, normalizeSizeScratch.y, normalizeSizeScratch.z, 1e-4);
  const normalizedScale = SLOT_MODEL_TARGET_MAX_DIMENSION / sourceMaxDimension;
  source.position.x -= normalizeCenterScratch.x;
  source.position.y -= normalizeCenterScratch.y;
  source.position.z -= normalizeCenterScratch.z;

  const root = new Group();
  root.name = `inventory-normalized-model:${url}`;
  root.scale.setScalar(normalizedScale);
  root.add(source);
  return { root, sourceMaxDimension, normalizedScale };
}

/** Deterministic per-key turntable phase so grids do not rotate in lockstep. */
export function keyPhase(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff * TWO_PI;
}

export function disposeObjectResources(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const material = object.material;
    if (Array.isArray(material)) {
      for (let i = 0; i < material.length; i += 1) disposeMaterial(material[i]!);
    } else {
      disposeMaterial(material);
    }
  });
}

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose();
  }
  material.dispose();
}
