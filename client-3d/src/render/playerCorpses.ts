import {
  BoxGeometry,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector2,
  type Camera,
  type Scene,
} from "three";
import type { PlayState, ServerAuthorityPlayerCorpseState } from "@successor/client/src/slice-core/gameState";
import { markSunShadowCaster } from "./environment/sunShadow";

/**
 * Player corpse bags — lightweight world props for the AOI-scoped
 * `serverAuthority.playerCorpses` projection (full-replace list, placedCamps
 * reconcile pattern): spawn on first sight, follow position, despawn the
 * frame the row leaves the stream (looted empty, expired at 120 minutes, or
 * simply out of AOI).
 *
 * The bag is BUILT-IN geometry on purpose (no GLB fetch, no load race — a
 * corpse must be visible the instant the projection lands): a flat-lying
 * capsule body bag in graphite with two strap bands and a small brass tag
 * plate, all MeshBasicMaterial per the unlit world grade. Geometry and
 * materials are module-shared; each corpse is a cheap Group of three meshes.
 * Nothing animates — the bag is a fact, not a spectacle (calm/reduced-motion
 * contract).
 *
 * YOUR bag (`isOwner`) swaps straps + tag to the shared amber accent (the
 * datapad/storm amber) so a battlefield of bags reads at a glance: the body
 * shell stays graphite for everyone — the accent says "yours", it never
 * turns the corpse into a beacon.
 *
 * Picking mirrors PlacedCampsRenderer: raycast over live bag meshes, the
 * result carries what input routing needs (loot target id + honest facts).
 */

export interface PlayerCorpsePickResult {
  corpseId: string;
  ownerLabel: string;
  isOwner: boolean;
  hasItems: boolean;
  creditsPresent: boolean;
  expiryTick: number;
}

/** Bag footprint in cells: pawn-length lying capsule, readable from iso. */
const BAG_LENGTH_CELLS = 1.35;
const BAG_RADIUS_CELLS = 0.26;
const STRAP_INSET_CELLS = 0.3;

const bagGeometry = new CapsuleGeometry(BAG_RADIUS_CELLS, BAG_LENGTH_CELLS - BAG_RADIUS_CELLS * 2, 3, 10);
const strapGeometry = new BoxGeometry(0.045, BAG_RADIUS_CELLS * 2.08, BAG_RADIUS_CELLS * 2.08);
const tagGeometry = new BoxGeometry(0.16, 0.02, 0.12);

const bagMaterial = new MeshBasicMaterial({ color: 0x2b2e31, fog: true });
const strapMaterial = new MeshBasicMaterial({ color: 0x17191b, fog: true });
const tagMaterial = new MeshBasicMaterial({ color: 0xb08d57, fog: true });
/** Own-corpse accent — the established amber (storm/datapad family). */
export const OWN_CORPSE_TAG_COLOR = 0xe8b240;
export const OWN_CORPSE_STRAP_COLOR = 0x8a6420;
const ownerStrapMaterial = new MeshBasicMaterial({ color: OWN_CORPSE_STRAP_COLOR, fog: true });
const ownerTagMaterial = new MeshBasicMaterial({ color: OWN_CORPSE_TAG_COLOR, fog: true });

interface CorpseInstance {
  root: Group;
  meshes: Mesh[];
  straps: Mesh[];
  tag: Mesh;
  isOwner: boolean;
  pick: PlayerCorpsePickResult;
  x: number;
  y: number;
  seenAtSync: number;
}

export class PlayerCorpsesRenderer {
  private readonly group = new Group();
  private readonly instances = new Map<string, CorpseInstance>();
  private readonly raycaster = new Raycaster();
  private readonly pickPoint = new Vector2();
  private readonly pickMeshes: Mesh[] = [];
  private readonly pickResultByMesh = new Map<Mesh, PlayerCorpsePickResult>();
  private syncCounter = 0;

  constructor(private readonly scene: Scene) {
    this.group.name = "player-corpses";
    this.scene.add(this.group);
  }

  /** Per-frame: reconcile the streamed AOI list (stale rows despawn). */
  update(state: PlayState): void {
    const list = state.serverAuthority.playerCorpses;
    if (list.length === 0 && this.instances.size === 0) return;
    this.syncCounter += 1;
    for (const vm of list) {
      if (vm.areaId !== state.activeAreaId) continue;
      let instance = this.instances.get(vm.id);
      if (!instance) {
        instance = this.spawn(vm);
        this.instances.set(vm.id, instance);
      }
      instance.seenAtSync = this.syncCounter;
      instance.pick.ownerLabel = vm.ownerLabel;
      instance.pick.isOwner = vm.isOwner;
      instance.pick.hasItems = vm.hasItems;
      instance.pick.creditsPresent = vm.creditsPresent;
      instance.pick.expiryTick = vm.expiryTick;
      if (instance.isOwner !== vm.isOwner) {
        instance.isOwner = vm.isOwner;
        applyOwnerAccent(instance);
      }
      if (instance.x !== vm.x || instance.y !== vm.y) {
        instance.x = vm.x;
        instance.y = vm.y;
        instance.root.position.set(vm.x + 0.5, 0, vm.y + 0.5);
      }
    }
    for (const [corpseId, instance] of this.instances) {
      if (instance.seenAtSync !== this.syncCounter) this.despawn(corpseId, instance);
    }
  }

  /** Cursor pick against live bag meshes (loot/radial routing). */
  pickAtScreenPoint(camera: Camera, screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): PlayerCorpsePickResult | null {
    if (viewportWidth <= 0 || viewportHeight <= 0 || this.pickMeshes.length === 0) return null;
    this.pickPoint.set(screenX / viewportWidth * 2 - 1, -(screenY / viewportHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.pickPoint, camera);
    const hits = this.raycaster.intersectObjects(this.pickMeshes, false);
    for (const hit of hits) {
      const pick = this.pickResultByMesh.get(hit.object as Mesh);
      if (pick) return pick;
    }
    return null;
  }

  /** Live corpse ids in the scene (probe/test seam). */
  liveCorpseIds(): string[] {
    return [...this.instances.keys()];
  }

  dispose(): void {
    for (const [corpseId, instance] of this.instances) {
      this.despawn(corpseId, instance);
    }
    // Geometry/materials are module-shared across renderer lifetimes — kept.
    this.scene.remove(this.group);
  }

  private spawn(vm: ServerAuthorityPlayerCorpseState): CorpseInstance {
    const root = new Group();
    root.name = `player-corpse:${vm.id}`;
    root.position.set(vm.x + 0.5, 0, vm.y + 0.5);
    // Deterministic yaw off the id so a corpse field never reads as a grid.
    root.rotation.y = (hashId(vm.id) % 628) / 100;

    const bag = new Mesh(bagGeometry, bagMaterial);
    bag.name = "bag";
    bag.rotation.z = Math.PI / 2; // capsule lies flat along local X
    bag.position.y = BAG_RADIUS_CELLS * 0.82; // slight ground sink, no float
    bag.scale.y = 0.62; // squashed profile — a bag, not a pipe

    const strapA = new Mesh(strapGeometry, strapMaterial);
    strapA.name = "strap";
    strapA.position.set(-(BAG_LENGTH_CELLS / 2 - STRAP_INSET_CELLS), BAG_RADIUS_CELLS * 0.82, 0);
    strapA.scale.y = 0.64;
    const strapB = new Mesh(strapGeometry, strapMaterial);
    strapB.name = "strap";
    strapB.position.set(BAG_LENGTH_CELLS / 2 - STRAP_INSET_CELLS, BAG_RADIUS_CELLS * 0.82, 0);
    strapB.scale.y = 0.64;

    const tag = new Mesh(tagGeometry, tagMaterial);
    tag.name = "tag";
    tag.position.set(-(BAG_LENGTH_CELLS / 2 - STRAP_INSET_CELLS), BAG_RADIUS_CELLS * 1.36, 0);

    const meshes = [bag, strapA, strapB, tag];
    for (const mesh of meshes) {
      markSunShadowCaster(mesh);
      root.add(mesh);
    }
    this.group.add(root);

    const pick: PlayerCorpsePickResult = {
      corpseId: vm.id,
      ownerLabel: vm.ownerLabel,
      isOwner: vm.isOwner,
      hasItems: vm.hasItems,
      creditsPresent: vm.creditsPresent,
      expiryTick: vm.expiryTick,
    };
    for (const mesh of meshes) {
      this.pickMeshes.push(mesh);
      this.pickResultByMesh.set(mesh, pick);
    }
    const instance: CorpseInstance = {
      root,
      meshes,
      straps: [strapA, strapB],
      tag,
      isOwner: vm.isOwner,
      pick,
      x: vm.x,
      y: vm.y,
      seenAtSync: this.syncCounter,
    };
    applyOwnerAccent(instance);
    return instance;
  }

  private despawn(corpseId: string, instance: CorpseInstance): void {
    this.group.remove(instance.root);
    for (const mesh of instance.meshes) {
      const at = this.pickMeshes.indexOf(mesh);
      if (at >= 0) this.pickMeshes.splice(at, 1);
      this.pickResultByMesh.delete(mesh);
    }
    this.instances.delete(corpseId);
  }
}

/** Straps + tag carry the ownership read; the bag shell never changes. */
function applyOwnerAccent(instance: CorpseInstance): void {
  for (const strap of instance.straps) {
    strap.material = instance.isOwner ? ownerStrapMaterial : strapMaterial;
  }
  instance.tag.material = instance.isOwner ? ownerTagMaterial : tagMaterial;
}

function hashId(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}
