import {
  AnimationMixer,
  Box3,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { extractorDeviceLabelForFamily } from "@successor/client/src/slice-core/resourceCategories";
import type { PlayState, ServerAuthorityPlacedExtractorState } from "@successor/client/src/slice-core/gameState";
import { resourceCategoryForFamily } from "@successor/client/src/slice-core/resourceCategories";
import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";
import { markSunShadowCaster } from "./environment/sunShadow";

/**
 * Placed field extractors — dynamic authority entities, NOT area props.
 *
 * `serverAuthority.placedExtractors` is a full-replace list (resourceSpawns
 * pattern), so every frame reconciles that list against live instances:
 * spawn on first sight, despawn on removal, restyle on mode change. Each
 * instance is a cheap deep-clone of one shared GLB (772 tris, palette-UV,
 * BoxSmith bakeoff 2026-07-07) with its own AnimationMixer:
 *
 *   mode "manual"  → crank_loop (1.2s/rev hand crank; the DEVICE animates)
 *   mode "battery" → run_loop  (0.6s/rev + chassis vibration) + warm pulse
 *   mode "idle"    → static; hopper > 0 adds a slow amber "come collect"
 *                    breath — colour-only, PS2 restraint, no extra geometry
 *
 * Yaw is hashed from the extractor id (deterministic across sessions — the
 * wire carries no rotation). Ground sits at y=0 like pawns/props.
 */

export interface ExtractorPickResult {
  extractorId: string;
  label: string;
  isOwner: boolean;
}

const EXTRACTOR_GLBS: Record<string, string> = {
  mineral: "/assets/world-items/extractor_mineral.glb",
  chemical: "/assets/world-items/extractor_chemical.glb",
  gas: "/assets/world-items/extractor_gas.glb",
  water: "/assets/world-items/extractor_water.glb",
};
/** Authored at real-world 0.6 m; modest upscale for iso-camera readability. */
const EXTRACTOR_WORLD_SCALE = 1.25;
const CRANK_CLIP = "crank_loop";
const RUN_CLIP = "run_loop";
const CLIP_FADE_SECONDS = 0.25;
/** Battery-mode warm pulse (subtle breath, ~1.6 s period). */
const RUN_PULSE_HZ = 1 / 1.6;
/** Idle-with-yield amber breath (~3.2 s period — asleep, not alarmed). */
const YIELD_PULSE_HZ = 1 / 3.2;

interface LoadedExtractorAsset {
  template: Object3D;
  clips: AnimationClip[];
}

interface ExtractorInstance {
  root: Object3D;
  mixer: AnimationMixer;
  crank: AnimationAction | null;
  run: AnimationAction | null;
  material: MeshBasicMaterial;
  meshes: Mesh[];
  mode: ServerAuthorityPlacedExtractorState["mode"];
  hopperPct: number;
  isOwner: boolean;
  label: string;
  cellX: number;
  cellY: number;
  seenAtSync: number;
}

const tmpColor = new Color();
const tmpBox = new Box3();
const tmpCenter = new Vector3();

export class PlacedExtractorsRenderer {
  private readonly group = new Group();
  private readonly loader = new GLTFLoader();
  private readonly instances = new Map<string, ExtractorInstance>();
  private readonly raycaster = new Raycaster();
  private readonly pickPoint = new Vector2();
  private readonly pickMeshes: Mesh[] = [];
  private readonly instanceByMesh = new Map<Object3D, ExtractorInstance>();
  private readonly pickResultByMesh = new Map<Object3D, ExtractorPickResult>();
  private readonly assets = new Map<string, LoadedExtractorAsset>();
  private readonly assetsRequested = new Set<string>();
  private readonly assetsFailed = new Set<string>();
  private syncCounter = 0;

  constructor(private readonly scene: Scene) {
    this.group.name = "placed-extractors";
    this.scene.add(this.group);
  }

  /** Per-frame: reconcile the streamed list, advance clips, breathe tints. */
  update(state: PlayState, dtSeconds: number, timeMs: number): void {
    const list = state.serverAuthority.placedExtractors;
    if (list.length === 0 && this.instances.size === 0) return;
    // handled on-demand per category below

    this.syncCounter += 1;
    for (const vm of list) {
      if (vm.areaId !== state.activeAreaId) continue;
      const category = resourceCategoryForFamily(vm.familyLabel) ?? "mineral";
      const asset = this.assets.get(category);
      if (!asset) {
        this.requestAsset(category);
        continue;
      }
      let instance = this.instances.get(vm.extractorId);
      if (!instance) {
        instance = this.spawn(vm, asset, category);
        this.instances.set(vm.extractorId, instance);
      }
      instance.seenAtSync = this.syncCounter;
      if (instance.mode !== vm.mode) this.applyMode(instance, vm.mode);
      instance.hopperPct = vm.hopperPct;
      instance.isOwner = vm.isOwner;
      if (instance.cellX !== vm.cellX || instance.cellY !== vm.cellY) {
        instance.cellX = vm.cellX;
        instance.cellY = vm.cellY;
        instance.root.position.set(vm.cellX + 0.5, 0, vm.cellY + 0.5);
      }
    }

    for (const [extractorId, instance] of this.instances) {
      if (instance.seenAtSync !== this.syncCounter) {
        this.despawn(extractorId, instance);
        continue;
      }
      instance.mixer.update(dtSeconds);
      this.applyTint(instance, timeMs);
    }
  }

  /** Cursor pick against live extractor meshes (input radial/hover path). */
  pickAtScreenPoint(camera: Camera, screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): ExtractorPickResult | null {
    if (viewportWidth <= 0 || viewportHeight <= 0 || this.pickMeshes.length === 0) return null;
    this.pickPoint.set(screenX / viewportWidth * 2 - 1, -(screenY / viewportHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.pickPoint, camera);
    const hits = this.raycaster.intersectObjects(this.pickMeshes, false);
    for (const hit of hits) {
      const pick = this.pickResultByMesh.get(hit.object);
      if (pick) return pick;
    }
    return null;
  }

  dispose(): void {
    for (const [extractorId, instance] of this.instances) {
      this.despawn(extractorId, instance);
    }
    for (const asset of this.assets.values()) {
      asset.template.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        disposeMeshMaterial(object);
      });
    }
    this.assets.clear();
    this.scene.remove(this.group);
  }

  private requestAsset(category: string): void {
    if (this.assetsRequested.has(category) || this.assetsFailed.has(category)) return;
    this.assetsRequested.add(category);
    const url = EXTRACTOR_GLBS[category] || "/assets/world-items/extractor_mineral.glb";
    this.loader
      .loadAsync(requireRuntimePublicPath(url))
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        tmpBox.setFromObject(gltf.scene);
        tmpBox.getCenter(tmpCenter);
        gltf.scene.position.x -= tmpCenter.x;
        gltf.scene.position.z -= tmpCenter.z;
        gltf.scene.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          object.material = toUnlitMaterial(object);
        });
        this.assets.set(category, { template: gltf.scene, clips: gltf.animations });
      })
      .catch((error: unknown) => {
        this.assetsFailed.add(category);
        console.error(`placed extractors: failed to load ${url}`, error);
      });
  }

  private spawn(vm: ServerAuthorityPlacedExtractorState, asset: LoadedExtractorAsset, category: string): ExtractorInstance {
    const root = asset.template.clone(true);
    root.position.set(vm.cellX + 0.5, 0, vm.cellY + 0.5);
    root.rotation.y = hashYaw(vm.extractorId);
    root.scale.setScalar(EXTRACTOR_WORLD_SCALE);
    this.group.add(root);

    // One tintable material per instance, shared by its meshes — the whole
    // device breathes as one object (palette texture stays shared).
    const material = new MeshBasicMaterial();
    const meshes: Mesh[] = [];
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (meshes.length === 0) {
        const source = firstMaterialOf(object);
        if (source instanceof MeshBasicMaterial) material.copy(source);
      }
      object.material = material;
      markSunShadowCaster(object);
      meshes.push(object);
    });

    const mixer = new AnimationMixer(root);
    const crankClip = asset.clips.find((clip) => clip.name === CRANK_CLIP) ?? null;
    const runClip = asset.clips.find((clip) => clip.name === RUN_CLIP) ?? null;
    const instance: ExtractorInstance = {
      root,
      mixer,
      crank: crankClip ? mixer.clipAction(crankClip) : null,
      run: runClip ? mixer.clipAction(runClip) : null,
      material,
      meshes,
      mode: "idle",
      hopperPct: vm.hopperPct,
      isOwner: vm.isOwner,
      label: extractorDeviceLabelForFamily(vm.familyLabel),
      cellX: vm.cellX,
      cellY: vm.cellY,
      seenAtSync: this.syncCounter,
    };
    const pick: ExtractorPickResult = {
      extractorId: vm.extractorId,
      label: instance.label,
      isOwner: vm.isOwner,
    };
    for (const mesh of meshes) {
      this.pickMeshes.push(mesh);
      this.instanceByMesh.set(mesh, instance);
      this.pickResultByMesh.set(mesh, pick);
    }
    if (vm.mode !== "idle") this.applyMode(instance, vm.mode);
    return instance;
  }

  private despawn(extractorId: string, instance: ExtractorInstance): void {
    instance.mixer.stopAllAction();
    this.group.remove(instance.root);
    instance.material.dispose();
    for (const mesh of instance.meshes) {
      const at = this.pickMeshes.indexOf(mesh);
      if (at >= 0) this.pickMeshes.splice(at, 1);
      this.instanceByMesh.delete(mesh);
      this.pickResultByMesh.delete(mesh);
    }
    // Geometry belongs to the shared template — never disposed per instance.
    this.instances.delete(extractorId);
  }

  private applyMode(instance: ExtractorInstance, mode: ServerAuthorityPlacedExtractorState["mode"]): void {
    instance.mode = mode;
    const play = mode === "manual" ? instance.crank : mode === "battery" ? instance.run : null;
    for (const action of [instance.crank, instance.run]) {
      if (!action) continue;
      if (action === play) {
        // NEVER gate on isRunning(): a completed fadeOut leaves the action
        // "running" at weight 0 forever, so a re-selected clip would skip
        // reset() and sit frozen. applyMode only fires on mode CHANGE, so
        // an unconditional reset+fadeIn never restarts a playing clip.
        action.reset().fadeIn(CLIP_FADE_SECONDS).play();
      } else {
        action.fadeOut(CLIP_FADE_SECONDS);
      }
    }
  }

  private applyTint(instance: ExtractorInstance, timeMs: number): void {
    if (instance.mode === "battery") {
      // Powered: faint warm breath — alive without a lamp.
      const wave = 0.5 + 0.5 * Math.sin(timeMs * 0.001 * Math.PI * 2 * RUN_PULSE_HZ);
      tmpColor.setRGB(1 + 0.10 * wave, 1 + 0.06 * wave, 1 + 0.02 * wave);
    } else if (instance.mode === "idle" && instance.hopperPct > 0) {
      // Stopped with yield waiting: slow amber breath between "asleep" dim
      // and a warm come-collect glow.
      const wave = 0.5 + 0.5 * Math.sin(timeMs * 0.001 * Math.PI * 2 * YIELD_PULSE_HZ);
      tmpColor.setRGB(0.82 + 0.30 * wave, 0.80 + 0.20 * wave, 0.76 + 0.08 * wave);
    } else {
      tmpColor.setRGB(1, 1, 1);
    }
    if (!instance.material.color.equals(tmpColor)) {
      instance.material.color.copy(tmpColor);
    }
  }
}

/** GLTF PBR → the world-prop unlit basic look (fog on, palette texture sRGB). */
function toUnlitMaterial(mesh: Mesh): MeshBasicMaterial {
  const source = firstMaterialOf(mesh);
  const material = new MeshBasicMaterial({ fog: true });
  if (source && "map" in source && source.map instanceof Texture) {
    source.map.colorSpace = SRGBColorSpace;
    material.map = source.map;
  }
  if (source && "color" in source && source.color instanceof Color) {
    material.color.copy(source.color);
  }
  material.name = source?.name ? `${source.name}:successor-basic` : "successor-basic-extractor";
  return material;
}

function firstMaterialOf(mesh: Mesh): Material | null {
  const raw = mesh.material;
  return Array.isArray(raw) ? raw[0] ?? null : raw ?? null;
}

function disposeMeshMaterial(mesh: Mesh): void {
  const raw = mesh.material;
  if (Array.isArray(raw)) {
    for (const material of raw) material.dispose();
  } else {
    raw.dispose();
  }
}

/** FNV-1a yaw hash — the props renderer's deterministic randomYaw, shared voice. */
function hashYaw(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 3600) * (Math.PI / 1800);
}
