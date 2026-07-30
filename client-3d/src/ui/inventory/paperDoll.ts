import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  SkinnedMesh,
  type WebGLRenderer,
} from "three";
import {
  ensureEquipmentUv,
  equipmentSourceMaterialFromUserData,
  getEquipmentMaterialSets,
  resolveEquipmentSlotMaterial,
  type EquipmentSlotMaterialSource,
} from "../../assets/equipmentMaterials";
import { clonePawnBody, type PawnBody, type PawnEquipmentItem, type PawnPack } from "../../assets/pawnPack";
import { authoritativeWornKey } from "../../render/equipmentSlots";
import { MaskedClipCache } from "../../render/anim/maskedClips";
import { PawnAnimator } from "../../render/anim/PawnAnimator";
import { attachPawnEquipmentSet, resolveRifleBaseLaneAvailable } from "../../render/pawns";
import { SlugthrowerRig } from "../../render/weapons/slugthrowerRig";
import { PlasmaBlade } from "../../render/weapons/plasmaBlade";
import { makeGlowSprite } from "../../render/fx/particles";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SwordRig } from "../../render/weapons/swordRig";
import type { PaperDollVM } from "./types";
import { resolveWieldPose } from "./wieldPose";
import { PaperDollCameraFraming, resolvePaperDollFramingMode } from "./previewCamera";
import { clampTurntableZoom, type TurntableTarget } from "../turntableInteraction";
import { attachPawnFaceDecal, faceSignature } from "../../render/faceDecal";
import { resolvePaperDollWeaponPresentation } from "./paperDollPresentation";

const DOLL_TURN_RADIANS_PER_SECOND = 0.22;
const GUN_GRIP_HAND_CLIP = "gun_grip_trigger_discipline";

// Matches the world renderer's defaults (render/pawns.ts) so the doll and the
// in-world pawn agree when appearance hasn't landed yet.
const DOLL_DEFAULT_SKIN = "#cc9978";
const SKIN_TONE_PATTERN = /^#[0-9a-f]{6}$/iu;
const HAIR_MATERIAL_PATTERN = /^hair_[a-z0-9_]{1,64}$/u;
// Lit skin materials cached per tone — module lifetime, same policy as the
// lit equipment material cache.
const dollSkinMaterials = new Map<string, MeshStandardMaterial>();

function dollSkinMaterialFor(skinTone: string): MeshStandardMaterial {
  let material = dollSkinMaterials.get(skinTone);
  if (!material) {
    material = new MeshStandardMaterial({ color: new Color(skinTone), roughness: 0.86, metalness: 0 });
    material.name = `inventory-doll-skin:${skinTone}`;
    dollSkinMaterials.set(skinTone, material);
  }
  return material;
}

const PLASMA_SWORD_ITEM_ID = 3104;
const PLASMA_SWORD_COLOR = 0x63f0ff;
// Hilt scene + glow sprite cached for module lifetime (same policy as the
// skin material cache); every doll rebuild clones from these.
let plasmaHiltScenePromise: Promise<Group | null> | null = null;
let dollGlowSprite: ReturnType<typeof makeGlowSprite> | null = null;

function loadPlasmaHiltScene(): Promise<Group | null> {
  plasmaHiltScenePromise ??= new GLTFLoader()
    .loadAsync(`${SUCCESSOR_3D_CONFIG.pawnPack.basePath}/plasma_hilt.glb`)
    .then((gltf) => gltf.scene, (error: unknown) => {
      console.warn("paper doll plasma hilt load failed", error);
      return null;
    });
  return plasmaHiltScenePromise;
}

export interface PaperDollThemeColors {
  accent: string;
  accentSoft: string;
}

export class PaperDollRenderer implements TurntableTarget {
  private readonly scene = new Scene();
  private readonly root = new Group();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.05, 20);
  private readonly maskedClips = new MaskedClipCache();
  private readonly themeScratch = new Color();
  private readonly keyLight = new DirectionalLight("#ffe0a5", 2.75);
  private readonly fillLight = new DirectionalLight("#8fb3ff", 0.72);
  private readonly rimLight = new DirectionalLight("#ff7148", 1.55);
  private bodyRoot: Group | null = null;
  private animator: PawnAnimator | null = null;
  private slugthrower: SlugthrowerRig | null = null;
  private sword: SwordRig | null = null;
  private plasmaBlade: PlasmaBlade | null = null;
  private plasmaHilt: Group | null = null;
  private currentWeaponItemId = 0;
  private currentBody: PawnBody | null = null;
  private currentWeaponId: string | null = null;
  private currentInCombat: boolean | undefined = undefined;
  private readonly currentEquipmentIds: string[] = [];
  private currentSkin = "";
  private currentFaceSignature = "";
  private currentHairId: string | null = null;
  private currentHairMat: string | null = null;
  private currentWornKey = "";
  private currentWornColors: ReadonlyMap<string, readonly string[]> | null = null;
  private yaw = 0;
  private zoom = 1;
  private dragging = false;
  private readonly cameraFraming = new PaperDollCameraFraming();
  private readonly rifleBaseLaneAvailable: boolean;

  constructor(private readonly pack: PawnPack) {
    this.root.name = "inventory-paper-doll-root";
    this.rifleBaseLaneAvailable = resolveRifleBaseLaneAvailable(pack);
    this.scene.add(this.root);
    this.scene.add(new AmbientLight("#d7c497", 0.52));

    this.keyLight.name = "paper-doll-key";
    this.keyLight.position.set(-3.4, 4.8, 3.6);
    this.scene.add(this.keyLight);

    this.fillLight.name = "paper-doll-fill";
    this.fillLight.position.set(3.8, 2.1, 2.4);
    this.scene.add(this.fillLight);

    this.rimLight.name = "paper-doll-rim";
    this.rimLight.position.set(0.4, 2.9, -4.2);
    this.scene.add(this.rimLight);

    this.camera.name = "inventory-paper-doll-camera";
    this.camera.position.set(0, 0.92, 4.35);
    this.camera.lookAt(0, 0.82, 0);
  }

  setTheme(colors: PaperDollThemeColors): void {
    this.keyLight.color.set("#ffe0a5").lerp(this.themeScratch.set(colors.accentSoft), 0.22);
    this.fillLight.color.set("#8fb3ff").lerp(this.themeScratch.set(colors.accentSoft), 0.18);
    this.rimLight.color.set("#ff7148").lerp(this.themeScratch.set(colors.accent), 0.62);
  }

  render(renderer: WebGLRenderer, rect: DOMRectReadOnly | null, vm: PaperDollVM, dtSeconds: number, canvasHeight: number): void {
    if (!rect || rect.width < 2 || rect.height < 2) return;
    this.ensureDoll(vm);
    if (!this.bodyRoot || !this.animator) return;

    this.updateCamera(rect.width / rect.height);
    // Auto-turn advances by dt and FREEZES while a drag holds the doll — the
    // shared turntable contract (hold = model tracks the hand exactly,
    // release = the turn resumes from where the hand left it).
    if (!this.dragging) this.yaw += dtSeconds * DOLL_TURN_RADIANS_PER_SECOND;
    this.root.rotation.y = this.yaw;
    this.animator.update(dtSeconds);
    this.bodyRoot.updateMatrixWorld(true);
    // IK policy mirror (see pawns.ts renderActor): the doll never reloads —
    // rifle_* lane runs "auto" (IK only when bore leveling displaces the
    // foregrip); the legacy lane needs the support hand posed by IK.
    this.slugthrower?.update(dtSeconds, null, this.rifleBaseLaneAvailable ? "auto" : "on");
    this.sword?.update(dtSeconds);

    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(canvasHeight - rect.y - rect.height));
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setViewport(x, y, width, height);
    renderer.setScissor(x, y, width, height);
    renderer.render(this.scene, this.camera);
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

  onDragStart(): void {
    this.dragging = true;
  }

  onDragEnd(): void {
    this.dragging = false;
  }


  /** Actual equipment meshes attached to the live inventory mannequin. */
  attachedEquipmentIds(): string[] {
    const ids: string[] = [];
    this.bodyRoot?.traverse((object) => {
      const id = object.userData.successorEquipmentItemId;
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    });
    return ids;
  }

  dispose(): void {
    this.clearDoll();
  }

  private ensureDoll(vm: PaperDollVM): void {
    const skin = normalizedDollSkin(vm);
    const hairId = this.normalizedDollHairId(vm);
    const hairMat = normalizedDollHairMat(vm);
    const wornKey = dollWornKey(vm);
    const nextFaceSignature = faceSignature(vm.appearance?.face);
    if (
      this.currentBody === vm.body
      && this.currentWeaponId === vm.weaponId
      && this.currentWeaponItemId === (vm.weaponItemId ?? 0)
      && this.currentInCombat === vm.inCombat
      && this.currentSkin === skin
      && this.currentFaceSignature === nextFaceSignature
      && this.currentHairId === hairId
      && this.currentHairMat === hairMat
      && this.currentWornKey === wornKey
      && sameEquipmentIds(this.currentEquipmentIds, vm.equipmentIds)
    ) {
      return;
    }
    this.rebuildDoll(vm, skin, nextFaceSignature, hairId, hairMat, wornKey);
  }

  private rebuildDoll(
    vm: PaperDollVM,
    skin: string,
    nextFaceSignature: string,
    hairId: string | null,
    hairMat: string | null,
    wornKey: string,
  ): void {
    this.clearDoll();
    this.currentBody = vm.body;
    this.currentWeaponId = vm.weaponId;
    this.currentWeaponItemId = vm.weaponItemId ?? 0;
    this.currentInCombat = vm.inCombat;
    this.currentSkin = skin;
    this.currentFaceSignature = nextFaceSignature;
    this.currentHairId = hairId;
    this.currentHairMat = hairMat;
    this.currentWornKey = wornKey;
    this.currentWornColors = vm.worn && vm.worn.length > 0
      ? new Map(vm.worn.map((piece) => [piece.item, piece.colors] as const))
      : null;
    this.currentEquipmentIds.length = 0;
    for (let i = 0; i < vm.equipmentIds.length; i += 1) this.currentEquipmentIds.push(vm.equipmentIds[i]!);
    const bodyRoot = clonePawnBody(this.pack, vm.body);
    bodyRoot.name = `inventory-paper-doll-body:${vm.body}`;
    bodyRoot.scale.setScalar(this.pack.scale);
    this.root.add(bodyRoot);
    this.bodyRoot = bodyRoot;

    // Skin: the cloned GLB ships neutral clay — tint SkinnedMeshes with the
    // character's wire skin tone (lit pipeline; the doll has a real light
    // rig). Mirrors the world renderer's body-material policy.
    const skinMaterial = dollSkinMaterialFor(skin);
    // Tint only meshes authored as part of the body. Equipment is attached
    // below afterward and must retain its manifest/material palette.
    bodyRoot.traverse((object) => {
      if (!(object instanceof SkinnedMesh)) return;
      if (typeof object.userData.successorEquipmentItemId === "string") return;
      object.material = skinMaterial;
    });

    // Appearance hair is independent from inventory headwear.
    const attachIds = hairId && !vm.equipmentIds.includes(hairId)
      ? [...vm.equipmentIds, hairId]
      : vm.equipmentIds;
    attachPawnEquipmentSet(
      this.pack,
      bodyRoot,
      attachIds,
      (item, source) => this.equipmentMaterial(item, source),
    );
    attachPawnFaceDecal(bodyRoot, vm.appearance?.face);
    void getEquipmentMaterialSets().then(() => {
      if (this.bodyRoot !== bodyRoot) return;
      this.refreshLitEquipmentMaterials(bodyRoot);
    });

    const animator = new PawnAnimator(bodyRoot, this.pack, this.maskedClips);
    this.animator = animator;
    const weapon = resolvePaperDollWeaponPresentation(vm.weaponId, vm.weaponItemId ?? 0);
    const rifleArmed = weapon.lane === "rifle";
    const swordArmed = weapon.lane === "melee";
    const armed = weapon.visible;
    const pose = resolveWieldPose({ armed, inCombat: vm.inCombat });
    // Held melee weapons need a wider orthographic frame; everything else
    // keeps the authored default. Applied on the next render() → updateCamera().
    this.cameraFraming.setMode(resolvePaperDollFramingMode(weapon.lane, pose.holdWeapon));
    const baseClip = pose.holdWeapon
      ? rifleArmed && this.pack.clips.has("rifle_idle")
        ? "rifle_idle"
        : swordArmed && this.pack.clips.has("melee_idle")
          ? "melee_idle"
          : "idle"
      : "idle";
    const handClip = pose.holdWeapon
      ? rifleArmed && this.pack.clips.has(GUN_GRIP_HAND_CLIP)
        ? GUN_GRIP_HAND_CLIP
        : swordArmed && this.pack.clips.has("melee_grip")
          ? "melee_grip"
          : null
      : null;
    animator.setBase(baseClip, 1);
    animator.setHand(handClip);

    if (rifleArmed) {
      const handR = animator.bone("hand_r");
      if (handR) {
        const assetKey = weapon.modelKey;
        const model = assetKey ? this.pack.weapons.get(assetKey) ?? null : null;
        this.slugthrower = new SlugthrowerRig(
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
        this.slugthrower.setVisible(true);
        this.slugthrower.setStowed(pose.stowed, { snap: true });
      }
    } else if (swordArmed) {
      const handR = animator.bone("hand_r");
      if (handR) {
        const assetKey = weapon.modelKey;
        const model = assetKey ? this.pack.weapons.get(assetKey) ?? null : null;
        const sword = new SwordRig(
          this.pack,
          handR,
          animator.bone("spine_03") ?? animator.bone("spine_02"),
          model?.spec,
          model?.scene,
          model?.scale,
          model && assetKey ? `melee:${assetKey}` : "vibrosword",
        );
        this.sword = sword;
        sword.setVisible(true);
        sword.setStowed(pose.stowed, { snap: true });
        if ((vm.weaponItemId ?? 0) === PLASMA_SWORD_ITEM_ID) {
          // Plasma presentation (world-pawn mirror, pawns.ts ensurePlasma):
          // hide the vibro frame, pure-FX blade + hilt clone in the same
          // weapon frame. Blade lights only when wielded — stowed = retracted.
          sword.setFrameVisible(false);
          dollGlowSprite ??= makeGlowSprite();
          const blade = new PlasmaBlade(sword.frameRoot(), dollGlowSprite, PLASMA_SWORD_COLOR);
          blade.setExtension(pose.stowed ? 0 : 1);
          this.plasmaBlade = blade;
          void loadPlasmaHiltScene().then((scene) => {
            if (!scene || this.plasmaBlade !== blade) return;
            const hilt = scene.clone(true);
            sword.frameRoot().add(hilt);
            this.plasmaHilt = hilt;
          });
        }
      }
    }
  }

  private normalizedDollHairId(vm: PaperDollVM): string | null {
    const hair = vm.appearance?.hair ?? null;
    if (!hair) return null;
    return this.pack.equipment.items.some((item) => item.id === hair) ? hair : null;
  }

  private clearDoll(): void {
    this.plasmaBlade?.dispose();
    this.plasmaBlade = null;
    if (this.plasmaHilt) {
      this.plasmaHilt.parent?.remove(this.plasmaHilt);
      this.plasmaHilt = null;
    }
    this.slugthrower?.dispose();
    this.slugthrower = null;
    this.sword?.dispose();
    this.sword = null;
    this.animator?.dispose();
    this.animator = null;
    if (this.bodyRoot) {
      this.root.remove(this.bodyRoot);
      this.bodyRoot = null;
    }
  }

  private updateCamera(aspect: number): void {
    if (!this.cameraFraming.writeBounds(aspect, this.camera)) return;
    this.camera.updateProjectionMatrix();
  }

  private equipmentMaterial(item: PawnEquipmentItem, source: EquipmentSlotMaterialSource): Material | Material[] {
    // Appearance hair colors by the character's hair PRESET, not the item id
    // (hair_afro2 + hair_crimson etc.) — same override the world applies.
    const manifestMat = item.id === this.currentHairId && this.currentHairMat ? this.currentHairMat : item.mat;
    return resolveEquipmentSlotMaterial(source, item, manifestMat, { kind: "lit" }, this.currentWornColors?.get(item.id) ?? null);
  }

  private refreshLitEquipmentMaterials(root: Group): void {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const pieceId = typeof object.userData.successorEquipmentItemId === "string"
        ? object.userData.successorEquipmentItemId
        : null;
      if (!pieceId) return;
      const item = this.pack.equipment.items.find((candidate) => candidate.id === pieceId);
      if (!item) return;
      const layer = object.userData.successorEquipmentLayer === "Under" ? "Under" : "Armor";
      ensureEquipmentUv(object, layer);
      const manifestMat = pieceId === this.currentHairId && this.currentHairMat ? this.currentHairMat : item.mat;
      object.material = resolveEquipmentSlotMaterial(
        equipmentSourceMaterialFromUserData(object),
        item,
        manifestMat,
        { kind: "lit" },
        this.currentWornColors?.get(pieceId) ?? null,
      );
    });
  }
}

function normalizedDollSkin(vm: PaperDollVM): string {
  const skin = typeof vm.appearance?.skin === "string" ? vm.appearance.skin.trim().toLowerCase() : "";
  return SKIN_TONE_PATTERN.test(skin) ? skin : DOLL_DEFAULT_SKIN;
}

function normalizedDollHairMat(vm: PaperDollVM): string | null {
  const hairMat = typeof vm.appearance?.hair_mat === "string" ? vm.appearance.hair_mat.trim() : "";
  return HAIR_MATERIAL_PATTERN.test(hairMat) ? hairMat : null;
}

function dollWornKey(vm: PaperDollVM): string {
  return authoritativeWornKey(vm.worn);
}

function sameEquipmentIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
