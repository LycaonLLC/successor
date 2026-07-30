import {
  Color,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshMatcapMaterial,
  OrthographicCamera,
  Scene,
  SkinnedMesh,
  Texture,
  type Object3D,
  type WebGLRenderer,
} from "three";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  equipmentSourceMaterialFromUserData,
  getEquipmentMaterialSets,
  resolveEquipmentSlotMaterial,
  type EquipmentSlotMaterialSource,
} from "../../assets/equipmentMaterials";
import { installPawnRim } from "../../render/pawnRim";
import {
  clonePawnBody,
  cloneSpecialPawnBody,
  type PawnBody,
  type PawnEquipmentItem,
  type PawnPack,
} from "../../assets/pawnPack";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { weaponModelAssetKey } from "../../assets/weaponModelRegistry";
import {
  ACTOR_PREVIEW_AUTHORED_CAMERA as AUTHORED_CAMERA,
  type ActorPreviewCameraBounds,
  writeActorPreviewCameraBounds,
} from "./previewCamera";
import { MaskedClipCache } from "../../render/anim/maskedClips";
import { PawnAnimator } from "../../render/anim/PawnAnimator";
import {
  attachPawnEquipmentSet,
  createPawnMatcapTexture,
  defaultRemotePawnEquipmentIds,
  isPlayerRoleActor,
  equippedWeaponIdForActor,
  pawnBodyForActor,
  resolveRifleBaseLaneAvailable,
  specialPawnBodyKeyForActor,
  weaponLaneForActor as resolveActorWeaponLane,
  type RenderActor,
} from "../../render/pawns";
import { resolveAuthoritativeActorEquipmentIds } from "../../render/equipmentSlots";
import { attachPawnFaceDecal, faceSignature, type PawnFaceConfig } from "../../render/faceDecal";
import { clampTurntableZoom } from "../turntableInteraction";
import { SlugthrowerRig } from "../../render/weapons/slugthrowerRig";
import { SwordRig } from "../../render/weapons/swordRig";
import { resolveWieldPose } from "./wieldPose";

export interface ActorPreviewRenderVM {
  open: boolean;
  actorId: string | null;
  actor: RenderActor | null;
  state: PlayState;
  slice: SliceSnapshot;
}

const BASE_SKIN_COLOR = "#cc9978";
const GUN_GRIP_HAND_CLIP = "gun_grip_trigger_discipline";
const SKIN_TONE_PATTERN = /^#[0-9a-f]{6}$/iu;
const HAIR_MATERIAL_PATTERN = /^hair_[a-z0-9_]{1,64}$/u;
const HAIR_IDENTIFIER_PATTERN = /^hair_[a-z0-9_]{1,64}$/u;
type ActorPreviewWeaponLane = "none" | "rifle" | "melee";

/**
 * Everything the preview mannequin renders from, resolved ONCE per frame and
 * hashed into `signature`. The portrait cache keys on the same signature, so
 * a bust can never render stale gear/skin/weapon state (earlier sandbox design semantics: the
 * preview always shows the client's last-known appearance).
 */
export interface ActorPreviewLook {
  body: PawnBody;
  /** Authored NPC-only humanoid body; null keeps the ordinary player body. */
  specialBodyKey: string | null;
  equipmentIds: string[];
  weaponLane: ActorPreviewWeaponLane;
  weaponModelKey: string | null;
  weaponVisible: boolean;
  isDowned: boolean;
  holdWeapon: boolean;
  stowed: boolean;
  hairMaterialId: string | null;
  skinTone: string;
  /** Face-kit selection from the actor's appearance (wire shape). */
  face: PawnFaceConfig | null;
  /** item id -> zone colors from the actor's worn set (palette application). */
  wornColors: ReadonlyMap<string, readonly string[]> | null;
  signature: string;
}

function actorWornColorMap(actor: RenderActor): ReadonlyMap<string, readonly string[]> | null {
  const worn = "worn" in actor && Array.isArray(actor.worn) ? actor.worn : null;
  if (!worn || worn.length === 0) return null;
  return new Map(worn.map((piece) => [piece.item, piece.colors] as const));
}

export function resolveActorPreviewLook(
  pack: PawnPack,
  actorId: string,
  actor: RenderActor,
  _state: PlayState,
  slice: SliceSnapshot,
): ActorPreviewLook {
  const body = pawnBodyForActor(actorId, actor, slice);
  const specialBodyKey = specialPawnBodyKeyForActor(actorId, actor, slice);
  const equipmentIds = specialBodyKey
    ? []
    : isPlayerRoleActor(actor)
      ? resolveAuthoritativeActorEquipmentIds({
        availableIds: new Set(pack.equipment.items.map((item) => item.id)),
        authorityWornIds: "worn" in actor && Array.isArray(actor.worn)
          ? actor.worn.map((piece) => piece.item)
          : [],
        savedHairId: actorHairId(actor),
      })
      : defaultRemotePawnEquipmentIds(pack, actorId, actor);
  const isDowned = isActorDowned(actor);
  const weaponLane: ActorPreviewWeaponLane = specialBodyKey ? "none" : resolveActorWeaponLane(actor);
  const weaponModelKey = specialBodyKey ? null : weaponModelKeyForActor(actor);
  const weaponVisible = !specialBodyKey && weaponLane !== "none" && equippedWeaponIdForActor(actor) !== "unarmed";
  const pose = resolveWieldPose({
    armed: weaponLane !== "none",
    inCombat: actorInCombat(actor),
  });
  const hairMaterialId = actorHairMaterialId(actor);
  const skinTone = actorSkinTone(actor);
  const face = actorFaceConfig(actor);
  const wornColors = actorWornColorMap(actor);
  const wornKey = wornColors
    ? [...wornColors.entries()].map(([item, colors]) => `${item}:${colors.join("+")}`).join(",")
    : "";
  const signature = [
    actorId,
    body,
    specialBodyKey ?? "standard-body",
    equipmentIds.join(","),
    weaponLane,
    weaponModelKey ?? "builtin-weapon",
    weaponVisible ? "modeled" : "unmodeled",
    isDowned ? "downed" : "alive",
    hairMaterialId ?? "",
    skinTone,
    pose.holdWeapon ? "held" : pose.stowed ? "stowed" : "unheld",
    wornKey,
    `face:${faceSignature(face)}`,
  ].join("|");
  return {
    body,
    specialBodyKey,
    equipmentIds,
    weaponLane,
    weaponModelKey,
    weaponVisible,
    isDowned,
    holdWeapon: pose.holdWeapon,
    stowed: pose.stowed,
    hairMaterialId,
    skinTone,
    face,
    wornColors,
    signature,
  };
}


export class ActorPreviewRenderer {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(
    AUTHORED_CAMERA.left,
    AUTHORED_CAMERA.right,
    AUTHORED_CAMERA.top,
    AUTHORED_CAMERA.bottom,
    0.1,
    16,
  );
  private readonly root = new Group();
  private readonly maskedClips: MaskedClipCache;
  private readonly matcap: Texture;
  private readonly bodyMaterials = new Map<string, MeshMatcapMaterial>();
  private readonly specialBodyMaterials: Material[] = [];
  private readonly equipmentAttachments: Mesh[] = [];
  private currentSignature: string | null = null;
  private bodyRoot: Group | null = null;
  private animator: PawnAnimator | null = null;
  private slugthrowerRig: SlugthrowerRig | null = null;
  private swordRig: SwordRig | null = null;
  private holdingWeapon = false;
  private weaponStowed = false;
  // Pack convention: yaw-0 IS the rig's authored FRONT (pawnYaw.ts law).
  // The old π default framed every bust/examine preview from behind —
  // verified by tan-face-plane pixel probes at both yaws, booted and bare
  // (fe-polish P2, 2026-07-09).
  private yaw = 0;
  private zoom = 1;
  private equipmentMaterialGeneration = 0;
  private currentHairMaterialId: string | null = null;
  private currentWornColors: ReadonlyMap<string, readonly string[]> | null = null;
  private lastCameraViewportAspect = 0;
  private readonly cameraBoundsScratch: ActorPreviewCameraBounds = { ...AUTHORED_CAMERA };

  constructor(private readonly pack: PawnPack) {
    this.maskedClips = new MaskedClipCache();
    this.matcap = createPawnMatcapTexture();
    // WORLD-TRUE rig (owner taxonomy 2026-07-08): every material in this
    // scene is matcap — deliberately NO lights, so the mannequin is exactly
    // the in-world look. (The old module-singleton lights were inert for
    // matcap and stole themselves across scenes on a second instance.)
    this.scene.add(this.root);
    this.camera.position.set(0, 0.82, 4.15);
    this.camera.lookAt(0, 0.72, 0);
    this.prepareSharedWeaponMaterials();
  }

  getYaw(): number {
    return this.yaw;
  }

  setYaw(yaw: number): void {
    this.yaw = yaw;
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number): void {
    const next = clampTurntableZoom(zoom);
    if (next === this.zoom) return;
    this.zoom = next;
    this.camera.zoom = next;
    this.camera.updateProjectionMatrix();
  }

  render(renderer: WebGLRenderer, vm: ActorPreviewRenderVM, dtSeconds: number, _timeMs: number, width: number, height: number): void {
    if (!vm.open || !vm.actorId || !vm.actor) return;
    this.ensureActor(vm.actorId, vm.actor, vm.state, vm.slice);
    this.updateCameraForViewport(width, height);
    this.root.rotation.y = this.yaw;
    this.animator?.update(Math.min(0.05, Math.max(0, dtSeconds)));
    this.bodyRoot?.updateWorldMatrix(true, true);
    this.slugthrowerRig?.setStowed(this.weaponStowed);
    this.slugthrowerRig?.update(Math.min(0.05, Math.max(0, dtSeconds)), null, this.holdingWeapon ? "auto" : "off");
    this.swordRig?.setStowed(this.weaponStowed);
    this.swordRig?.update(Math.min(0.05, Math.max(0, dtSeconds)));

    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }

  private updateCameraForViewport(width: number, height: number): void {
    const viewportAspect = Math.max(1, width) / Math.max(1, height);
    if (Math.abs(viewportAspect - this.lastCameraViewportAspect) < 1e-4) return;
    this.lastCameraViewportAspect = viewportAspect;
    const bounds = writeActorPreviewCameraBounds(width, height, this.cameraBoundsScratch);
    this.camera.left = bounds.left;
    this.camera.right = bounds.right;
    this.camera.top = bounds.top;
    this.camera.bottom = bounds.bottom;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.clearActor();
    for (const material of this.bodyMaterials.values()) material.dispose();
    this.bodyMaterials.clear();
    this.matcap.dispose();
  }

  private ensureActor(actorId: string, actor: RenderActor, state: PlayState, slice: SliceSnapshot): void {
    const look = resolveActorPreviewLook(this.pack, actorId, actor, state, slice);
    if (look.signature === this.currentSignature) return;
    this.currentSignature = look.signature;
    this.rebuild(actorId, look);
  }

  private rebuild(actorId: string, look: ActorPreviewLook): void {
    this.clearActor();
    const bodyRoot = look.specialBodyKey
      ? cloneSpecialPawnBody(this.pack, look.specialBodyKey) ?? clonePawnBody(this.pack, look.body)
      : clonePawnBody(this.pack, look.body);
    const specialBodyLoaded = Boolean(look.specialBodyKey && this.pack.specialBodies.has(look.specialBodyKey));
    bodyRoot.name = `successor-examine-preview:${actorId}`;
    bodyRoot.rotation.set(0, 0, 0);
    const bodyScale = specialBodyLoaded && look.specialBodyKey
      ? SUCCESSOR_3D_CONFIG.pawnPack.heightTargetUnits
        / (this.pack.specialBodies.get(look.specialBodyKey)?.heightM ?? SUCCESSOR_3D_CONFIG.pawnPack.heightTargetUnits)
      : this.pack.scale;
    bodyRoot.scale.setScalar(bodyScale);
    const convertedSpecialMaterials = new Map<Material, Material>();
    bodyRoot.traverse((object) => {
      if (object instanceof SkinnedMesh || object instanceof Mesh) {
        object.frustumCulled = false;
        object.castShadow = false;
        object.receiveShadow = false;
      }
      if (object instanceof SkinnedMesh) {
        object.material = specialBodyLoaded
          ? Array.isArray(object.material)
            ? object.material.map((source) => this.specialBodyMaterial(source, convertedSpecialMaterials))
            : this.specialBodyMaterial(object.material, convertedSpecialMaterials)
          : this.bodyMaterial(look.skinTone);
      }
    });
    this.root.add(bodyRoot);
    this.bodyRoot = bodyRoot;
    const isArmed = look.weaponLane !== "none";
    const rifleArmed = look.weaponLane === "rifle";
    const swordArmed = look.weaponLane === "melee";
    const isDowned = look.isDowned;
    const holdWeapon = look.holdWeapon && !isDowned;
    const stowed = isArmed && (isDowned || look.stowed);
    this.holdingWeapon = holdWeapon;
    this.weaponStowed = stowed;
    this.currentHairMaterialId = look.hairMaterialId;
    this.currentWornColors = look.wornColors;
    this.animator = new PawnAnimator(bodyRoot, this.pack, this.maskedClips);
    // Death montage owns the body, so keep the pre-existing downed setup
    // path while live previews obey holdWeapon for rifle/melee base + hand grip.
    const poseUsesWeaponHold = isDowned ? isArmed : holdWeapon;
    const baseClip = poseUsesWeaponHold
      ? rifleArmed && resolveRifleBaseLaneAvailable(this.pack)
        ? "rifle_idle"
        : swordArmed && this.pack.clips.has("melee_idle")
          ? "melee_idle"
          : "idle"
      : "idle";
    const handClip = poseUsesWeaponHold
      ? rifleArmed && this.pack.clips.has(GUN_GRIP_HAND_CLIP)
        ? GUN_GRIP_HAND_CLIP
        : swordArmed && this.pack.clips.has("melee_grip")
          ? "melee_grip"
          : null
      : null;
    this.animator.setBase(baseClip, 1);
    this.animator.setHand(handClip);
    if (isDowned) this.animator.playMontage("death_b", { holdEnd: true, startAtEnd: true });

    if (!specialBodyLoaded) {
      attachPawnEquipmentSet(
        this.pack,
        bodyRoot,
        look.equipmentIds,
        (item, source) => this.equipmentMaterial(item, source),
        this.equipmentAttachments,
      );
      attachPawnFaceDecal(bodyRoot, look.face, this.equipmentAttachments);
    }
    const materialGeneration = ++this.equipmentMaterialGeneration;
    void getEquipmentMaterialSets().then(() => {
      if (materialGeneration !== this.equipmentMaterialGeneration || this.bodyRoot !== bodyRoot) return;
      this.refreshEquipmentMaterials();
    });

    if (this.animator && rifleArmed && look.weaponVisible) {
      const animator = this.animator;
      const handR = animator.bone("hand_r");
      if (handR) {
        const model = look.weaponModelKey ? this.pack.weapons.get(look.weaponModelKey) ?? null : null;
        this.slugthrowerRig = new SlugthrowerRig(
          this.pack,
          handR,
          animator.bone("upperarm_l"),
          animator.bone("lowerarm_l"),
          animator.bone("hand_l"),
          animator.bone("spine_03") ?? animator.bone("spine_02"),
          model?.spec,
          model?.scene,
          model?.scale,
        );
        this.slugthrowerRig.setVisible(true);
        this.slugthrowerRig.setStowed(stowed, { snap: true });
      }
    } else if (this.animator && swordArmed && look.weaponVisible) {
      const animator = this.animator;
      const handR = animator.bone("hand_r");
      if (handR) {
        const model = look.weaponModelKey ? this.pack.weapons.get(look.weaponModelKey) ?? null : null;
        this.swordRig = new SwordRig(
          this.pack,
          handR,
          animator.bone("spine_03") ?? animator.bone("spine_02"),
          model?.spec,
          model?.scene,
          model?.scale,
          model && look.weaponModelKey ? `melee:${look.weaponModelKey}` : "vibrosword",
        );
        this.swordRig.setVisible(true);
        this.swordRig.setStowed(stowed, { snap: true });
      }
    }
  }

  private clearActor(): void {
    this.equipmentMaterialGeneration += 1;
    this.slugthrowerRig?.dispose();
    this.slugthrowerRig = null;
    this.swordRig?.dispose();
    this.swordRig = null;
    this.animator?.dispose();
    this.animator = null;
    for (const attachment of this.equipmentAttachments) attachment.parent?.remove(attachment);
    this.equipmentAttachments.length = 0;
    if (this.bodyRoot) {
      this.bodyRoot.parent?.remove(this.bodyRoot);
      this.bodyRoot = null;
    }
    this.holdingWeapon = false;
    this.weaponStowed = false;
    this.currentHairMaterialId = null;
    for (const material of this.specialBodyMaterials) material.dispose();
    this.specialBodyMaterials.length = 0;
  }

  /** Preview-local mirror of the in-world special-body material policy. The
   * droid has authored colour zones but no texture images; core and optic zones
   * stay unlit while shell/joint zones use the same matcap as the mannequin. */
  private specialBodyMaterial(source: Material, cache: Map<Material, Material>): Material {
    const existing = cache.get(source);
    if (existing) return existing;
    const map = "map" in source && source.map instanceof Texture ? source.map : null;
    const baseColor = "color" in source && source.color instanceof Color
      ? source.color.clone()
      : new Color(0x8f9296);
    const emissive = "emissive" in source && source.emissive instanceof Color
      && source.emissive.r + source.emissive.g + source.emissive.b > 0.001
      ? source.emissive.clone()
      : null;
    const authoredName = source.name.split(":", 1)[0] ?? source.name;
    const unlit = source instanceof MeshBasicMaterial
      || authoredName === "DroidCore"
      || authoredName === "DroidOptic"
      || emissive !== null;
    const material = unlit
      ? new MeshBasicMaterial({ map, color: emissive ?? baseColor, toneMapped: false, side: source.side })
      : new MeshMatcapMaterial({ matcap: this.matcap, map, color: baseColor, side: source.side });
    material.name = `${authoredName || "special-body"}:successor-preview`;
    if (material instanceof MeshMatcapMaterial) installPawnRim(material);
    cache.set(source, material);
    this.specialBodyMaterials.push(material);
    return material;
  }

  private bodyMaterial(skinTone: string): MeshMatcapMaterial {
    const existing = this.bodyMaterials.get(skinTone);
    if (existing) return existing;
    // Examine is a character-fidelity surface, not a relationship indicator:
    // preserve the exact saved skin tone. Target/relation feedback belongs in
    // world selection and nameplate chrome, never painted over appearance.
    const material = new MeshMatcapMaterial({ matcap: this.matcap, color: new Color(skinTone) });
    material.name = `successor-examine-body:${skinTone}`;
    this.bodyMaterials.set(skinTone, material);
    return material;
  }

  private equipmentMaterial(item: PawnEquipmentItem, source: EquipmentSlotMaterialSource): Material | Material[] {
    const manifestMat = item.id.startsWith("hair_") && this.currentHairMaterialId ? this.currentHairMaterialId : item.mat;
    return resolveEquipmentSlotMaterial(source, item, manifestMat, { kind: "world", matcap: this.matcap }, this.currentWornColors?.get(item.id) ?? null);
  }

  private refreshEquipmentMaterials(): void {
    for (let i = 0; i < this.equipmentAttachments.length; i += 1) {
      const attachment = this.equipmentAttachments[i]!;
      if (!(attachment instanceof Mesh)) continue;
      const pieceId = typeof attachment.userData.successorEquipmentItemId === "string"
        ? attachment.userData.successorEquipmentItemId
        : null;
      if (!pieceId) continue;
      const item = this.pack.equipment.items.find((candidate) => candidate.id === pieceId);
      if (!item) continue;
      const manifestMat = pieceId.startsWith("hair_") && this.currentHairMaterialId ? this.currentHairMaterialId : item.mat;
      attachment.material = resolveEquipmentSlotMaterial(
        equipmentSourceMaterialFromUserData(attachment),
        item,
        manifestMat,
        { kind: "world", matcap: this.matcap },
        this.currentWornColors?.get(pieceId) ?? null,
      );
    }
  }

  /**
   * Weapon GLB scenes are SHARED pack objects also converted by the world
   * PawnRenderer — conversion here must be IDEMPOTENT and map-preserving, or
   * whichever renderer runs last strips the other's texture maps (the old
   * version overwrote the slugthrower with plain steel and never touched the sword).
   */
  private prepareSharedWeaponMaterials(): void {
    const convert = (root: Object3D): void => {
      root.traverse((object) => {
        if (!(object instanceof Mesh) || object.material instanceof MeshMatcapMaterial) return;
        const source = object.material instanceof Material ? object.material : null;
        const map = source && "map" in source && source.map instanceof Texture ? source.map : null;
        const converted = new MeshMatcapMaterial({ matcap: this.matcap, map });
        installPawnRim(converted);
        object.material = converted;
      });
    };
    convert(this.pack.slugthrowerScene);
    convert(this.pack.vibroswordScene);
    for (const weapon of this.pack.weapons.values()) convert(weapon.scene);
  }
}
function actorHairId(actor: RenderActor): string | null {
  if (!("appearance" in actor) || !actor.appearance) return null;
  const hair = actor.appearance.hair;
  return typeof hair === "string" && HAIR_IDENTIFIER_PATTERN.test(hair) ? hair : null;
}


function actorHairMaterialId(actor: RenderActor): string | null {
  const appearance = (actor as { readonly appearance?: { readonly hair_mat?: unknown } }).appearance;
  const hairMat = typeof appearance?.hair_mat === "string" ? appearance.hair_mat.trim() : "";
  return HAIR_MATERIAL_PATTERN.test(hairMat) ? hairMat : null;
}

function actorSkinTone(actor: RenderActor): string {
  const appearance = (actor as { readonly appearance?: { readonly skin?: unknown } }).appearance;
  const skin = typeof appearance?.skin === "string" ? appearance.skin.trim().toLowerCase() : "";
  return SKIN_TONE_PATTERN.test(skin) ? skin : BASE_SKIN_COLOR;
}

function actorFaceConfig(actor: RenderActor): PawnFaceConfig | null {
  if (!("appearance" in actor) || !actor.appearance) return null;
  return actor.appearance.face ?? null;
}

function weaponModelKeyForActor(actor: RenderActor): string | null {
  const weapon = "weapon" in actor ? actor.weapon : null;
  const itemId = weapon && "weaponItemId" in weapon ? Number(weapon.weaponItemId ?? 0) : 0;
  const weaponId = equippedWeaponIdForActor(actor);
  return weaponModelAssetKey(itemId, weaponId);
}

function actorInCombat(actor: RenderActor): boolean | undefined {
  return (actor as { readonly inCombat?: boolean }).inCombat;
}

function isActorDowned(actor: RenderActor): boolean {
  if ("lifeState" in actor && actor.lifeState !== "alive") return true;
  if (!("statuses" in actor) || !Array.isArray(actor.statuses)) return false;
  return actor.statuses.some((status) => status.id === "dead" || status.id === "incapacitated");
}
