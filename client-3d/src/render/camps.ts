import {
  Box3,
  Color,
  Mesh,
  MeshBasicMaterial,
  Group,
  Raycaster,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { PlayState, ServerAuthorityPlacedCampState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { buildMovementBlockers } from "@successor/client/src/slice-core/worldQueries";
import {
  CAMP_SHELTER_FOOTPRINT_CELLS,
  clearCampDoorState,
  setCampDoorOpen,
} from "@successor/client/src/slice-core/campSystem";
import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";
import { markSunShadowCaster } from "./environment/sunShadow";

/**
 * Placed scout camps — dynamic authority entities (car-6 camp wire), NOT
 * area props. `serverAuthority.placedCamps` is a full-replace list
 * (placedExtractors pattern), reconciled per frame: spawn on first sight,
 * despawn on removal (pack-up / abandonment collapse).
 *
 * Each camp is a deep clone of the pod-tent GLB (podtent_scout, 996 tris,
 * hand-author lane 2026-07-08) placed on the authority's 5x5-cell base
 * shelter footprint at yaw 0 —
 * rotation stays zero because the collision sidecar pipeline is unrotated
 * (structureCollisionFromSidecar contract) and the door face (+Z, the house
 * front convention) reads toward the iso camera.
 *
 * THE DOOR is the pod's charm and it is AUTOMATIC: the panel slides open for
 * any approaching pawn (high-tech shelter grammar — walk up, pssht, walk in)
 * and seals behind them. That matches sim truth: the shelter exemption
 * covers ANYONE inside the camp box, so the tent never plays bouncer. The
 * drive is the house door's exact DNA — `door_slide` node translated along
 * the authored axis by the authored distance over the authored 0.8 s, eased
 * — see the manifest's door block (asserted against house_h1 at build time).
 * The client-side door BLOCKER drops once the panel is half open and
 * re-arms as it seals, so the doorway is exactly as passable as it looks.
 *
 * ROOF-PEEL mirrors the shelter house: standing inside the tent hides the
 * `roof__*` band (manifest cutaway.hide) for the local player.
 *
 * THE FIRE: every standing camp keeps a small always-on campfire beside and
 * in front of the +Z doorway (CampfireFx — the "campfire always on kind of
 * fire" owner brief), OUTSIDE the 5x5 shelter footprint with clearance so the
 * pit never burns inside the tent, and clear of the door walk axis. It is the
 * live-camp beacon and drives the existing crackle audio loop for free. The
 * flame/smoke/spark FX stack sits on a shared static campfire-base model
 * (campfire_scout.glb — stone ring, charred logs, ember bed), one clone per
 * camp, loaded once and never per frame.
 */

export interface CampPickResult {
  campId: string;
  label: string;
  isOwner: boolean;
}

const CAMP_GLB_URL = "/assets/world-items/podtent_scout.glb";
/** Door contract (podtent_scout_manifest.json, == house_h1): node, local axis,
 * slide distance (GLB metres), and the 0.8 s authored slide. */
const DOOR_NODE = "door_slide";
const DOOR_AXIS_LOCAL = new Vector3(-1, 0, 0);
const DOOR_SLIDE_DISTANCE_M = 1.22;
const DOOR_SLIDE_SECONDS = 0.8;
/** Door face center in GLB-local metres (collision sidecar door box center). */
const DOOR_LOCAL_CENTER_X_M = 0.5;
const DOOR_LOCAL_CENTER_Z_M = 1.2075;
/** Auto-door trigger (cells from the door center), with closing hysteresis so
 * a pawn idling at the threshold never flutters the panel. */
const DOOR_OPEN_RADIUS_CELLS = 2.5;
const DOOR_CLOSE_RADIUS_CELLS = 2.85;
/** Blocker drops when the panel clears half the opening (a 0.3-radius pawn
 * fits through ≥0.6 m of clear width; the 1.22 m slide crosses that at ~0.5). */
const DOOR_PASSABLE_FRACTION = 0.5;
/** Local player inside the authority-sized tent rect → peel the roof band. */
const ROOF_PEEL_HALF_EXTENT_CELLS = CAMP_SHELTER_FOOTPRINT_CELLS / 2;
const ROOF_HIDE_PREFIX = "roof__";
/** Camp fire: outside the 5x5 footprint (half-extent 2.5 cells), beside/front
 * of the +Z door. X clears the door walk corridor (door center ~+0.88, clear
 * half-width ~0.93 → corridor edge ~1.81; fire model min-x = 2.45 - 0.62 =
 * 1.83) and Z gives the scaled model (~0.62-cell radius) ~0.23 cells of
 * clearance off the tent face at Z 2.5. FX and base share the same anchor. */
const FIRE_OFFSET_X_CELLS = 2.45;
const FIRE_OFFSET_Z_CELLS = 3.35;
/** Campfire base model (campfire_scout_manifest.json): authored ~1.07 m
 * diameter, grounded at y=0; modest iso-readability upscale (extractor
 * pattern). PBR maps are embedded per the Kiln asset bar; the world grade is
 * unlit, so the asset's BaseColor carries the read (AO folded in, ember
 * emissive screened on top at bake time) — see toUnlitMaterial below. */
const CAMPFIRE_GLB_URL = "/assets/world-items/campfire_scout.glb";
const CAMPFIRE_WORLD_SCALE = 1.15;

interface CampInstance {
  root: Object3D;
  meshes: Mesh[];
  roofMeshes: Mesh[];
  roofHidden: boolean;
  doorNode: Object3D | null;
  doorClosedPosition: Vector3;
  /** 0 = sealed, 1 = parked in the pocket. */
  doorT: number;
  doorTarget: 0 | 1;
  doorBlockerOpen: boolean;
  /** Shared campfire-base clone (null until the template resolves). */
  fireRoot: Object3D | null;
  campId: string;
  areaId: string;
  cellX: number;
  cellY: number;
  isOwner: boolean;
  seenAtSync: number;
}

export interface CampFireSink {
  set(id: string, x: number, y: number, z: number): void;
  remove(id: string): void;
}

const tmpBox = new Box3();
const tmpCenter = new Vector3();

export class PlacedCampsRenderer {
  private readonly group = new Group();
  private readonly loader = new GLTFLoader();
  private readonly instances = new Map<string, CampInstance>();
  private readonly raycaster = new Raycaster();
  private readonly pickPoint = new Vector2();
  private readonly pickMeshes: Mesh[] = [];
  private readonly pickResultByMesh = new Map<Object3D, CampPickResult>();
  private template: Object3D | null = null;
  private templateScale = 1;
  private fireTemplate: Object3D | null = null;
  private assetRequested = false;
  private assetFailed = false;
  private syncCounter = 0;
  /** Positional door-slide audio hook (wired by the app, mirrors deflect). */
  onDoorSlide: ((x: number, y: number) => void) | null = null;

  constructor(private readonly scene: Scene, private readonly fire: CampFireSink) {
    this.group.name = "placed-camps";
    this.scene.add(this.group);
  }

  /** Per-frame: reconcile the streamed list, drive doors/peel, keep the fire. */
  update(slice: SliceSnapshot, state: PlayState, dtSeconds: number): void {
    const list = state.serverAuthority.placedCamps;
    if (list.length === 0 && this.instances.size === 0) return;
    if (!this.template) {
      if (list.length > 0) this.requestAsset();
      return;
    }

    this.syncCounter += 1;
    for (const vm of list) {
      if (vm.areaId !== state.activeAreaId) continue;
      let instance = this.instances.get(vm.campId);
      if (!instance) {
        instance = this.spawn(vm);
        this.instances.set(vm.campId, instance);
      }
      instance.seenAtSync = this.syncCounter;
      instance.isOwner = vm.isOwner;
      if (instance.cellX !== vm.cellX || instance.cellY !== vm.cellY) {
        instance.cellX = vm.cellX;
        instance.cellY = vm.cellY;
        instance.root.position.set(vm.cellX + 0.5, 0, vm.cellY + 0.5);
        instance.fireRoot?.position.set(vm.cellX + 0.5 + FIRE_OFFSET_X_CELLS, 0, vm.cellY + 0.5 + FIRE_OFFSET_Z_CELLS);
        this.fire.set(fireIdFor(vm.campId), vm.cellX + 0.5 + FIRE_OFFSET_X_CELLS, 0, vm.cellY + 0.5 + FIRE_OFFSET_Z_CELLS);
      }
      // Campfire base resolves independently of the tent: attach late.
      if (!instance.fireRoot && this.fireTemplate) this.attachFireBase(instance);
    }

    let collisionDirty = false;
    for (const [campId, instance] of this.instances) {
      if (instance.seenAtSync !== this.syncCounter) {
        this.despawn(campId, instance);
        collisionDirty = true;
        continue;
      }
      if (this.driveDoor(instance, state, dtSeconds)) collisionDirty = true;
      this.applyRoofPeel(instance, state);
    }
    if (collisionDirty) {
      // Camp walls/door live inside the shared movement-blocker set; rebuild
      // exactly when a door crosses passable or a camp despawns (delta applies
      // rebuild on their own cadence for spawns/moves).
      state.movementBlockers = buildMovementBlockers(slice, state.activeAreaId, state.serverAuthority.propStates ?? {}, list);
    }
  }

  /** Cursor pick against live camp meshes (radial / hover paths). */
  pickAtScreenPoint(camera: Camera, screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): CampPickResult | null {
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

  /** Live door states for the debug probe (Harness3D door proof). */
  debugDoorStates(): Record<string, { open: boolean; t: number }> {
    const out: Record<string, { open: boolean; t: number }> = {};
    for (const [campId, instance] of this.instances) {
      out[campId] = { open: instance.doorTarget === 1, t: Number(instance.doorT.toFixed(3)) };
    }
    return out;
  }

  dispose(): void {
    for (const [campId, instance] of this.instances) {
      this.despawn(campId, instance);
    }
    if (this.template) {
      this.template.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        disposeMeshMaterial(object);
      });
      this.template = null;
    }
    if (this.fireTemplate) {
      this.fireTemplate.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        disposeMeshMaterial(object);
      });
      this.fireTemplate = null;
    }
    this.scene.remove(this.group);
  }

  private requestAsset(): void {
    if (this.assetRequested || this.assetFailed) return;
    this.assetRequested = true;
    this.loader
      .loadAsync(requireRuntimePublicPath(CAMP_GLB_URL))
      .then((gltf) => {
        // Flatten to the world-prop unlit basic look (PS2 grade owns light)
        // and recentre the footprint so the authored center sits on the cell
        // center (authored bbox is exactly ±1.425 — the recentre also guards
        // against future asset drift).
        gltf.scene.updateMatrixWorld(true);
        tmpBox.setFromObject(gltf.scene);
        tmpBox.getCenter(tmpCenter);
        gltf.scene.position.x -= tmpCenter.x;
        gltf.scene.position.z -= tmpCenter.z;
        const spanX = tmpBox.max.x - tmpBox.min.x;
        const spanZ = tmpBox.max.z - tmpBox.min.z;
        this.templateScale = Math.min(
          CAMP_SHELTER_FOOTPRINT_CELLS / Math.max(1e-6, spanX),
          CAMP_SHELTER_FOOTPRINT_CELLS / Math.max(1e-6, spanZ),
        );
        gltf.scene.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          object.material = toUnlitMaterial(object);
        });
        this.template = gltf.scene;
      })
      .catch((error: unknown) => {
        this.assetFailed = true;
        console.error("placed camps: failed to load podtent_scout.glb", error);
      });
    this.loader
      .loadAsync(requireRuntimePublicPath(CAMPFIRE_GLB_URL))
      .then((gltf) => {
        // Same world-grade flattening as the tent: the campfire base ships
        // full Kiln-bar PBR (BaseColor/Normal/ORM/Emissive), and its
        // BaseColor is authored to carry the unlit read (AO folded in, ember
        // emissive screened on top at bake time) — toUnlitMaterial keeps
        // exactly that map, so nothing load-bearing is lost. Recentre XZ and
        // sit the authored y-min on the ground (asset gate holds it at ~0,
        // the recentre guards future drift).
        gltf.scene.updateMatrixWorld(true);
        tmpBox.setFromObject(gltf.scene);
        tmpBox.getCenter(tmpCenter);
        gltf.scene.position.x -= tmpCenter.x;
        gltf.scene.position.z -= tmpCenter.z;
        gltf.scene.position.y -= tmpBox.min.y;
        gltf.scene.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          object.material = toUnlitMaterial(object);
        });
        this.fireTemplate = gltf.scene;
      })
      .catch((error: unknown) => {
        // Camps stay functional without the base model; the FX fire remains.
        console.error("placed camps: failed to load campfire_scout.glb", error);
      });
  }

  private spawn(vm: ServerAuthorityPlacedCampState): CampInstance {
    const template = this.template;
    if (!template) throw new Error("camp asset not loaded");
    const holder = new Group();
    holder.position.set(vm.cellX + 0.5, 0, vm.cellY + 0.5);
    holder.scale.setScalar(this.templateScale);
    const body = template.clone(true);
    holder.add(body);
    this.group.add(holder);

    const meshes: Mesh[] = [];
    const roofMeshes: Mesh[] = [];
    body.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      markSunShadowCaster(object);
      meshes.push(object);
      if (object.name.startsWith(ROOF_HIDE_PREFIX)) roofMeshes.push(object);
    });

    const doorNode = body.getObjectByName(DOOR_NODE) ?? null;
    if (!doorNode) console.warn(`placed camps: door node "${DOOR_NODE}" missing in podtent_scout.glb`);

    const instance: CampInstance = {
      root: holder,
      meshes,
      roofMeshes,
      roofHidden: false,
      doorNode,
      doorClosedPosition: doorNode ? doorNode.position.clone() : new Vector3(),
      doorT: 0,
      doorTarget: 0,
      doorBlockerOpen: false,
      fireRoot: null,
      campId: vm.campId,
      areaId: vm.areaId,
      cellX: vm.cellX,
      cellY: vm.cellY,
      isOwner: vm.isOwner,
      seenAtSync: this.syncCounter,
    };
    const pick: CampPickResult = { campId: vm.campId, label: "Scout Camp", isOwner: vm.isOwner };
    for (const mesh of meshes) {
      this.pickMeshes.push(mesh);
      this.pickResultByMesh.set(mesh, pick);
    }
    this.fire.set(fireIdFor(vm.campId), vm.cellX + 0.5 + FIRE_OFFSET_X_CELLS, 0, vm.cellY + 0.5 + FIRE_OFFSET_Z_CELLS);
    if (this.fireTemplate) this.attachFireBase(instance);
    return instance;
  }

  private despawn(campId: string, instance: CampInstance): void {
    this.group.remove(instance.root);
    if (instance.fireRoot) {
      this.group.remove(instance.fireRoot);
      instance.fireRoot = null;
    }
    for (const mesh of instance.meshes) {
      const at = this.pickMeshes.indexOf(mesh);
      if (at >= 0) this.pickMeshes.splice(at, 1);
      this.pickResultByMesh.delete(mesh);
    }
    // Geometry/materials belong to the shared template — never disposed here.
    this.fire.remove(fireIdFor(campId));
    clearCampDoorState(campId);
    this.instances.delete(campId);
  }

  /** One shared-template campfire-base clone, anchored under the FX fire. */
  private attachFireBase(instance: CampInstance): void {
    const template = this.fireTemplate;
    if (!template) return;
    const holder = new Group();
    holder.position.set(instance.cellX + 0.5 + FIRE_OFFSET_X_CELLS, 0, instance.cellY + 0.5 + FIRE_OFFSET_Z_CELLS);
    holder.scale.setScalar(CAMPFIRE_WORLD_SCALE);
    const body = template.clone(true);
    holder.add(body);
    body.traverse((object) => {
      if (object instanceof Mesh) markSunShadowCaster(object);
    });
    this.group.add(holder);
    instance.fireRoot = holder;
  }

  /**
   * Auto-door: open while any alive pawn stands near the door face, sealed
   * otherwise; the movement blocker tracks the PANEL, not the intent.
   * Returns true when the passable state flipped (collision rebuild due).
   */
  private driveDoor(instance: CampInstance, state: PlayState, dtSeconds: number): boolean {
    if (!instance.doorNode) return false;
    const doorX = instance.cellX + 0.5 + DOOR_LOCAL_CENTER_X_M * this.templateScale;
    const doorY = instance.cellY + 0.5 + DOOR_LOCAL_CENTER_Z_M * this.templateScale;
    const radius = instance.doorTarget === 1 ? DOOR_CLOSE_RADIUS_CELLS : DOOR_OPEN_RADIUS_CELLS;
    const wantOpen = anyPawnNear(state, instance.areaId, doorX, doorY, radius);
    if ((instance.doorTarget === 1) !== wantOpen) {
      instance.doorTarget = wantOpen ? 1 : 0;
      this.onDoorSlide?.(doorX, doorY);
    }
    if (instance.doorT !== instance.doorTarget) {
      const step = dtSeconds / DOOR_SLIDE_SECONDS;
      instance.doorT = instance.doorTarget === 1
        ? Math.min(1, instance.doorT + step)
        : Math.max(0, instance.doorT - step);
      const eased = instance.doorT * instance.doorT * (3 - 2 * instance.doorT);
      instance.doorNode.position
        .copy(instance.doorClosedPosition)
        .addScaledVector(DOOR_AXIS_LOCAL, DOOR_SLIDE_DISTANCE_M * eased);
    }
    const passable = instance.doorT >= DOOR_PASSABLE_FRACTION;
    if (passable !== instance.doorBlockerOpen) {
      instance.doorBlockerOpen = passable;
      setCampDoorOpen(instance.campId, passable);
      return true;
    }
    return false;
  }

  /** Iso roof-peel: hide the roof band while the local player is inside. */
  private applyRoofPeel(instance: CampInstance, state: PlayState): void {
    const inside = state.activeAreaId === instance.areaId
      && Math.abs(state.player.x + 0.5 - (instance.cellX + 0.5)) <= ROOF_PEEL_HALF_EXTENT_CELLS
      && Math.abs(state.player.y + 0.5 - (instance.cellY + 0.5)) <= ROOF_PEEL_HALF_EXTENT_CELLS;
    if (inside === instance.roofHidden) return;
    instance.roofHidden = inside;
    for (const mesh of instance.roofMeshes) mesh.visible = !inside;
  }
}

/** Any alive pawn (local prediction or streamed actor) within reach of a point. */
function anyPawnNear(state: PlayState, areaId: string, x: number, y: number, radiusCells: number): boolean {
  if (state.activeAreaId === areaId) {
    const dx = state.player.x + 0.5 - x;
    const dy = state.player.y + 0.5 - y;
    if (dx * dx + dy * dy <= radiusCells * radiusCells) return true;
  }
  const localId = state.serverAuthority.playerActorId ?? state.playerActorId;
  for (const actor of Object.values(state.serverAuthority.actors)) {
    if (actor.id === localId || actor.areaId !== areaId || actor.lifeState !== "alive") continue;
    const ax = (actor.renderX ?? actor.x) + 0.5 - x;
    const ay = (actor.renderY ?? actor.y) + 0.5 - y;
    if (ax * ax + ay * ay <= radiusCells * radiusCells) return true;
  }
  return false;
}

function fireIdFor(campId: string): string {
  return `camp-fire:${campId}`;
}

/** GLTF PBR → the world-prop unlit basic look (fog on, colors sRGB). */
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
  material.name = source?.name ? `${source.name}:successor-basic` : "successor-basic-camp";
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
